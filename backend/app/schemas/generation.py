"""生成任务的请求/响应模型。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.models.generation import GenerationType
from app.schemas.common import TimestampedModel


class GenerationCreate(BaseModel):
    """创建一次生成请求。model 为 /api/v1/models 返回的模型 id，不写死具体模型。

    可选参数（negative_prompt / seed / steps / cfg / sampler）为 None 时沿用
    registry.yaml 里模型默认值；seed 为 None 表示每张随机。
    """

    prompt: str = Field(min_length=1, max_length=8000)
    model: str = Field(min_length=1, max_length=64)
    generation_type: GenerationType = GenerationType.TEXT_TO_IMAGE
    width: int | None = Field(default=None, ge=64, le=4096)
    height: int | None = Field(default=None, ge=64, le=4096)
    count: int = Field(default=1, ge=1)
    negative_prompt: str | None = Field(default=None, max_length=8000)
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)
    steps: int | None = Field(default=None, ge=1, le=100)
    cfg: float | None = Field(default=None, ge=0, le=30)
    sampler: str | None = Field(default=None, max_length=64)
    # 视频：时长（秒）与帧率；图片任务留空
    duration_seconds: float | None = Field(default=None, ge=1, le=30)
    fps: float | None = Field(default=None, ge=1, le=120)


class TaskRead(TimestampedModel):
    id: int
    generation_id: int
    # 本地编辑不采样，所以 seed 可能为空
    seed: int | None = None
    status: str
    comfy_prompt_id: str | None = None
    progress: int
    error_message: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None


class ImageBrief(BaseModel):
    """作品流里每张图需要的字段；seed 由前端按 task_id 关联 tasks 得到。"""

    model_config = {"from_attributes": True}

    id: int
    task_id: int | None = None
    width: int
    height: int
    file_size: int
    file_path: str = ""
    # image | video | asset
    media_type: str = "image"
    duration_seconds: float | None = None
    fps: float | None = None
    frame_count: int | None = None
    is_favorite: bool = False
    created_at: datetime


class GenerationRead(TimestampedModel):
    id: int
    prompt: str
    negative_prompt: str | None = None
    workflow_id: int | None = None
    generation_type: str
    model_name: str
    width: int | None = None
    height: int | None = None
    requested_count: int
    status: str
    progress: int = 0
    reference_image_path: str | None = None
    # 该次生成用到的全部参考图（相对 STORAGE_DIR）；第一张与 reference_image_path 相同
    reference_images: list[str] = Field(default_factory=list)
    # 局部编辑是否带遮罩（遮罩字节走 GET /generations/{id}/mask）
    has_mask: bool = False
    steps: int | None = None
    cfg: float | None = None
    sampler: str | None = None
    duration_seconds: float | None = None
    fps: float | None = None
    created_at: datetime
    completed_at: datetime | None = None
    tasks: list[TaskRead] = Field(default_factory=list)
    images: list[ImageBrief] = Field(default_factory=list)


class GenerationListResponse(BaseModel):
    items: list[GenerationRead]
    total: int
    limit: int
    offset: int


class TaskDeleted(BaseModel):
    """删除单个任务的结果。批次里一个任务都不剩时，批次也一起清掉。"""

    task_id: int
    generation_deleted: bool = False
