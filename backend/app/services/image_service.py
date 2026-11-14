"""生成产物的落盘与查询。"""

from __future__ import annotations

import struct
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.image import Image


class ImageStoreError(RuntimeError):
    """图片落盘失败（磁盘、权限等）。"""


def png_dimensions(content: bytes) -> tuple[int, int] | None:
    """从 PNG 头部读宽高（IHDR 固定位置）。非 PNG 返回 None。"""
    if len(content) < 24 or content[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    width, height = struct.unpack(">II", content[16:24])
    return int(width), int(height)


def store_image(
    db: Session,
    *,
    content: bytes,
    generation_id: int,
    task_id: int,
    index: int,
    width: int | None = None,
    height: int | None = None,
    extension: str = "png",
) -> Image:
    """写入 storage/images/{generation_id}/{task_id}_{index}.png 并登记 images 行。"""
    storage_root = get_settings().storage_path
    relative = Path("images") / str(generation_id) / f"{task_id}_{index}.{extension}"
    absolute = storage_root / relative
    try:
        absolute.parent.mkdir(parents=True, exist_ok=True)
        absolute.write_bytes(content)
    except OSError as exc:
        raise ImageStoreError(f"保存图片失败：{absolute}（{exc}）") from exc

    if width is None or height is None:
        detected = png_dimensions(content)
        if detected is None:
            raise ImageStoreError("无法确定图片尺寸，且未提供宽高")
        width, height = detected

    image = Image(
        task_id=task_id,
        generation_id=generation_id,
        file_path=relative.as_posix(),
        thumbnail_path=None,
        original_image_id=None,
        width=width,
        height=height,
        file_size=len(content),
    )
    db.add(image)
    db.flush()
    return image


def absolute_path(image: Image) -> Path:
    """把库里的相对路径还原成磁盘绝对路径。"""
    return get_settings().storage_path / image.file_path


def list_images(
    db: Session, *, limit: int = 20, offset: int = 0, generation_id: int | None = None
) -> tuple[list[Image], int]:
    from sqlalchemy import func

    conditions = []
    if generation_id is not None:
        conditions.append(Image.generation_id == generation_id)

    count_stmt = select(func.count()).select_from(Image)
    stmt = select(Image)
    for condition in conditions:
        count_stmt = count_stmt.where(condition)
        stmt = stmt.where(condition)

    total = db.scalar(count_stmt) or 0
    rows = list(
        db.scalars(stmt.order_by(Image.id.desc()).limit(limit).offset(offset)).all()
    )
    return rows, total
