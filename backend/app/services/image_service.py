"""生成产物的落盘与查询。"""

from __future__ import annotations

import struct
import uuid
from collections.abc import Sequence
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.projects import active_project
from app.models.image import Image


class ImageStoreError(RuntimeError):
    """图片落盘失败（磁盘、权限等）。"""


MAX_UPLOAD_BYTES = 20 * 1024 * 1024


def storage_root_for(storage_root: Path | None = None) -> Path:
    """产物根目录：默认取当前激活项目的 storage；worker 会显式传目标任务所属的项目。"""
    return Path(storage_root) if storage_root is not None else active_project().storage_path

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


def store_upload(
    content: bytes, *, extension: str, storage_root: Path | None = None
) -> str:
    """把参考图写到 storage/uploads/，返回相对项目的 storage 的路径。"""
    relative = Path("uploads") / f"{uuid.uuid4().hex}.{extension}"
    absolute = storage_root_for(storage_root) / relative
    try:
        absolute.parent.mkdir(parents=True, exist_ok=True)
        absolute.write_bytes(content)
    except OSError as exc:
        raise ImageStoreError(f"保存上传图片失败：{absolute}（{exc}）") from exc
    return relative.as_posix()


def read_storage_file(relative: str, storage_root: Path | None = None) -> bytes:
    """读取 storage 下的文件（相对路径来自数据库，不接受绝对路径）。"""
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts:
        raise ImageStoreError(f"非法的存储路径：{relative}")
    absolute = storage_root_for(storage_root) / path
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
    storage_root: Path | None = None,
    media_type: str = "image",
    duration_seconds: float | None = None,
    fps: float | None = None,
    frame_count: int | None = None,
    poster: bytes | None = None,
) -> Image:
    """写入 storage/{images|videos}/{generation_id}/{task_id}_{index}.{ext} 并登记产物行。

    图片进 storage/images/，视频进 storage/videos/ —— 两者混在一个目录里既难清理
    也没法用「打开文件夹」快速分辨。库里存的是相对 storage 的完整路径，
    所以早期写在 images/ 下的视频仍然能正常读取。

    视频时 extension="mp4"、宽高与时长从 ComfyUI 的 metadata 传进来，
    poster 是封面帧 PNG —— 直接压成缩略图，作品流里用封面代替视频本身。
    """
    root = storage_root_for(storage_root)
    folder = "videos" if media_type == "video" else "images"
    relative = Path(folder) / str(generation_id) / f"{task_id}_{index}.{extension}"
    absolute = root / relative
    try:
        absolute.parent.mkdir(parents=True, exist_ok=True)
        absolute.write_bytes(content)
    except OSError as exc:
        raise ImageStoreError(f"保存图片失败：{absolute}（{exc}）") from exc

    if width is None or height is None:
        detected = png_dimensions(content)
        if detected is None:
            raise ImageStoreError("无法确定产物尺寸，且未提供宽高")
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
        media_type=media_type,
        duration_seconds=duration_seconds,
        fps=fps,
        frame_count=frame_count,
    )
    db.add(image)
    db.flush()

    if poster:
        relative_thumb = thumbnail_relative(image)
        target = root / relative_thumb
        try:
            from PIL import Image as PillowImage
            import io

            target.parent.mkdir(parents=True, exist_ok=True)
            with PillowImage.open(io.BytesIO(poster)) as opened:
                frame = opened.convert("RGB")
                frame.thumbnail((THUMBNAIL_SIZE, THUMBNAIL_SIZE))
                frame.save(target, format="JPEG", quality=THUMBNAIL_QUALITY, optimize=True)
        except Exception as exc:  # noqa: BLE001 - 封面坏了不该让整条任务失败
            raise ImageStoreError(f"保存视频封面失败：{target}（{exc}）") from exc
        image.thumbnail_path = relative_thumb.as_posix()
        db.flush()

    return image


def absolute_path(image: Image, storage_root: Path | None = None) -> Path:
    """把库里的相对路径还原成磁盘绝对路径。"""
    return storage_root_for(storage_root) / image.file_path


THUMBNAIL_SIZE = 480
THUMBNAIL_QUALITY = 82


def thumbnail_relative(image: Image) -> Path:
    folder = image.generation_id if image.generation_id is not None else 0
    return Path("thumbnails") / str(folder) / f"{image.id}.jpg"


def ensure_thumbnail(db: Session, image: Image, storage_root: Path | None = None) -> Path:
    """按需生成缩略图并落盘，返回绝对路径。

    首次请求时生成并写回 thumbnail_path；之后直接复用磁盘文件。
    原图缺失或解码失败都抛 ImageStoreError，让接口返回 404 而不是 500。
    """
    root = storage_root_for(storage_root)
    if image.thumbnail_path:
        cached = root / image.thumbnail_path
        if cached.is_file():
            return cached

    if image.media_type == "video":
        # 视频没法用 Pillow 解码；worker 落库时已经用封面帧生成缩略图了
        raise ImageStoreError(f"视频产物缺少封面帧：{image.file_path}")

    source = absolute_path(image, storage_root)
    if not source.is_file():
        raise ImageStoreError(f"产物文件缺失：{image.file_path}")

    relative = thumbnail_relative(image)
    target = root / relative
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


def remove_files(image: Image, storage_root: Path | None = None) -> None:
    """删掉原图与缩略图；文件缺失或删不掉都不算错误。"""
    root = storage_root_for(storage_root)
    paths = [root / image.file_path]
    if image.thumbnail_path:
        paths.append(root / image.thumbnail_path)

    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            # 删不掉就留着，不要因为文件系统问题让接口失败
            pass


def delete_image(db: Session, image: Image, storage_root: Path | None = None) -> None:
    """删库 + 删盘（原图与缩略图都清掉），文件缺失不认为是错误。"""
    remove_files(image, storage_root)
    db.delete(image)
    db.commit()


def delete_images(
    db: Session, image_ids: Sequence[int], storage_root: Path | None = None
) -> tuple[list[int], list[int]]:
    """批量删除。返回 (真正删掉的 id, 本来就不存在的 id)。

    一次事务、一次 commit：中途某个文件删不掉不影响其余记录，也不回滚。
    """
    wanted = list(dict.fromkeys(int(image_id) for image_id in image_ids))
    if not wanted:
        return [], []

    rows = list(db.scalars(select(Image).where(Image.id.in_(wanted))).all())
    found = {row.id for row in rows}
    for row in rows:
        remove_files(row, storage_root)
        db.delete(row)

    db.commit()
    return sorted(found), sorted(set(wanted) - found)


def list_images(
    db: Session,
    *,
    limit: int = 20,
    offset: int = 0,
    generation_id: int | None = None,
    favorites_only: bool = False,
) -> tuple[list[Image], int]:
    from sqlalchemy import func

    conditions = []
    if generation_id is not None:
        conditions.append(Image.generation_id == generation_id)
    if favorites_only:
        conditions.append(Image.is_favorite.is_(True))

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


def set_favorite(db: Session, image: Image, favorite: bool) -> Image:
    """收藏 / 取消收藏；只改一行，不动文件。"""
    image.is_favorite = favorite
    db.commit()
    db.refresh(image)
    return image
