"""图片接口：列表与原始文件。"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

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
    delete_image,
    delete_images,
    ensure_thumbnail,
    list_images,
    set_favorite,
)
from app.services.workspace_service import WorkspaceBusyError, clear_workspace

router = APIRouter(prefix="/images", tags=["images"])


@router.get("", response_model=ImageListResponse)
def list_all(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    generation_id: int | None = Query(default=None, ge=1),
    favorite: bool = Query(default=False, description="只看收藏"),
    db: Session = Depends(get_db),
) -> ImageListResponse:
    rows, total = list_images(
        db,
        limit=limit,
        offset=offset,
        generation_id=generation_id,
        favorites_only=favorite,
    )
    return ImageListResponse(
        items=[ImageRead.model_validate(row) for row in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/{image_id}", response_model=ImageRead)
def get_image(image_id: int, db: Session = Depends(get_db)) -> ImageRead:
    image = db.get(Image, image_id)
    if image is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"image {image_id} 不存在"
        )
    return ImageRead.model_validate(image)


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
    media_type = "video/mp4" if image.media_type == "video" else "image/png"
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
    return FileResponse(
        path,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.post("/{image_id}/favorite", response_model=ImageRead)
def set_image_favorite(
    image_id: int,
    favorite: bool = Body(..., embed=True, description="true 收藏 / false 取消"),
    db: Session = Depends(get_db),
) -> ImageRead:
    """收藏或取消收藏。作品流「仅收藏」筛选依赖这个标记。"""
    image = db.get(Image, image_id)
    if image is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"image {image_id} 不存在"
        )
    return ImageRead.model_validate(set_favorite(db, image, favorite))


@router.delete("/{image_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_image(image_id: int, db: Session = Depends(get_db)) -> Response:
    image = db.get(Image, image_id)
    if image is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"image {image_id} 不存在"
        )
    delete_image(db, image)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/batch-delete", response_model=ImageBatchDeleteResponse)
def remove_images(
    payload: ImageBatchDeleteRequest,
    db: Session = Depends(get_db),
) -> ImageBatchDeleteResponse:
    """批量删除。已不存在的 id 放进 missing 而不是整批失败——多标签页同时删是常态。"""
    deleted, missing = delete_images(db, payload.ids)
    return ImageBatchDeleteResponse(deleted=deleted, missing=missing)


@router.post("/clear", response_model=WorkspaceClearResponse)
def clear_all(db: Session = Depends(get_db)) -> WorkspaceClearResponse:
    """清空工作区：删除全部图片与生成记录，并清掉 storage 下的产物。不可撤销。"""
    try:
        counts = clear_workspace(db)
    except WorkspaceBusyError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return WorkspaceClearResponse(**counts)
