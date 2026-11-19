"""抽帧台：把导出的帧集整包存成一条资产。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.models.database import get_db
from app.schemas.frames import FrameSetSaved
from app.models.image import Image
from app.services.generation_service import create_frame_set, replace_frame_set
from app.services.image_service import ImageStoreError

router = APIRouter(prefix="/frames", tags=["frames"])

MAX_BUNDLE_BYTES = 256 * 1024 * 1024
MAX_FRAMES = 2000
ZIP_MAGIC = b"PK\x03\x04"


async def _read_bundle(upload: UploadFile) -> bytes:
    content = await upload.read()
    if not content:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "帧集压缩包是空的")
    if len(content) > MAX_BUNDLE_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "帧集压缩包超过 256 MB")
    if not content.startswith(ZIP_MAGIC):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "不是 ZIP 文件")
    return content


async def _read_cover(upload: UploadFile) -> bytes:
    content = await upload.read()
    if not content:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "封面帧是空的")
    return content


@router.post("", response_model=FrameSetSaved, status_code=status.HTTP_201_CREATED)
async def save_frame_set(
    bundle: UploadFile = File(...),
    cover: UploadFile = File(...),
    name: str = Form(...),
    count: int = Form(...),
    width: int = Form(...),
    height: int = Form(...),
    fps: float | None = Form(default=None),
    source_video_id: int | None = Form(default=None),
    db: Session = Depends(get_db),
) -> FrameSetSaved:
    """收下抽帧台导出的 ZIP 与封面帧，登记成一条「帧集」资产。

    整包入库，不拆成每帧一条 images 记录：73 帧 × 几条视频就足以把画廊冲垮。
    """
    label = name.strip()
    if not label:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "帧集名字不能为空")
    if len(label) > 60:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "帧集名字最多 60 个字")
    if not 1 <= count <= MAX_FRAMES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"帧数要在 1–{MAX_FRAMES} 之间")
    if width < 0 or height < 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "宽高不能是负数")

    content = await _read_bundle(bundle)
    poster = await _read_cover(cover)
    try:
        generation, image = create_frame_set(
            db,
            content=content,
            cover=poster,
            name=label,
            count=count,
            fps=fps,
            width=width,
            height=height,
            source_video_id=source_video_id,
        )
    except ImageStoreError as error:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(error)) from error

    return FrameSetSaved(
        generation_id=generation.id,
        image_id=image.id,
        name=label,
        frame_count=count,
        fps=fps,
        width=image.width or width,
        height=image.height or height,
    )

@router.put("/{image_id}", response_model=FrameSetSaved)
async def overwrite_frame_set(
    image_id: int,
    bundle: UploadFile = File(...),
    cover: UploadFile = File(...),
    name: str = Form(...),
    count: int = Form(...),
    width: int = Form(...),
    height: int = Form(...),
    fps: float | None = Form(default=None),
    db: Session = Depends(get_db),
) -> FrameSetSaved:
    """用抽帧台重新导出的包覆盖同一条帧集（资产库里不新增条目）。"""
    label = name.strip()
    if not label:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "帧集名字不能为空")
    if len(label) > 60:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "帧集名字最多 60 个字")
    if not 1 <= count <= MAX_FRAMES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"帧数要在 1–{MAX_FRAMES} 之间")
    if width < 0 or height < 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "宽高不能是负数")

    image = db.get(Image, image_id)
    if image is None or image.media_type != "frameset" or image.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"没有 id 为 {image_id} 的帧集")

    content = await _read_bundle(bundle)
    poster = await _read_cover(cover)
    try:
        generation, saved = replace_frame_set(
            db,
            image=image,
            content=content,
            cover=poster,
            name=label,
            count=count,
            fps=fps,
            width=width,
            height=height,
        )
    except (ImageStoreError, ValueError) as error:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(error)) from error

    return FrameSetSaved(
        generation_id=generation.id,
        image_id=saved.id,
        name=label,
        frame_count=count,
        fps=fps,
        width=saved.width or width,
        height=saved.height or height,
    )
