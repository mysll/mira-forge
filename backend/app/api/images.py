"""图片接口：列表与原始文件。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.models.database import get_db
from app.models.image import Image
from app.schemas.image import ImageListResponse, ImageRead
from app.services.image_service import absolute_path, list_images

router = APIRouter(prefix="/images", tags=["images"])


@router.get("", response_model=ImageListResponse)
def list_all(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    generation_id: int | None = Query(default=None, ge=1),
    db: Session = Depends(get_db),
) -> ImageListResponse:
    rows, total = list_images(db, limit=limit, offset=offset, generation_id=generation_id)
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
