"""图片接口：列表与原始文件。"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import live_image
from app.models.database import get_db
from app.models.image import Image
from app.schemas.image import (
    ImageBatchDeleteRequest,
    ImageBatchDeleteResponse,
    ImageListResponse,
    ImageRead,
    WorkspaceClearResponse,
)
from app.services.image_service import (
    ImageStoreError,
    absolute_path,
    ensure_thumbnail,
    label_images,
    list_images,
    set_favorite,
    trimmed_png,
)
from app.services.recycle_service import soft_delete_images
from app.services.workspace_service import WorkspaceBusyError, clear_workspace

router = APIRouter(prefix="/images", tags=["images"])


def _reads(db: Session, rows: list[Image]) -> list[ImageRead]:
    """把「批次名 · 第 N 个」贴到每条记录上；列表与单条走同一套。"""
    labels = label_images(db, rows)
    items: list[ImageRead] = []
    for row in rows:
        item = ImageRead.model_validate(row)
        item.label = labels.get(row.id, "")
        items.append(item)
    return items


@router.get("", response_model=ImageListResponse)
def list_all(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    generation_id: int | None = Query(default=None, ge=1),
    favorite: bool = Query(default=False, description="只看收藏"),
    scene: int | None = Query(
        default=None,
        ge=1,
        description="场景 id：只看该场景的产物；不传则排除场景内的产物（主图片流）",
    ),
    db: Session = Depends(get_db),
) -> ImageListResponse:
    rows, total = list_images(
        db,
        limit=limit,
        offset=offset,
        generation_id=generation_id,
        favorites_only=favorite,
        scene_id=scene,
    )
    return ImageListResponse(
        items=_reads(db, rows),
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/{image_id}", response_model=ImageRead)
def get_image(image_id: int, db: Session = Depends(get_db)) -> ImageRead:
    return _reads(db, [live_image(db, image_id)])[0]


_ASSET_CONTENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".json": "application/json",
    ".zip": "application/zip",
}


def _content_type(image: Image) -> str:
    """产物类型跟着文件后缀走：视频 mp4、图集 zip、atlas.json 各是各的。"""
    if image.media_type == "video":
        return "video/mp4"
    suffix = Path(image.file_path).suffix.lower()
    return _ASSET_CONTENT_TYPES.get(suffix, "image/png")

@router.get("/{image_id}/file", response_class=FileResponse)
def get_image_file(image_id: int, db: Session = Depends(get_db)) -> FileResponse:
    image = db.get(Image, image_id)
    if image is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"image {image_id} 不存在"
        )
    path = absolute_path(image)
    if not path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"图片文件缺失：{image.file_path}",
        )
    # 视频产物走同一个端点，Content-Type 必须跟着 media_type 变，否则浏览器当图片解码
    media_type = _content_type(image)
    return FileResponse(
        path,
        media_type=media_type,
        filename=path.name,
        headers={"Accept-Ranges": "bytes"},
    )


@router.get("/{image_id}/thumbnail", response_class=FileResponse)
def get_image_thumbnail(image_id: int, db: Session = Depends(get_db)) -> FileResponse:
    """画廊用缩略图。首次访问时生成，之后走磁盘缓存。"""
    image = db.get(Image, image_id)
    if image is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"image {image_id} 不存在"
        )
    try:
        path = ensure_thumbnail(db, image)
    except ImageStoreError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    # 缩略图可能是 JPEG，也可能是保住 alpha 的 PNG（场景 / 分层产物）
    thumbnail_type = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    return FileResponse(
        path,
        media_type=thumbnail_type,
        # 缩略图会自愈重做（比如透明图从 JPEG 换成 PNG），路径没变、URL 也没变，
        # 所以不能让浏览器把它当 immutable 长期缓存，否则旧图一直显示。
        headers={"Cache-Control": "public, max-age=0, must-revalidate"},
    )


@router.get("/{image_id}/trimmed.png", response_class=Response)
def get_image_trimmed(
    image_id: int,
    max_side: int = Query(320, ge=32, le=2048),
    db: Session = Depends(get_db),
) -> Response:
    """裁掉透明空白后的小图：透明件（元素 / 模块）在信息流里用它，别显示一整张空画布。"""
    image = db.get(Image, image_id)
    if image is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"image {image_id} 不存在"
        )
    try:
        payload = trimmed_png(image, max_side=max_side)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return Response(
        content=payload,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=0, must-revalidate"},
    )


@router.post("/{image_id}/favorite", response_model=ImageRead)
def set_image_favorite(
    image_id: int,
    favorite: bool = Body(..., embed=True, description="true 收藏 / false 取消"),
    db: Session = Depends(get_db),
) -> ImageRead:
    """收藏或取消收藏。作品流「仅收藏」筛选依赖这个标记。"""
    image = live_image(db, image_id)
    # 走 _reads 而不是 ImageRead.model_validate：label 是按批次算出来的，不能漏
    return _reads(db, [set_favorite(db, image, favorite)])[0]


@router.delete("/{image_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_image(image_id: int, db: Session = Depends(get_db)) -> Response:
    """删除一张图：进回收站（软删除），30 天内可恢复。"""
    soft_delete_images(db, [live_image(db, image_id)])
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/batch-delete", response_model=ImageBatchDeleteResponse)
def remove_images(
    payload: ImageBatchDeleteRequest,
    db: Session = Depends(get_db),
) -> ImageBatchDeleteResponse:
    """批量删除（进回收站）。已不存在的 id 放进 missing 而不是整批失败——多标签页同时删是常态。"""
    wanted = list(dict.fromkeys(int(image_id) for image_id in payload.ids))
    if not wanted:
        return ImageBatchDeleteResponse(deleted=[], missing=[])

    rows = list(
        db.scalars(
            select(Image).where(Image.id.in_(wanted), Image.deleted_at.is_(None))
        ).all()
    )
    deleted = soft_delete_images(db, rows)
    return ImageBatchDeleteResponse(
        deleted=deleted, missing=sorted(set(wanted) - set(deleted))
    )


@router.post("/clear", response_model=WorkspaceClearResponse)
def clear_all(db: Session = Depends(get_db)) -> WorkspaceClearResponse:
    """清空工作区：删除全部图片与生成记录，并清掉 storage 下的产物。不可撤销。"""
    try:
        counts = clear_workspace(db)
    except WorkspaceBusyError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return WorkspaceClearResponse(**counts)