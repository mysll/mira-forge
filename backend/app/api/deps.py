"""路由层共用的取数小工具。

删除是软删（`deleted_at`），所以「按 id 取资源」不能只判 None：回收站里的行还在
库里，直接拿去做收藏、当源图、再出一次图都是错的。这里统一成 404。
"""

from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.image import Image


def live_image(db: Session, image_id: int) -> Image:
    """按 id 取一张没进回收站的图，回收站里的当它不存在。"""
    image = db.get(Image, image_id)
    if image is None or image.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"image {image_id} 不存在"
        )
    return image
