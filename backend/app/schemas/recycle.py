"""回收站的响应模型。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class RecycleItem(BaseModel):
    id: int
    generation_id: int | None = None
    task_id: int | None = None
    file_path: str
    thumbnail_path: str | None = None
    media_type: str = "image"
    width: int = 0
    height: int = 0
    file_size: int = 0
    duration_seconds: float | None = None
    fps: float | None = None
    frame_count: int | None = None
    created_at: datetime
    deleted_at: datetime
    # 到期时间与剩余天数由服务端算好，前端不用自己减 30 天
    expires_at: datetime
    days_left: int
    prompt: str = ""
    model_name: str = ""
    generation_type: str = ""


class RecycleListResponse(BaseModel):
    items: list[RecycleItem] = Field(default_factory=list)
    total: int
    limit: int
    offset: int
    retention_days: int


class RecycleRestoreRequest(BaseModel):
    ids: list[int] = Field(default_factory=list, max_length=500)


class RecycleRestoreResponse(BaseModel):
    restored: list[int] = Field(default_factory=list)
    missing: list[int] = Field(default_factory=list)


class RecycleClearResponse(BaseModel):
    deleted: int
