"""生成产物（图片 / 视频）的响应模型。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.common import OrmModel


class ImageRead(OrmModel):
    id: int
    task_id: int | None = None
    generation_id: int | None = None
    # 所属场景（scenes.id）；非空的产物不进主图片流
    scene_id: int | None = None
    file_path: str
    thumbnail_path: str | None = None
    original_image_id: int | None = None
    width: int
    height: int
    file_size: int
    # image | video：视频多出时长、帧率、帧数与封面图（thumbnail_path）
    media_type: str = "image"
    duration_seconds: float | None = None
    fps: float | None = None
    frame_count: int | None = None
    is_favorite: bool = False
    created_at: datetime
    # 「批次名 · 第 N 个」——批次没起名就是「批次 #id · 第 N 个」，列表里用来区分同款产物
    label: str = ""


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
