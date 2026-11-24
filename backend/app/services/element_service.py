"""元素提取：LLM 只点名，出图交给图片编辑。

一次提取 = 一条 `element_sets`（会话）+ 若干 `elements`（候选件）。
每个候选件不存坐标，只存名字、类别、提示词；点「提取」时才真正排一次
`image_edit`（参考图 = 场景底图），产物是真 alpha 的透明小图。
翻车的框、裁出来的带背景方片，都不会再出现。
"""

from __future__ import annotations

import io
import json
import logging
import traceback
import uuid
from datetime import datetime
from pathlib import Path

from PIL import Image as PILImage
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core import projects
from app.models.database import session_for
from app.models.element import Element, ElementSet, ElementSetStatus, ElementStatus
from app.models.generation import Generation, GenerationStatus, GenerationType
from app.models.image import Image
from app.models.kit import Kit, KitItem
from app.schemas.generation import GenerationCreate
from app.schemas.layer import LLMExchangeEntry
from app.services import element_prompt_service, generation_service, image_service, llm_client
from app.services.layer_service import UNIVERSAL_NEGATIVE, merge_negative

_log = logging.getLogger(__name__)

KINDS = ("terrain", "structure", "prop", "decor")
MAX_ELEMENTS = 16

# 出图时统一追加的输出兜底。注意：这里**不写任何画风词**——画风由 LLM 看图后
# 写进每件自己的 prompt，写死「暗黑奇幻/低饱和冷色」会让别的风格（地表、水下）跑偏。
OUTPUT_RULES = (
    "【输出要求】画面里只有这一件，居中、完整、不裁切、不缺边；"
    "背景真透明 alpha=0，透明区的 RGB 用 #000000，不要棋盘格、白底、黑底、渐变或光晕；"
    "不要画任何光晕、光斑、光雾或弥散光；物件自身发光时只画发光体本身，不渲染周围的光照范围；"
    "边缘干净、无背景残留、无杂色；作为一件独立的游戏素材输出，方便后续排版与合成。"
)

# 每件 prompt 必须具备的四项控制（缺了就让 LLM 重写一次）
REQUIRED_MARKS = (
    ("完整性重建", ("完整", "补全", "重建")),
    ("风格一致性", ("风格", "画法", "画风")),
    ("独立物件", ("独立", "单独", "只出现", "只画")),
    ("透明背景", ("透明", "alpha")),
)


class ElementError(ValueError):
    """元素相关的可展示错误。"""


# ---------------- 读取 ----------------


def list_sets(db: Session, scene_id: int, limit: int = 20) -> list[ElementSet]:
    return list(
        db.scalars(
            select(ElementSet)
            .where(ElementSet.scene_id == scene_id, ElementSet.deleted_at.is_(None))
            .order_by(ElementSet.id.desc())
            .limit(limit)
        )
    )


def get_set(db: Session, set_id: int) -> ElementSet:
    element_set = db.get(ElementSet, set_id)
    if element_set is None or element_set.deleted_at is not None:
        raise ElementError(f"提取记录 {set_id} 不存在")
    return element_set


def create_set(db: Session, scene_id: int, *, source_image_id: int, brief: str | None) -> ElementSet:
    from app.models.scene import Scene

    scene = db.get(Scene, scene_id)
    if scene is None or scene.deleted_at is not None:
        raise ElementError(f"场景 {scene_id} 不存在")
    image = db.get(Image, source_image_id)
    if image is None or image.deleted_at is not None:
        raise ElementError("这张图不在了")
    if image.scene_id != scene_id:
        raise ElementError("这张图不属于这个场景")
    element_set = ElementSet(
        scene_id=scene_id,
        source_image_id=source_image_id,
        status=ElementSetStatus.ANALYZING.value,
        brief=(brief or "").strip()[:4000] or None,
    )
    db.add(element_set)
    db.commit()
    db.refresh(element_set)
    return element_set


def delete_set(db: Session, element_set: ElementSet) -> None:
    # 图集里引用过这些元素的条目跟着删掉，避免图集里留着空位
    element_ids = [element.id for element in element_set.elements]
    if element_ids:
        for item in db.scalars(select(KitItem).where(KitItem.element_id.in_(element_ids))):
            db.delete(item)
    element_set.deleted_at = datetime.utcnow()
    db.commit()


def update_element(
    db: Session,
    element: Element,
    *,
    name: str | None = None,
    key: str | None = None,
    anchor: str | None = None,
    note: str | None = None,
    prompt: str | None = None,
    selected_image_id: int | None = None,
) -> Element:
    if name is not None and name.strip():
        element.name = name.strip()[:60]
    if key is not None:
        cleaned = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in key.strip().lower())
        if cleaned:
            element.key = cleaned[:60]
    if anchor in ("top", "bottom"):
        element.anchor = anchor
    if note is not None:
        element.note = note.strip()[:200] or None
    if prompt is not None and prompt.strip():
        element.prompt = prompt.strip()[:4000]
    if selected_image_id is not None:
        image = db.get(Image, selected_image_id)
        if image is None or image.deleted_at is not None:
            raise ElementError("这张图已经不在了，刷新一下再选")
        generation = db.get(Generation, image.generation_id) if image.generation_id else None
        if generation is None or generation.element_id != element.id:
            raise ElementError("这张图不是这一件出的，不能指定")
        element.selected_image_id = image.id
    db.commit()
    db.refresh(element)
    return element


def element_image(db: Session, element: Element) -> Image | None:
    """这一件在图集里该用哪张图：用户指定过就用指定的，否则用最近一次出图的那张。"""
    if element.selected_image_id is not None:
        picked = db.get(Image, element.selected_image_id)
        if picked is not None and picked.deleted_at is None and picked.media_type == "element":
            return picked
    if element.generation_id is None:
        return None
    return db.scalar(
        select(Image)
        .where(
            Image.generation_id == element.generation_id,
            Image.deleted_at.is_(None),
            Image.media_type == "element",
        )
        .order_by(Image.id.desc())
        .limit(1)
    )


def element_images(db: Session, element: Element, limit: int = 60) -> list[Image]:
    """这一件出过的所有图，新的在前（页面按这个顺序铺格子）。"""
    return list(
        db.scalars(
            select(Image)
            .join(Generation, Generation.id == Image.generation_id)
            .where(
                Generation.element_id == element.id,
                Generation.deleted_at.is_(None),
                Image.deleted_at.is_(None),
                Image.media_type == "element",
            )
            .order_by(Image.id.desc())
            .limit(limit)
        )
    )


def element_kit_ids(db: Session, element_ids: list[int]) -> dict[int, list[int]]:
    """一次查出这些元素各自被放进了哪些图集（排除已软删的图集）。"""
    if not element_ids:
        return {}
    rows = db.execute(
        select(KitItem.element_id, KitItem.kit_id)
        .join(Kit, Kit.id == KitItem.kit_id)
        .where(KitItem.element_id.in_(element_ids), Kit.deleted_at.is_(None))
        .order_by(KitItem.kit_id)
    ).all()
    mapping: dict[int, list[int]] = {}
    for element_id, kit_id in rows:
        if element_id is None:
            continue
        mapping.setdefault(int(element_id), []).append(int(kit_id))
    return mapping


def kit_count(db: Session, element: Element) -> int:
    """这件元素被加进了几个图集。"""
    return int(
        db.scalar(
            select(func.count())
            .select_from(KitItem)
            .join(Kit, Kit.id == KitItem.kit_id)
            .where(KitItem.element_id == element.id, Kit.deleted_at.is_(None))
        )
        or 0
    )


def element_generations(db: Session, element: Element, limit: int = 20) -> list[Generation]:
    return list(
        db.scalars(
            select(Generation)
            .where(Generation.element_id == element.id, Generation.deleted_at.is_(None))
            .order_by(Generation.id.desc())
            .limit(limit)
        )
    )


def sync_element_status(db: Session, element: Element) -> None:
    """把元素状态跟它最近一次出图任务对齐（页面上要显示排队中 / 出图中 / 有图 / 失败）。"""
    if element.generation_id is None:
        if element.status != ElementStatus.DRAFT.value:
            element.status = ElementStatus.DRAFT.value
            db.commit()
        return
    if element.selected_image_id is not None:
        picked = db.get(Image, element.selected_image_id)
        if picked is None or picked.deleted_at is not None:
            # 指定的那张被删了，退回「用最新一张」，免得图集一直拿不到图
            element.selected_image_id = None
            db.commit()
    generation = db.get(Generation, element.generation_id)
    if generation is None or generation.deleted_at is not None:
        element.status = ElementStatus.DRAFT.value
        db.commit()
        return
    if generation.status == GenerationStatus.COMPLETED:
        element.status = ElementStatus.READY.value
    elif generation.status == GenerationStatus.FAILED:
        element.status = ElementStatus.FAILED.value
    elif generation.status in (GenerationStatus.PENDING, GenerationStatus.QUEUED):
        element.status = ElementStatus.QUEUED.value
    elif generation.status == GenerationStatus.RUNNING:
        element.status = ElementStatus.RUNNING.value
    elif generation.status == GenerationStatus.CANCELLED:
        # 取消掉的批次不会再有图了，别让元素一直卡在「排队中」
        element.status = ElementStatus.DRAFT.value
    db.commit()


# ---------------- 出图 ----------------


def extract_elements(
    db: Session,
    element_set: ElementSet,
    *,
    element_ids: list[int],
    count: int = 1,
    model: str,
    prompt_suffix: str | None = None,
    negative_prompt: str | None = None,
    seed: int | None = None,
    steps: int | None = None,
    cfg: float | None = None,
    sampler: str | None = None,
) -> list[Generation]:
    """给选中的元素逐件排一次 image_edit（参考图 = 场景底图）。"""
    if not element_ids:
        raise ElementError("先勾选要提取的元素")
    source = db.get(Image, element_set.source_image_id) if element_set.source_image_id else None
    if source is None or source.deleted_at is not None:
        raise ElementError("这张场景图不在了，重新选一张")

    wanted = set(element_ids)
    made: list[Generation] = []
    for element in element_set.elements:
        if element.id not in wanted:
            continue
        text = (element.prompt or _build_prompt(element.name, element.kind, element.note)).strip()
        if prompt_suffix:
            text = f"{text}\n\n{prompt_suffix.strip()}"
        if element.mask_path:
            text = f"{text}\n\n参考图已经按遮罩裁到只剩这一件附近，只提取画面里的这一件。"
        prompt = f"{text}\n\n{OUTPUT_RULES}"
        payload = GenerationCreate(
            prompt=prompt[:8000],
            model=model,
            generation_type=GenerationType.ELEMENT,
            width=source.width,
            height=source.height,
            count=max(1, min(4, count)),
            element_id=element.id,
            negative_prompt=merge_negative(negative_prompt, UNIVERSAL_NEGATIVE) or None,
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler=sampler,
        )
        reference_path = masked_reference(source, element)
        generation = generation_service.create_generation(
            db,
            payload,
            reference_image_paths=[reference_path],
        )
        element.generation_id = generation.id
        element.status = ElementStatus.QUEUED.value
        db.commit()
        made.append(generation)
    if not made:
        raise ElementError("这些元素都不在这条提取记录里")
    return made


# ---------------- LLM 分析（只点名，不要坐标） ----------------


def _set_dir(element: Element, storage_root: Path | None = None) -> Path:
    scene_id = element.element_set.scene_id if element.element_set is not None else 0
    base = Path(storage_root) if storage_root else image_service.storage_root_for(None)
    return base / "scenes" / str(scene_id) / "elements" / str(element.set_id)


def mask_absolute_path(element: Element, storage_root: Path | None = None) -> Path | None:
    if not element.mask_path:
        return None
    return Path(storage_root or image_service.storage_root_for(None)) / element.mask_path


def save_mask(
    db: Session,
    element: Element,
    content: bytes,
    *,
    storage_root: Path | None = None,
) -> Element:
    """存下手画的遮罩（灰度 PNG，白色 = 要提取的这件）。"""
    if not content:
        raise ElementError("遮罩是空的，画一下再保存")
    directory = _set_dir(element, storage_root) / "masks"
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{element.id}.png"
    target.write_bytes(content)
    base = Path(storage_root) if storage_root else image_service.storage_root_for(None)
    element.mask_path = str(target.relative_to(base)).replace("\\", "/")
    db.commit()
    db.refresh(element)
    return element


def clear_mask(db: Session, element: Element, *, storage_root: Path | None = None) -> Element:
    path = mask_absolute_path(element, storage_root)
    if path is not None and path.is_file():
        path.unlink(missing_ok=True)
    element.mask_path = None
    db.commit()
    db.refresh(element)
    return element


def masked_reference(
    source: Image,
    element: Element,
    *,
    storage_root: Path | None = None,
) -> str:
    """有遮罩时：把源图按遮罩的包围盒裁一块（四周留 10%），当这次的参考图。

    模型看到的是「只框住这一件」的画面，比整张场景图准确得多。
    """
    mask_path = mask_absolute_path(element, storage_root)
    if mask_path is None or not mask_path.is_file():
        return source.file_path
    base = Path(storage_root) if storage_root else image_service.storage_root_for(None)
    try:
        source_path = base / source.file_path
        with PILImage.open(source_path) as src, PILImage.open(mask_path) as mask:
            mask = mask.convert("L")
            if mask.size != src.size:
                mask = mask.resize(src.size, PILImage.LANCZOS)
            box = mask.point(lambda value: 255 if value > 32 else 0).getbbox()
            if box is None:
                return source.file_path
            left, top, right, bottom = box
            pad_x = max(8, int((right - left) * 0.1))
            pad_y = max(8, int((bottom - top) * 0.1))
            left = max(0, left - pad_x)
            top = max(0, top - pad_y)
            right = min(src.width, right + pad_x)
            bottom = min(src.height, bottom + pad_y)
            crop = src.convert("RGB").crop((left, top, right, bottom))
            directory = _set_dir(element, storage_root) / "refs"
            directory.mkdir(parents=True, exist_ok=True)
            target = directory / f"{element.id}.png"
            crop.save(target, format="PNG")
    except Exception as error:  # noqa: BLE001 - 裁失败就退回整图，不要卡住出图
        _log.warning("masked_reference failed for element %s: %s", element.id, error)
        return source.file_path
    return str(target.relative_to(base)).replace("\\", "/")


def _user_prompt(element_set: ElementSet, source: Image | None) -> str:
    lines = [
        f"场景图尺寸：{source.width}×{source.height}" if source else "场景图尺寸：未知",
        "请从这张 2D 横版场景图里挑出「可以拆下来重复使用」的物件。",
        "只要名字、类别、一句话描述和大致方位（左/中/右 + 上/下），不要给任何坐标。",
    ]
    if element_set.brief:
        lines.append(f"用户的额外要求：{element_set.brief}")
    return "\n".join(lines)


def _build_prompt(name: str, kind: str, description: str | None, where: str | None = None) -> str:
    """LLM 没给 prompt 时的兜底（同样遵守四项控制，且不写死画风）。"""
    detail = (description or "").strip()
    kind_hint = {
        "terrain": "一段可以反复拼接的地形片（只画一段，不要画成整条地面）",
        "structure": "一段建筑结构件（柱子、拱门、台阶这类）",
        "prop": "一件可摆放的道具",
        "decor": "一件装饰物（垂根、菌菇、碎石这类）",
    }.get(kind, "一件可摆放的物件")
    where_hint = f"（它原来在参考图里的位置大致是：{where.strip()}）" if where else ""
    lines = [
        f"【提取对象】从参考图像中提取{where_hint}这一件「{name}」，{kind_hint}。这是提取，不是重画。",
        f"【完整结构】{detail or '按参考图里这一件本来的结构与部件关系'}，从上到下画全，轮廓闭合。",
        "【完整性重建】如果某部分被黑暗、阴影、墙体或其它物件遮挡、或被画面边缘截断，"
        "请根据可见部分与物件自身的结构逻辑推断并重建，补全后与可见部分连贯一致，"
        "不得断裂、错位、变形或凭空多出结构。",
        "【风格一致】画法与参考图保持同一套：同样的笔触、线宽、明暗对比、饱和度与光照色温，"
        "细节密度相当，不改变美术风格。",
        "【独立物件】画面里只出现这一件，居中、完整、不裁切；不要带入地面、墙壁、背景光影或其它物件。",
    ]
    return "\n".join(lines)


def _slug(value: str, fallback: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in (value or "").strip().lower())
    cleaned = "_".join(part for part in cleaned.split("_") if part)
    return (cleaned or fallback)[:40]


def _missing_marks(prompt: str) -> list[str]:
    text = prompt.lower()
    missing: list[str] = []
    for label, keywords in REQUIRED_MARKS:
        if not any(keyword.lower() in text for keyword in keywords):
            missing.append(label)
    return missing


def _validate(data: dict) -> list[dict]:
    raw = data.get("elements")
    if not isinstance(raw, list) or not raw:
        raise ElementError("模型没有给出任何元素")
    items: list[dict] = []
    seen: set[str] = set()
    for index, entry in enumerate(raw[:MAX_ELEMENTS]):
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()[:60]
        if not name:
            continue
        kind = str(entry.get("kind") or "prop").strip().lower()
        if kind not in KINDS:
            kind = "prop"
        description = str(entry.get("description") or entry.get("note") or "").strip()[:300]
        where = str(entry.get("where") or entry.get("position") or "").strip()[:120]
        key = _slug(str(entry.get("key") or name), f"item_{index + 1}")
        while key in seen:
            key = f"{key}_2"
        seen.add(key)
        prompt = str(entry.get("prompt") or "").strip()
        missing = _missing_marks(prompt) if prompt else [label for label, _ in REQUIRED_MARKS]
        if missing:
            raise ElementError(
                f"「{name}」的 prompt 缺了这几项控制：{'、'.join(missing)}；"
                "每条 prompt 都要写全【提取对象】【完整结构】【完整性重建】【风格一致】【独立物件】【透明背景】"
            )
        items.append(
            {
                "name": name,
                "kind": kind,
                "key": key,
                "note": description or None,
                "prompt": prompt[:4000],
                "anchor": "top" if kind == "terrain" else "bottom",
            }
        )
    if not items:
        raise ElementError("模型给出的元素都缺名字")
    return items


def run_analysis(project_id: str, set_id: int) -> None:
    project = projects.get_project(project_id)
    if project is None:
        return
    db = session_for(project)
    try:
        element_set = db.get(ElementSet, set_id)
        if element_set is None or element_set.deleted_at is not None:
            return
        source = db.get(Image, element_set.source_image_id) if element_set.source_image_id else None
        if source is None:
            raise ElementError("这张场景图不在了")

        exchange: list[dict] = []
        meta: dict = {"attempts": 0, "session": uuid.uuid4().hex}
        system = element_prompt_service.load()
        user = _user_prompt(element_set, source)
        feedback = ""
        last_error = ""

        for attempt in (1, 2):
            meta["attempts"] = attempt
            started = datetime.utcnow()
            try:
                image_uri = llm_client.image_data_uri(
                    Path(project.storage_path) / source.file_path
                )
                text, payload = llm_client.chat_json(
                    system=system,
                    user=user if not feedback else f"{user}\n\n上一次的问题：{feedback}",
                    image=image_uri,
                    session=meta["session"],
                )
                meta["usage"] = payload.get("usage")
                data = llm_client.extract_json(text)
                items = _validate(data)
                meta["style"] = str(data.get("style") or "")[:500]
                meta["scene_type"] = str(data.get("scene_type") or "")[:40]
                exchange.append(
                    {
                        "attempt": attempt,
                        "system": system,
                        "user": user if not feedback else f"{user}\n\n上一次的问题：{feedback}",
                        "has_image": True,
                        "response": text[:20000],
                        "error": None,
                        "duration_ms": int((datetime.utcnow() - started).total_seconds() * 1000),
                    }
                )
                meta["exchange"] = exchange
                meta["system_prompt_chars"] = len(system)

                for order, item in enumerate(items):
                    db.add(
                        Element(
                            set_id=element_set.id,
                            kind=item["kind"],
                            name=item["name"],
                            key=item["key"],
                            prompt=item["prompt"],
                            anchor=item["anchor"],
                            note=item["note"],
                            status=ElementStatus.DRAFT.value,
                            sort_order=order,
                        )
                    )
                element_set.status = ElementSetStatus.READY.value
                element_set.completed_at = datetime.utcnow()
                element_set.error_message = None
                element_set.llm_meta = json.dumps(meta, ensure_ascii=False)
                db.commit()
                return

            except Exception as error:  # noqa: BLE001 - 都要落库给前端看
                last_error = str(error)
                exchange.append(
                    {
                        "attempt": attempt,
                        "system": system,
                        "user": user,
                        "has_image": True,
                        "response": "",
                        "error": last_error[:500],
                        "duration_ms": int((datetime.utcnow() - started).total_seconds() * 1000),
                    }
                )
                meta["exchange"] = exchange
                meta["traceback"] = traceback.format_exc()[:2000]
                feedback = last_error[:200]

        element_set.status = ElementSetStatus.FAILED.value
        element_set.error_message = last_error[:1000] or "提取失败"
        element_set.llm_meta = json.dumps(meta, ensure_ascii=False)
        db.commit()
    except Exception:  # noqa: BLE001 - 线程里最后一道保险
        db.rollback()
        raise
    finally:
        db.close()


def start_analysis(project_id: str, set_id: int) -> None:
    import threading

    thread = threading.Thread(target=run_analysis, args=(project_id, set_id), daemon=True)
    thread.start()


def exchange_of(element_set: ElementSet) -> list[LLMExchangeEntry]:
    if not element_set.llm_meta:
        return []
    try:
        meta = json.loads(element_set.llm_meta)
    except json.JSONDecodeError:
        return []
    entries = meta.get("exchange") or []
    result: list[LLMExchangeEntry] = []
    for entry in entries:
        try:
            result.append(LLMExchangeEntry(**entry))
        except TypeError:
            continue
    return result


__all__ = [
    "ElementError",
    "KINDS",
    "MAX_ELEMENTS",
    "create_set",
    "delete_set",
    "element_generations",
    "element_image",
    "exchange_of",
    "extract_elements",
    "get_set",
    "list_sets",
    "start_analysis",
    "sync_element_status",
    "update_element",
    "image_has_alpha",
]

# 生成图常在边缘留一层几乎看不见的雾；alpha 低于这个值就当作背景。
ALPHA_FLOOR = 16


def image_has_alpha(image: Image) -> bool:
    """这张图是不是「背景确实透明」的那种（透明面积 > 5%）。"""
    path = image_service.absolute_path(image)
    if not path.is_file():
        return False
    with PILImage.open(path) as opened:
        rgba = opened.convert("RGBA")
        alpha = rgba.getchannel("A")
        histogram = alpha.histogram()
        total = rgba.width * rgba.height
    if not total:
        return False
    return sum(histogram[:ALPHA_FLOOR]) / total > 0.05
