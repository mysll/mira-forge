"""元素提取的请求 / 响应模型。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.common import TimestampedModel
from app.schemas.generation import ImageBrief
from app.schemas.layer import LLMExchangeEntry


class ElementRead(TimestampedModel):
    id: int
    set_id: int
    kind: str = "prop"
    name: str
    key: str
    anchor: str = "top"
    note: str | None = None
    prompt: str | None = None
    status: str = "draft"
    sort_order: int = 0
    # 最近一次提取出来的小图；还没出图就是 None
    image_id: int | None = None
    # 用户在图集里指定使用的那张；为空时用最近一次出图
    selected_image_id: int | None = None
    # 这件元素被加进了几个图集（页签上显示「已在图集」用）
    kit_count: int = 0
    # 这件被放进过哪些图集（前端据此判断「在不在当前选中的图集里」）
    kit_ids: list[int] = Field(default_factory=list)
    # 这件是否手画过遮罩（有的话出图会按遮罩裁参考图）
    has_mask: bool = False
    # 那张图是不是真的透明背景（模型偶尔会交出整张不透明图）
    has_alpha: bool = False
    created_at: datetime


class ElementSetCreate(BaseModel):
    source_image_id: int = Field(ge=1)
    brief: str | None = Field(default=None, max_length=4000)


class ElementSetRead(TimestampedModel):
    id: int
    scene_id: int
    source_image_id: int | None = None
    source_image: ImageBrief | None = None
    status: str = "analyzing"
    brief: str | None = None
    error_message: str | None = None
    created_at: datetime
    completed_at: datetime | None = None
    elements: list[ElementRead] = Field(default_factory=list)
    # 和分层一样：每轮请求与应答，前端按「对话」展示
    llm_exchange: list[LLMExchangeEntry] = Field(default_factory=list)


class ElementSetListResponse(BaseModel):
    items: list[ElementSetRead] = Field(default_factory=list)
    total: int


class ElementUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    key: str | None = Field(default=None, min_length=1, max_length=60, pattern="^[a-z0-9_]+$")
    anchor: str | None = Field(default=None, pattern="^(top|bottom)$")
    note: str | None = Field(default=None, max_length=200)
    prompt: str | None = Field(default=None, max_length=4000)
    selected_image_id: int | None = Field(default=None, ge=1)


class ElementSetDeleted(BaseModel):
    set_id: int
    elements: int = 0


class ElementExtractPayload(BaseModel):
    """给选中的元素逐件排一次图片编辑。"""

    element_ids: list[int] = Field(min_length=1)
    count: int = Field(default=1, ge=1, le=4)
    model: str | None = None
    prompt_suffix: str | None = Field(default=None, max_length=2000)
    negative_prompt: str | None = Field(default=None, max_length=2000)
    seed: int | None = Field(default=None, ge=0)
    steps: int | None = Field(default=None, ge=1, le=100)
    cfg: float | None = Field(default=None, ge=0, le=30)
    sampler: str | None = Field(default=None, max_length=40)
