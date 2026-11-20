"""场景（Scene）的请求 / 响应模型。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.common import TimestampedModel


class SceneCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    # 场景设定 / 美术说明；场景里生成与以后的分层都会把它当上下文
    description: str | None = Field(default=None, max_length=4000)


class SceneUpdate(BaseModel):
    """只改传了的字段：name / description / cover_image_id。"""

    name: str | None = Field(default=None, min_length=1, max_length=60)
    description: str | None = Field(default=None, max_length=4000)
    cover_image_id: int | None = Field(default=None, ge=1)


class SceneRead(TimestampedModel):
    id: int
    name: str
    description: str | None = None
    cover_image_id: int | None = None
    # 封面的创建时间：前端拿它做缩略图 URL 的版本号，避免不同项目/不同图共用同一张缓存
    cover_image_created_at: datetime | None = None
    sort_order: int = 0
    created_at: datetime
    # 场景里有几张小图、几个批次；列表页直接用，省一次请求
    image_count: int = 0
    generation_count: int = 0


class SceneListResponse(BaseModel):
    items: list[SceneRead] = Field(default_factory=list)
    total: int


class SceneDeleted(BaseModel):
    """删除场景：场景本身软删，里面的批次与产物一起进回收站。"""

    scene_id: int
    generations: int = 0
    images: int = 0
