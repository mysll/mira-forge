"""生成任务的请求/响应模型。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.models.generation import GenerationType
from app.schemas.common import TimestampedModel


class GenerationCreate(BaseModel):
    """创建一次生成请求。model 为 /api/v1/models 返回的模型 id，不写死具体模型。"""

    prompt: str = Field(min_length=1, max_length=8000)
    model: str = Field(min_length=1, max_length=64)
    generation_type: GenerationType = GenerationType.TEXT_TO_IMAGE
    width: int | None = Field(default=None, ge=64, le=4096)
    height: int | None = Field(default=None, ge=64, le=4096)
    count: int = Field(default=1, ge=1)


class TaskRead(TimestampedModel):
    id: int
    generation_id: int
    seed: int
    status: str
    comfy_prompt_id: str | None = None
    progress: int
    error_message: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None


class GenerationRead(TimestampedModel):
    id: int
    prompt: str
    workflow_id: int | None = None
    generation_type: str
    model_name: str
    width: int | None = None
    height: int | None = None
    requested_count: int
    status: str
    created_at: datetime
    completed_at: datetime | None = None
    tasks: list[TaskRead] = Field(default_factory=list)


class GenerationSummary(TimestampedModel):
    id: int
    prompt: str
    generation_type: str
    model_name: str
    width: int | None = None
    height: int | None = None
    requested_count: int
    status: str
    progress: int = 0
    created_at: datetime
    completed_at: datetime | None = None
    task_count: int = 0


class GenerationListResponse(BaseModel):
    items: list[GenerationSummary]
    total: int
    limit: int
    offset: int
