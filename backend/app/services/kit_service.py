"""图集：把项目里已有的透明图装成一张 atlas，导出 atlas.png + kit.json。"""

from __future__ import annotations

import io
import json
import math
import uuid
from datetime import datetime
from pathlib import Path

from PIL import Image as PILImage
from PIL import ImageDraw
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.element import Element
from app.models.image import Image
from app.models.kit import Kit, KitItem
from app.models.scene import Scene
from app.services import element_service, image_service

BLEED = 3  # 透明边缘向外扩几个像素，缩放/过滤时不会露白毛边
ALPHA_FLOOR = 16  # alpha 低于这个值当全透明（生成图边缘常有一层几乎看不见的雾）


class KitError(ValueError):
    """图集相关的可展示错误（重名、空图集、图不存在…）。"""


def _utcnow() -> datetime:
    return datetime.utcnow()


def _clean_name(name: str) -> str:
    text = (name or "").strip()
    if not text:
        raise KitError("图集名不能为空")
    return text[:60]


def list_kits(db: Session) -> list[tuple[Kit, int]]:
    rows = db.execute(
        select(Kit, func.count(KitItem.id))
        .outerjoin(KitItem, KitItem.kit_id == Kit.id)
        .where(Kit.deleted_at.is_(None))
        .group_by(Kit.id)
        .order_by(Kit.created_at.desc(), Kit.id.desc())
    ).all()
    return [(kit, count) for kit, count in rows]


def get_kit(db: Session, kit_id: int) -> Kit:
    kit = db.get(Kit, kit_id)
    if kit is None or kit.deleted_at is not None:
        raise KitError(f"图集 {kit_id} 不存在")
    return kit


def create_kit(
    db: Session,
    *,
    name: str,
    description: str | None = None,
    padding: int = 4,
    max_width: int = 2048,
    cell: int = 64,
    scene_id: int | None = None,
) -> Kit:
    if scene_id is not None:
        scene = db.get(Scene, scene_id)
        if scene is None or scene.deleted_at is not None:
            raise KitError("场景不存在")
    kit = Kit(
        name=_clean_name(name),
        description=(description or "").strip() or None,
        padding=max(0, min(64, padding)),
        max_width=max(512, min(8192, max_width)),
        cell=max(0, min(256, cell)),
        scene_id=scene_id,
    )
    db.add(kit)
    db.commit()
    db.refresh(kit)
    return kit


def update_kit(db: Session, kit: Kit, *, fields: set[str], **values) -> Kit:
    if "name" in fields and values.get("name") is not None:
        kit.name = _clean_name(values["name"])
    if "description" in fields:
        kit.description = (values.get("description") or "").strip() or None
    if "padding" in fields and values.get("padding") is not None:
        kit.padding = max(0, min(64, int(values["padding"])))
    if "max_width" in fields and values.get("max_width") is not None:
        kit.max_width = max(512, min(8192, int(values["max_width"])))
    if "cell" in fields and values.get("cell") is not None:
        kit.cell = max(0, min(256, int(values["cell"])))
    db.commit()
    db.refresh(kit)
    return kit


def delete_kit(db: Session, kit: Kit) -> Kit:
    kit.deleted_at = _utcnow()
    db.commit()
    return kit


def add_item(
    db: Session,
    kit: Kit,
    *,
    image_id: int | None = None,
    element_id: int | None = None,
    key: str | None = None,
    anchor: str = "top",
    note: str | None = None,
    scale: float = 1.0,
) -> KitItem:
    if (image_id is None) == (element_id is None):
        raise KitError("图集条目要么指向一张图，要么指向一个提取出来的元素")
    if image_id is not None:
        image = db.get(Image, image_id)
        if image is None or image.deleted_at is not None:
            raise KitError("这张图不在了，刷新一下再试")
        default_key = f"item_{image.id}"
    else:
        element = db.get(Element, element_id or 0)
        if element is None:
            raise KitError("这个元素不在了，刷新一下再试")
        # 还没出图就加不进图集：图集要按 alpha 裁边，没有图就是个空位
        if element_service.element_image(db, element) is None:
            raise KitError("这件还没出图，先点「提取」出一张，再加进图集")
        # 同一个元素重复加：直接返回已有的那条，免得图集里出现两遍同一件
        existing = db.scalar(
            select(KitItem).where(KitItem.kit_id == kit.id, KitItem.element_id == element.id)
        )
        if existing is not None:
            return existing
        default_key = element.key or f"item_{element.id}"
    next_order = db.scalar(
        select(func.coalesce(func.max(KitItem.sort_order), -1)).where(KitItem.kit_id == kit.id)
    )
    item = KitItem(
        kit_id=kit.id,
        image_id=image_id,
        element_id=element_id,
        key=(key or "").strip()[:60] or default_key,
        anchor=anchor if anchor in ("top", "bottom") else "top",
        note=(note or "").strip()[:200] or None,
        scale=_clamp_scale(scale),
        sort_order=int(next_order or 0) + 1,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def _item_or_error(db: Session, item_id: int) -> KitItem:
    item = db.get(KitItem, item_id)
    if item is None:
        raise KitError(f"图集条目 {item_id} 不存在")
    return item


def remove_element(db: Session, kit: Kit, element_id: int) -> bool:
    """把某个元素从图集里拿掉（一个图集里同一元素最多一条）。"""
    item = db.scalar(
        select(KitItem).where(KitItem.kit_id == kit.id, KitItem.element_id == element_id)
    )
    if item is None:
        return False
    db.delete(item)
    db.commit()
    return True


def update_item(db: Session, item_id: int, *, fields: set[str], **values) -> KitItem:
    item = _item_or_error(db, item_id)
    if "key" in fields and values.get("key") is not None:
        item.key = (values["key"] or "").strip()[:60] or item.key
    if "anchor" in fields and values.get("anchor") in ("top", "bottom"):
        item.anchor = values["anchor"]
    if "note" in fields:
        item.note = (values.get("note") or "").strip()[:200] or None
    if "sort_order" in fields and values.get("sort_order") is not None:
        item.sort_order = max(0, int(values["sort_order"]))
    if "scale" in fields and values.get("scale") is not None:
        item.scale = _clamp_scale(float(values["scale"]))
    db.commit()
    db.refresh(item)
    return item


def delete_item(db: Session, item_id: int) -> None:
    item = _item_or_error(db, item_id)
    db.delete(item)
    db.commit()


def _clamp_scale(value: float) -> float:
    """缩放比例收在 0.05–2.0 之间，保留三位小数（够用，也让 json 干净）。"""
    return round(max(0.05, min(2.0, float(value))), 3)


def _item_piece_path(db: Session, item: KitItem, storage_root: Path | None) -> tuple[Path, str]:
    """图集条目的来源文件：可能是项目里的图，也可能是元素提取出来的小图。"""
    if item.element_id:
        element = db.get(Element, item.element_id)
        if element is None or element.status == "failed":
            raise KitError(f"条目「{item.key}」的元素没有可用的图")
        image = element_service.element_image(db, element)
        if image is None:
            raise KitError(f"条目「{item.key}」的元素还没出图")
        return image_service.absolute_path(image, storage_root), f"元素「{element.name}」"
    if item.image_id:
        image = db.get(Image, item.image_id)
        if image is None or image.deleted_at is not None:
            raise KitError(f"条目「{item.key}」的图不在了")
        return image_service.absolute_path(image, storage_root), f"图 {image.id}"
    raise KitError(f"条目「{item.key}」没有来源图")


def _load_piece(path: Path, label: str, scale: float = 1.0) -> PILImage.Image:
    if not path.is_file():
        raise KitError(f"{label} 的文件不在了")
    with PILImage.open(path) as opened:
        rgba = opened.convert("RGBA")
    # 透明像素里的 RGB 常常是紫/品红之类的残留色（生成器画了什么就留了什么），
    # 装箱后缩放到游戏里会被双线性采样「拉」出来，形成一圈彩边，先统一清成黑色。
    clear = rgba.getchannel("A").point(lambda v: 255 if v < ALPHA_FLOOR else 0)
    rgba.paste((0, 0, 0, 0), mask=clear)
    # 生成图常在边缘留一层几乎看不见的雾（alpha 1–15），直接 getbbox() 会把整张画布都算进去，
    # 所以先按阈值做一张「实心遮罩」再取框。
    solid = rgba.getchannel("A").point(lambda v: 255 if v >= ALPHA_FLOOR else 0)
    bbox = solid.getbbox()
    if bbox:
        rgba = rgba.crop(bbox)
    if abs(scale - 1.0) > 0.001:
        width = max(1, round(rgba.width * scale))
        height = max(1, round(rgba.height * scale))
        rgba = rgba.resize((width, height), PILImage.LANCZOS)
    return rgba


def _bleed(piece: PILImage.Image) -> PILImage.Image:
    """把边缘颜色往外扩几像素，避免采样时露出透明边。"""
    width, height = piece.size
    size = (width + BLEED * 2, height + BLEED * 2)
    canvas = PILImage.new("RGBA", size, (0, 0, 0, 0))
    canvas.paste(piece, (BLEED, BLEED))

    top = canvas.crop((BLEED, BLEED, BLEED + width, BLEED + 1))
    bottom = canvas.crop((BLEED, BLEED + height - 1, BLEED + width, BLEED + height))
    left = canvas.crop((BLEED, BLEED, BLEED + 1, BLEED + height))
    right = canvas.crop((BLEED + width - 1, BLEED, BLEED + width, BLEED + height))
    for step in range(1, BLEED + 1):
        canvas.paste(top, (BLEED, BLEED - step))
        canvas.paste(bottom, (BLEED, BLEED + height + step - 1))
        canvas.paste(left, (BLEED - step, BLEED))
        canvas.paste(right, (BLEED + width + step - 1, BLEED))

    # 四个角用最近的角像素铺成 BLEED×BLEED 的小方块
    corners = [
        ((BLEED, BLEED), (0, 0)),
        ((BLEED + width - 1, BLEED), (BLEED + width, 0)),
        ((BLEED, BLEED + height - 1), (0, BLEED + height)),
        ((BLEED + width - 1, BLEED + height - 1), (BLEED + width, BLEED + height)),
    ]
    for (sx, sy), (dx, dy) in corners:
        canvas.paste(canvas.getpixel((sx, sy)), (dx, dy, dx + BLEED, dy + BLEED))
    return canvas


class _MaxRects:
    """整数网格上的 MaxRects（BSSF）：单位由调用方决定（像素或格子）。

    比按行堆（shelf）能吃下更多件：shelf 的每一行高度按最高那件算，
    矮件上方的空白全浪费；MaxRects 会把后面的件塞进这些空洞。
    """

    def __init__(self, width: int) -> None:
        self.free: list[tuple[int, int, int, int]] = [(0, 0, width, 1 << 20)]
        self.used_w = 0
        self.used_h = 0

    def insert(self, w: int, h: int) -> tuple[int, int] | None:
        best: tuple[int, int, int, int] | None = None
        best_score: tuple[int, int] | None = None
        for fx, fy, fw, fh in self.free:
            if w <= fw and h <= fh:
                # best short side fit：优先放进「短边浪费最少」的空洞
                score = (min(fw - w, fh - h), max(fw - w, fh - h))
                if best_score is None or score < best_score:
                    best_score = score
                    best = (fx, fy, fw, fh)
        if best is None:
            return None
        fx, fy, _fw, _fh = best
        self._split(fx, fy, w, h)
        self.used_w = max(self.used_w, fx + w)
        self.used_h = max(self.used_h, fy + h)
        return fx, fy

    def _split(self, x: int, y: int, w: int, h: int) -> None:
        out: list[tuple[int, int, int, int]] = []
        for fx, fy, fw, fh in self.free:
            if x >= fx + fw or x + w <= fx or y >= fy + fh or y + h <= fy:
                out.append((fx, fy, fw, fh))
                continue
            if x > fx:
                out.append((fx, fy, x - fx, fh))
            if x + w < fx + fw:
                out.append((x + w, fy, fx + fw - (x + w), fh))
            if y > fy:
                out.append((fx, fy, fw, y - fy))
            if y + h < fy + fh:
                out.append((fx, y + h, fw, fy + fh - (y + h)))
        self.free = self._prune(out)

    @staticmethod
    def _prune(rects: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
        out: list[tuple[int, int, int, int]] = []
        for index, a in enumerate(rects):
            contained = False
            for other, b in enumerate(rects):
                if index == other:
                    continue
                if (
                    a[0] >= b[0]
                    and a[1] >= b[1]
                    and a[0] + a[2] <= b[0] + b[2]
                    and a[1] + a[3] <= b[1] + b[3]
                ):
                    contained = True
                    break
            if not contained:
                out.append(a)
        return out


def _shrink_to_fit(
    pieces: list[tuple[KitItem, PILImage.Image]], limit_w: int
) -> tuple[list[tuple[KitItem, PILImage.Image]], list[str]]:
    """单件比画布还宽时等比缩到刚好放下，返回缩过的件名。

    图集不该因为一件太宽就整张打包失败——用户可以先看图，再决定是不是
    去元素页把这一件的比例调小。
    """
    fitted: list[tuple[KitItem, PILImage.Image]] = []
    shrunk: list[str] = []
    for item, piece in pieces:
        if piece.width > limit_w > 0:
            ratio = limit_w / piece.width
            size = (
                max(1, int(piece.width * ratio)),
                max(1, int(piece.height * ratio)),
            )
            piece = piece.resize(size, PILImage.LANCZOS)
            shrunk.append(item.key or f"#{item.id}")
        fitted.append((item, piece))
    return fitted, shrunk


def _pack_grid(
    pieces: list[tuple[KitItem, PILImage.Image]],
    *,
    max_width: int,
    padding: int,
    cell: int,
) -> tuple[list[tuple[KitItem, PILImage.Image, int, int]], int, int, list[str]]:
    """按格子装箱：每件占 ceil((w+2p)/cell) × ceil((h+2p)/cell) 个整格。

    所有坐标都是格子的整数倍，所以**一格之内只会有一个件**（不会出现两件
    各占半格的情况），引擎侧按 64 格对齐摆放时不会互相串味。
    """
    max_cols = max(1, max_width // cell)
    pieces, shrunk = _shrink_to_fit(pieces, max_cols * cell - padding * 2)

    units: list[tuple[KitItem, PILImage.Image, int, int]] = []
    for item, piece in pieces:
        cols = -(-(piece.width + padding * 2) // cell)
        rows = -(-(piece.height + padding * 2) // cell)
        units.append((item, piece, cols, rows))

    total_units = sum(cols * rows for _, _, cols, rows in units)

    orders = [
        sorted(units, key=lambda entry: entry[2] * entry[3], reverse=True),
        sorted(units, key=lambda entry: (entry[3], entry[2]), reverse=True),
        sorted(units, key=lambda entry: (entry[2], entry[3]), reverse=True),
    ]

    start = min(max_cols, max(1, math.ceil(math.sqrt(total_units))))
    step = max(1, max_cols // 80)
    best: tuple[tuple[int, float], list[tuple[KitItem, PILImage.Image, int, int]], int, int] | None = None
    for cols in range(start, max_cols + 1, step):
        for order in orders:
            packer = _MaxRects(cols)
            placed: list[tuple[KitItem, PILImage.Image, int, int]] = []
            fitted = True
            for item, piece, unit_w, unit_h in order:
                pos = packer.insert(unit_w, unit_h)
                if pos is None:
                    fitted = False
                    break
                placed.append(
                    (
                        item,
                        piece,
                        pos[0] * cell + padding,
                        pos[1] * cell + padding,
                    )
                )
            if not fitted:
                continue
            width = packer.used_w * cell
            height = packer.used_h * cell
            aspect = width / max(1, height)
            score = (_aspect_cost(width * height, aspect), abs(aspect - 1.4))
            if best is None or score < best[0]:
                best = (score, placed, width, height)

    if best is None:
        raise KitError("装不下：把图集宽度调大，或者少放几个件")
    return best[1], best[2], best[3], shrunk


def _pack_free(
    pieces: list[tuple[KitItem, PILImage.Image]],
    *,
    max_width: int,
    padding: int,
) -> tuple[list[tuple[KitItem, PILImage.Image, int, int]], int, int, list[str]]:
    """不对齐格子时用：像素级 MaxRects，宽度也一起搜（同面积下更方正）。"""
    pieces, shrunk = _shrink_to_fit(pieces, max_width - padding * 2)
    ordered = sorted(pieces, key=lambda entry: (entry[1].height, entry[1].width), reverse=True)
    widest = max(piece.width for _, piece in pieces) + padding * 2
    low = min(max_width, max(256, widest))
    step = max(8, (max_width - low) // 64 or 8)

    best: tuple[tuple[int, float], list[tuple[KitItem, PILImage.Image, int, int]], int, int] | None = None
    for width in range(low, max_width + 1, step):
        packer = _MaxRects(width)
        placed: list[tuple[KitItem, PILImage.Image, int, int]] = []
        fitted = True
        for item, piece in ordered:
            pos = packer.insert(piece.width + padding * 2, piece.height + padding * 2)
            if pos is None:
                fitted = False
                break
            placed.append((item, piece, pos[0] + padding, pos[1] + padding))
        if not fitted:
            continue
        canvas_w = packer.used_w
        canvas_h = packer.used_h
        aspect = canvas_w / max(1, canvas_h)
        score = (_aspect_cost(canvas_w * canvas_h, aspect), abs(aspect - 1.4))
        if best is None or score < best[0]:
            best = (score, placed, canvas_w, canvas_h)

    if best is None:
        raise KitError("装不下：把图集宽度调大，或者少放几个件")
    return best[1], best[2], best[3], shrunk


def _aspect_cost(area: int, aspect: float) -> int:
    """太扁或太长的画布多算一点面积：GPU 上长条贴图不好用，肉眼也不好摆。"""
    if aspect > 2.2 or aspect < 0.55:
        return int(area * 1.12)
    return area


def _piece_name(items: list[KitItem]) -> str:
    return "、".join(item.key or f"#{item.image_id}" for item in items[:3])


def build_atlas(
    db: Session,
    kit: Kit,
    *,
    storage_root: Path | None = None,
) -> tuple[bytes, dict]:
    """装箱并渲染，返回 (atlas PNG bytes, manifest dict)。"""
    items = list(kit.items)
    if not items:
        raise KitError("图集还是空的，先往里放几张图")

    pieces: list[tuple[KitItem, PILImage.Image]] = []
    skipped: list[str] = []
    for item in items:
        try:
            path, label = _item_piece_path(db, item, storage_root)
            piece = _load_piece(path, label, float(item.scale or 1.0))
        except KitError as error:
            # 条目背后的图被删了、元素还没出图：跳过这一件，别把整张图集卡住。
            skipped.append(f"{item.key}（{error}）")
            continue
        pieces.append((item, _bleed(piece)))

    if not pieces:
        detail = "；".join(skipped[:3]) if skipped else "图集里的条目都没有可用的图"
        raise KitError(f"图集里没有可用的图：{detail}")

    max_width = max(kit.max_width, 256)
    padding = max(0, kit.padding)
    cell = max(0, kit.cell or 0)
    if cell and cell > 8:
        placements, width, height, shrunk = _pack_grid(
            pieces, max_width=max_width, padding=padding, cell=cell
        )
    else:
        placements, width, height, shrunk = _pack_free(
            pieces, max_width=max_width, padding=padding
        )

    width = max(256, width)
    height = max(256, height)
    atlas = PILImage.new("RGBA", (width, height), (0, 0, 0, 0))
    for _item, piece, x, y in placements:
        atlas.paste(piece, (x, y), piece)

    buffer = io.BytesIO()
    atlas.save(buffer, format="PNG", optimize=True)
    data = buffer.getvalue()

    entries = []
    for item, piece, x, y in placements:
        entries.append(
            {
                "id": item.id,
                "key": item.key,
                "anchor": item.anchor,
                "image_id": item.image_id,
                "element_id": item.element_id,
                "x": x,
                "y": y,
                "w": piece.width,
                "h": piece.height,
                "bleed": BLEED,
                "note": item.note,
            }
        )
    used_area = sum(piece.width * piece.height for _item, piece, _x, _y in placements)
    manifest = {
        "name": kit.name,
        "atlas": "atlas.png",
        "width": width,
        "height": height,
        "padding": padding,
        "bleed": BLEED,
        "cell": cell,
        "fill": round(used_area / (width * height), 4),
        "packing": "maxrects-cell" if cell and cell > 8 else "maxrects-free",
        "items": sorted(entries, key=lambda entry: entry["key"]),
        "skipped": skipped,
        "shrunk": shrunk,
    }
    return data, manifest


def _round_up(value: int, step: int = 4) -> int:
    return ((int(value) + step - 1) // step) * step


def draw_grid(png: bytes, cell: int, color: tuple[int, int, int, int] = (120, 200, 255, 70)) -> bytes:
    """给预览图叠一层格子线（只给界面看，导出不用它）。"""
    if cell <= 0:
        return png
    with PILImage.open(io.BytesIO(png)) as opened:
        atlas = opened.convert("RGBA")
    overlay = PILImage.new("RGBA", atlas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for x in range(0, atlas.width, cell):
        draw.line([(x, 0), (x, atlas.height)], fill=color)
    for y in range(0, atlas.height, cell):
        draw.line([(0, y), (atlas.width, y)], fill=color)
    merged = PILImage.alpha_composite(atlas, overlay)
    buffer = io.BytesIO()
    merged.save(buffer, format="PNG")
    return buffer.getvalue()


def build_export(db: Session, kit: Kit, *, storage_root: Path | None = None) -> tuple[bytes, str]:
    """打包成 zip：atlas.png + kit.json + README.txt。返回 (zip bytes, 文件名)。"""
    import zipfile

    png, manifest = build_atlas(db, kit, storage_root=storage_root)
    readme = [
        f"{kit.name} — 图集",
        "",
        f"atlas.png {manifest['width']}×{manifest['height']}，{len(manifest['items'])} 个件。",
        "",
        "用法：每件按 kit.json 里的 x/y/w/h 从 atlas.png 里取矩形；",
        "anchor 表示对齐点：top = 图的上边缘贴放置点（平台顶面），bottom = 下边缘。",
        "w/h 已经包含四周各 3px 的透明扩边，画出来时按 w-6 / h-6 取内框即可。",
        "",
        "Godot：AtlasTexture(atlas = atlas.png, region = Rect2(x, y, w, h))。",
    ]
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("atlas.png", png)
        archive.writestr("kit.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        archive.writestr("README.txt", "\n".join(readme))
    safe_name = "".join(ch for ch in kit.name if ch not in '\\/:*?"<>|').strip() or "kit"
    return buffer.getvalue(), f"{safe_name}-atlas-{stamp}.zip"


def new_token() -> str:
    return uuid.uuid4().hex
