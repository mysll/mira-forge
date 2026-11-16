"""图片接口：列表与原始文件。"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.models.database import get_db
from app.models.image import Image
from app.schemas.image import ImageListResponse, ImageRead
from app.services.image_service import (
    ImageStoreError,
    absolute_path,
    delete_image,
    ensure_thumbnail,
    list_images,
    set_favorite,
)

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
    return FileResponse(path, media_type="image/png", filename=path.name)


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
