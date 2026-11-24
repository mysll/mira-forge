"""导出把「场景底图 + 每一层选定的那张图」打成 zip。

每一层默认取最新的那张；用户在层页签里点过「使用这张」之后，`layers.selected_image_id`
就是导出用的那张。导出的 zip 带一份 manifest.json，写清楚每层的系数 / z / 文件名，
Godot 那边照着摆 Parallax2D 就行。
"""

from __future__ import annotations

import json
import re
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.generation import Generation
from app.models.image import Image
from app.models.layer import Layer, LayerSet
from app.services import image_service
from app.services.layer_slots import SLOT_ORDER, slot_label

# 导出的 manifest 里写一份 Godot 参考参数（跟文档里的默认值一致）
VIEWPORT_WIDTH = 1600
VIEWPORT_HEIGHT = 900
CAMERA_ZOOM = 0.95
CAMERA_TRAVEL_PX = 118
CLEAR_COLOR = "#07050C"


class ExportError(Exception):
    """打包失败（没有源图、没有可导出的层等）。"""


def _slug(text: str | None, fallback: str) -> str:
    cleaned = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "-", (text or "").strip()).strip("-")
    return cleaned[:32] or fallback


def _layer_stem(layer: Layer, used: set[str]) -> str:
    """导出文件名按槽位：gameplay.png / far_00.png / near_01.png …

    Godot 那边五个 Parallax2D 直接对着文件名建，不用再查表。
    """
    stem = "gameplay" if layer.slot == "gameplay" else f"{layer.slot}_{layer.depth:02d}"
    if stem in used:
        stem = f"{stem}_{_slug(layer.key, 'layer')}"
    used.add(stem)
    return stem


def layer_candidates(db: Session, layer: Layer) -> list[Image]:
    """这一层出过的所有图，最新的在前（按图片 id 倒序，同一批里后出的在后）。"""
    rows = db.scalars(
        select(Image)
        .join(Generation, Image.generation_id == Generation.id)
        .where(
            Generation.layer_id == layer.id,
            Image.deleted_at.is_(None),
            Image.media_type == "scene_layer",
        )
        .order_by(Image.id.desc())
    ).all()
    return list(rows)


def resolve_layer_image(db: Session, layer: Layer) -> tuple[Image | None, str]:
    """返回（要导出的图, 来源）。来源是 manual / latest / missing。"""
    candidates = layer_candidates(db, layer)
    if not candidates:
        return None, "missing"
    if layer.selected_image_id is not None:
        for image in candidates:
            if image.id == layer.selected_image_id:
                return image, "manual"
    return candidates[0], "latest"


def _write_member(archive: zipfile.ZipFile, name: str, image: Image, storage_root: Path | None) -> None:
    path = image_service.absolute_path(image, storage_root)
    if not path.is_file():
        return
    archive.write(path, arcname=name)


def build_export_zip(
    db: Session,
    layer_set: LayerSet,
    source: Image,
    scene_name: str | None = None,
    storage_root: Path | None = None,
) -> tuple[Path, str, dict]:
    """把源图 + 每层的选定图打成一个临时 zip，返回（路径, 下载文件名, manifest）。"""
    suffix = Path(source.file_path).suffix or ".png"
    source_name = f"source/scene-{source.id}{suffix}"

    entries: list[dict] = []
    used_names: set[str] = set()
    temp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
    temp.close()
    target = Path(temp.name)

    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        _write_member(archive, source_name, source, storage_root)
        for layer in [item for item in layer_set.layers if item.deleted_at is None]:
            image, origin = resolve_layer_image(db, layer)
            item = {
                "ord": layer.ord,
                "key": layer.key,
                "name": layer.name,
                "role": layer.role,
                # 引擎按槽位建 Parallax2D，槽位比层名重要
                "slot": layer.slot,
                "slot_label": slot_label(layer.slot),
                "depth": layer.depth,
                "scroll_scale": layer.scroll_scale,
                "z_index": layer.z_index,
                "file": None,
                "image_id": None,
                "generation_id": None,
                "width": None,
                "height": None,
                "picked": origin,
            }
            if image is not None:
                ext = Path(image.file_path).suffix or ".png"
                stem = _layer_stem(layer, used_names)
                name = f"layers/{stem}{ext}"
                _write_member(archive, name, image, storage_root)
                item.update(
                    file=name,
                    image_id=image.id,
                    generation_id=image.generation_id,
                    width=image.width,
                    height=image.height,
                )
            entries.append(item)

        parallax = []
        for slot in SLOT_ORDER:
            files = [entry for entry in entries if entry["slot"] == slot]
            if not files:
                continue
            parallax.append(
                {
                    "slot": slot,
                    "label": slot_label(slot),
                    "scroll_scale": files[0]["scroll_scale"],
                    "z_index": files[0]["z_index"],
                    "files": [entry["file"] for entry in files if entry["file"]],
                }
            )

        manifest = {
            "scene": {
                "id": layer_set.scene_id,
                "name": scene_name,
            },
            "source": {
                "file": source_name,
                "image_id": source.id,
                "width": source.width,
                "height": source.height,
            },
            "layer_set": {
                "id": layer_set.id,
                "model": layer_set.model_name,
                "layer_count": len([item for item in layer_set.layers if item.deleted_at is None]),
            },
            "layers": entries,
            "parallax": parallax,
            "godot": {
                "viewport": [VIEWPORT_WIDTH, VIEWPORT_HEIGHT],
                "camera_zoom": CAMERA_ZOOM,
                "camera_travel_px": CAMERA_TRAVEL_PX,
                "clear_color": CLEAR_COLOR,
                "note": (
                    "按 parallax 里的每一项建一个 Parallax2D（scroll_scale = (scroll_scale, 0)、"
                    "repeat_size = Vector2.ZERO），files 里每张图放一个 Sprite2D（centered = false，"
                    "初始 position = (0,0)），z_index 用 manifest 里的值。"
                    "文件按槽位命名：far_00 / mid_00 / near_00 / gameplay / foreground_00。"
                ),
            },
            "exported_at": datetime.now(timezone.utc).isoformat(),
        }
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

        missing = [entry["name"] for entry in entries if entry["file"] is None]
        readme = [
            "场景分层导出 / MiraForge",
            "",
            f"场景：{manifest['scene']['name'] or manifest['scene']['id']}",
            f"源图：{source_name}（{source.width}×{source.height}）",
            f"层数：{len(entries)}",
            "",
            "每一层一个文件，文件名就是引擎槽位：far_00 / mid_00 / near_00 / gameplay / foreground_00。",
            "导出用的图来自 manifest.json 的 layers[].picked：",
            "  manual = 你在层页签里手动指定的那张；latest = 这一层最新的那张。",
            "manifest.json 的 parallax 段已经按槽位归好组，照着建 Parallax2D 就行。",
        ]
        if missing:
            readme += ["", "还没有出图的层：" + "、".join(missing)]
        archive.writestr("README.txt", "\n".join(readme))

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    label = _slug(scene_name, f"scene-{layer_set.scene_id}")
    return target, f"{label}-layers-{stamp}.zip", manifest
