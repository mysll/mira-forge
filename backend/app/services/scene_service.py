"""场景（Scene）的读写。

场景是隔离容器：名字在未删除的场景里唯一；新建时就把
`storage/scenes/<id>/images/` 建出来，产物按场景分目录存放。
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.generation import Generation
from app.models.image import Image
from app.models.scene import Scene
from app.models.workflow import utcnow
from app.services.image_service import storage_root_for
from app.services.recycle_service import soft_delete_generation


class SceneValidationError(RuntimeError):
    """场景参数不合法（名字为空、重名…）。"""


def _clean_name(raw: str | None) -> str:
    name = (raw or "").strip()
    if not name:
        raise SceneValidationError("场景名不能为空")
    if len(name) > 60:
        raise SceneValidationError("场景名最多 60 个字符")
    return name


def scene_dir(scene_id: int, storage_root: Path | None = None) -> Path:
    """场景在磁盘上的根目录：`<storage>/scenes/<id>`。"""
    return storage_root_for(storage_root) / "scenes" / str(scene_id)


def create_scene(
    db: Session, *, name: str | None, description: str | None = None
) -> Scene:
    cleaned = _clean_name(name)
    duplicated = db.scalar(
        select(Scene).where(Scene.name == cleaned, Scene.deleted_at.is_(None))
    )
    if duplicated is not None:
        raise SceneValidationError(f"已经有叫「{cleaned}」的场景了")

    scene = Scene(
        name=cleaned,
        description=(description or "").strip() or None,
        sort_order=0,
    )
    db.add(scene)
    db.commit()
    db.refresh(scene)

    # 先建空目录：产物、导出包都按场景分开，排查问题时一眼能找到
    try:
        (scene_dir(scene.id) / "images").mkdir(parents=True, exist_ok=True)
    except OSError:
        pass  # 建不出来不影响建场景，真正落盘时会再试一次
    return scene


def get_scene(db: Session, scene_id: int) -> Scene | None:
    scene = db.get(Scene, scene_id)
    if scene is None or scene.deleted_at is not None:
        return None
    return scene


def scene_stats(db: Session, scene_id: int) -> tuple[int, int]:
    """(场景图数, 场景批次数)，都只算未删除的，且不含分层产物。

    分层图（media_type=scene_layer / generation_type=scene_layer）属于某一层，
    只在分层工作台里出现，不算进场景自己的「几批几图」。
    """
    images = db.scalar(
        select(func.count())
        .select_from(Image)
        .where(
            Image.scene_id == scene_id,
            Image.deleted_at.is_(None),
            Image.media_type != "scene_layer",
        )
    )
    generations = db.scalar(
        select(func.count())
        .select_from(Generation)
        .where(
            Generation.scene_id == scene_id,
            Generation.deleted_at.is_(None),
            Generation.generation_type != "scene_layer",
        )
    )
    return int(images or 0), int(generations or 0)


def list_scenes(db: Session) -> list[tuple[Scene, int, int]]:
    """所有未删除的场景 + (图片数, 批次数)；场景通常不多，一次算完。"""
    scenes = list(
        db.scalars(
            select(Scene)
            .where(Scene.deleted_at.is_(None))
            .order_by(Scene.sort_order, Scene.id)
        ).all()
    )
    if not scenes:
        return []

    ids = [scene.id for scene in scenes]
    image_counts = dict(
        db.execute(
            select(Image.scene_id, func.count())
            .where(
                Image.scene_id.in_(ids),
                Image.deleted_at.is_(None),
                Image.media_type != "scene_layer",
            )
            .group_by(Image.scene_id)
        ).all()
    )
    generation_counts = dict(
        db.execute(
            select(Generation.scene_id, func.count())
            .where(
                Generation.scene_id.in_(ids),
                Generation.deleted_at.is_(None),
                Generation.generation_type != "scene_layer",
            )
            .group_by(Generation.scene_id)
        ).all()
    )
    return [
        (
            scene,
            int(image_counts.get(scene.id, 0)),
            int(generation_counts.get(scene.id, 0)),
        )
        for scene in scenes
    ]


def scene_covers(db: Session, scenes: list["Scene"]) -> dict[int, tuple[int, datetime | None]]:
    """每个场景该拿哪张图当封面，以及它的创建时间（前端当 URL 版本号用）。

    `Scene.cover_image_id` 只有在「图确实属于这个场景、没被删、也不是分层产物」时才算数：
    SQLite 会复用被删行的 id，早先存下的 cover_image_id 可能已经指向别的场景的图了。
    显式封面不可用时退回这个场景里最新的一张；一张都没有就不给 id，前端显示占位图。
    """
    if not scenes:
        return {}

    rows = db.execute(
        select(Image.scene_id, Image.id, Image.created_at)
        .where(
            Image.scene_id.in_([scene.id for scene in scenes]),
            Image.deleted_at.is_(None),
            Image.media_type.not_in(("video", "scene_layer")),
        )
        .order_by(Image.id)
    ).all()

    owned: dict[int, set[int]] = {}
    created: dict[int, datetime | None] = {}
    latest: dict[int, int] = {}
    for scene_id, image_id, image_created in rows:
        owned.setdefault(int(scene_id), set()).add(int(image_id))
        created[int(image_id)] = image_created
        latest[int(scene_id)] = int(image_id)

    covers: dict[int, tuple[int, datetime | None]] = {}
    for scene in scenes:
        candidates = owned.get(scene.id)
        if not candidates:
            continue
        chosen = (
            int(scene.cover_image_id)
            if scene.cover_image_id is not None and scene.cover_image_id in candidates
            else latest[scene.id]
        )
        covers[scene.id] = (chosen, created.get(chosen))
    return covers


def update_scene(
    db: Session,
    scene: Scene,
    *,
    name: str | None = None,
    description: str | None = None,
    cover_image_id: int | None = None,
    fields: set[str] | None = None,
) -> Scene:
    """按 PATCH 语义改字段：只有出现在 fields 里的才动。"""
    changed = fields or set()
    if "name" in changed and name is not None:
        cleaned = _clean_name(name)
        duplicated = db.scalar(
            select(Scene).where(
                Scene.name == cleaned,
                Scene.deleted_at.is_(None),
                Scene.id != scene.id,
            )
        )
        if duplicated is not None:
            raise SceneValidationError(f"已经有叫「{cleaned}」的场景了")
        scene.name = cleaned
    if "description" in changed:
        scene.description = (description or "").strip() or None
    if "cover_image_id" in changed:
        scene.cover_image_id = cover_image_id
    db.commit()
    db.refresh(scene)
    return scene


def delete_scene(db: Session, scene: Scene) -> tuple[int, int]:
    """软删场景：里面的批次与产物一起进回收站（30 天内可恢复）。"""
    generations = list(
        db.scalars(
            select(Generation).where(
                Generation.scene_id == scene.id, Generation.deleted_at.is_(None)
            )
        ).all()
    )
    images = 0
    for generation in generations:
        images += soft_delete_generation(db, generation)

    scene.deleted_at = utcnow()
    db.commit()
    return len(generations), images
