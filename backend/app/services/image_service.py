"""生成产物的落盘与查询。"""

from __future__ import annotations

import struct
import uuid
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.image import Image


class ImageStoreError(RuntimeError):
    """图片落盘失败（磁盘、权限等）。"""


MAX_UPLOAD_BYTES = 20 * 1024 * 1024

_SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpg"),
    (b"RIFF", "webp"),  # RIFF....WEBP，下面再确认
)


def detect_image_extension(content: bytes) -> str | None:
    """按魔数判断图片类型，只认 PNG / JPEG / WEBP。"""
    if content[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if content[:3] == b"\xff\xd8\xff":
        return "jpg"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "webp"
    return None


def store_upload(content: bytes, *, extension: str) -> str:
    """把参考图写到 storage/uploads/，返回相对 STORAGE_DIR 的路径。"""
    relative = Path("uploads") / f"{uuid.uuid4().hex}.{extension}"
    absolute = get_settings().storage_path / relative
    try:
        absolute.parent.mkdir(parents=True, exist_ok=True)
        absolute.write_bytes(content)
    except OSError as exc:
        raise ImageStoreError(f"保存上传图片失败：{absolute}（{exc}）") from exc
    return relative.as_posix()


def read_storage_file(relative: str) -> bytes:
    """读取 storage 下的文件（相对路径来自数据库，不接受绝对路径）。"""
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts:
        raise ImageStoreError(f"非法的存储路径：{relative}")
    absolute = get_settings().storage_path / path
    try:
        return absolute.read_bytes()
    except OSError as exc:
        raise ImageStoreError(f"读取文件失败：{absolute}（{exc}）") from exc


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


THUMBNAIL_SIZE = 480
THUMBNAIL_QUALITY = 82


def thumbnail_relative(image: Image) -> Path:
    folder = image.generation_id if image.generation_id is not None else 0
    return Path("thumbnails") / str(folder) / f"{image.id}.jpg"


def ensure_thumbnail(db: Session, image: Image) -> Path:
    """按需生成缩略图并落盘，返回绝对路径。

    首次请求时生成并写回 thumbnail_path；之后直接复用磁盘文件。
    原图缺失或解码失败都抛 ImageStoreError，让接口返回 404 而不是 500。
    """
    storage_root = get_settings().storage_path
    if image.thumbnail_path:
        cached = storage_root / image.thumbnail_path
        if cached.is_file():
            return cached

    source = absolute_path(image)
    if not source.is_file():
        raise ImageStoreError(f"图片文件缺失：{image.file_path}")

    relative = thumbnail_relative(image)
    target = storage_root / relative
    try:
        from PIL import Image as PillowImage

        target.parent.mkdir(parents=True, exist_ok=True)
        with PillowImage.open(source) as opened:
            opened = opened.convert("RGB")
            opened.thumbnail((THUMBNAIL_SIZE, THUMBNAIL_SIZE))
            opened.save(target, format="JPEG", quality=THUMBNAIL_QUALITY, optimize=True)
    except Exception as exc:  # noqa: BLE001 - 解码失败也算产物不可用
        raise ImageStoreError(f"生成缩略图失败：{source}（{exc}）") from exc

    image.thumbnail_path = relative.as_posix()
    db.commit()
    return target


def delete_image(db: Session, image: Image) -> None:
    """删库 + 删盘（原图与缩略图都清掉），文件缺失不认为是错误。"""
    storage_root = get_settings().storage_path
    paths = [storage_root / image.file_path]
    if image.thumbnail_path:
        paths.append(storage_root / image.thumbnail_path)

    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            # 删不掉就留着，不要因为文件系统问题让接口失败
            pass

    db.delete(image)
    db.commit()


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
