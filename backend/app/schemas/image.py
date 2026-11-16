"""生成产物图片的响应模型。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.common import OrmModel


class ImageRead(OrmModel):
    id: int
    task_id: int | None = None
    generation_id: int | None = None
    file_path: str
    thumbnail_path: str | None = None
    original_image_id: int | None = None
    width: int
    height: int
    file_size: int
    is_favorite: bool = False
    created_at: datetime


class ImageListResponse(BaseModel):
    items: list[ImageRead] = Field(default_factory=list)
    total: int
    limit: int
    offset: int


class ImageBatchDeleteRequest(BaseModel):
    ids: list[int] = Field(default_factory=list, max_length=500)


class ImageBatchDeleteResponse(BaseModel):
    deleted: list[int] = Field(default_factory=list)
    missing: list[int] = Field(default_factory=list)


class WorkspaceClearResponse(BaseModel):
    images: int
    generations: int
