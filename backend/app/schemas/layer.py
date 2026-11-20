"""分层的请求 / 响应模型。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.common import TimestampedModel
from app.schemas.generation import GenerationRead


class LayerSetCreate(BaseModel):
    """在某个场景里发起一次分层分析。"""

    source_image_id: int = Field(ge=1)
    model: str = Field(min_length=1, max_length=80)
    # 0 = 让 LLM 自己决定（3–8 层）
    layer_count: int = Field(default=0, ge=0, le=8)
    count_per_layer: int = Field(default=1, ge=1, le=4)
    # 创作者需求：剧情、镜头、要区分开的东西
    brief: str | None = Field(default=None, max_length=8000)
    negative_prompt: str | None = Field(default=None, max_length=2000)


class LayerRead(TimestampedModel):
    id: int
    set_id: int
    ord: int
    key: str
    name: str
    role: str | None = None
    scroll_scale: float
    z_index: int
    prompt: str
    negative_prompt: str | None = None
    occluded_by: str | None = None
    supports: str | None = None
    note: str | None = None
    generation_id: int | None = None
    # 导出时用哪一张；空 = 这一层最新的那张
    selected_image_id: int | None = None
    status: str
    created_at: datetime


class LayerUpdate(BaseModel):
    """层卡上能改的字段；只改传了的。"""

    name: str | None = Field(default=None, min_length=1, max_length=60)
    prompt: str | None = Field(default=None, min_length=1, max_length=8000)
    negative_prompt: str | None = Field(default=None, max_length=2000)
    scroll_scale: float | None = Field(default=None, ge=0.05, le=1.3)
    z_index: int | None = Field(default=None, ge=-9999, le=9999)
    # 指定这一层导出用哪一张（传 null = 回到「用最新的那张」）
    selected_image_id: int | None = Field(default=None, ge=1)


class LLMExchangeEntry(BaseModel):
    """一次发给 LLM 的请求和它的应答（前端按对话展示）。"""

    attempt: int = 1
    system: str = ""
    user: str = ""
    has_image: bool = False
    response: str = ""
    error: str | None = None
    duration_ms: int | None = None


class LayerSetRead(TimestampedModel):
    id: int
    scene_id: int
    source_image_id: int | None = None
    model_name: str
    layer_count: int
    count_per_layer: int
    brief: str | None = None
    negative_prompt: str | None = None
    status: str
    error_message: str | None = None
    llm_meta: str | None = None
    llm_exchange: list[LLMExchangeEntry] = Field(default_factory=list)
    created_at: datetime
    completed_at: datetime | None = None
    layers: list[LayerRead] = Field(default_factory=list)


class LayerSetListResponse(BaseModel):
    items: list[LayerSetRead] = Field(default_factory=list)
    total: int


class LayerRenderCreate(BaseModel):
    """按层出图：参考图固定是分层源图，只调这一批的参数。"""

    count: int = Field(default=1, ge=1, le=4)
    # 不给就用图层里存的提示词；给了并且 save_prompt=True 会顺手写回图层，
    # 这样「在底部输入框改一版再生成」就等于改了这一层的提示词。
    prompt: str | None = Field(default=None, min_length=1, max_length=8000)
    negative_prompt: str | None = Field(default=None, max_length=2000)
    model: str | None = Field(default=None, max_length=64)
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)
    steps: int | None = Field(default=None, ge=1, le=100)
    cfg: float | None = Field(default=None, ge=0, le=30)
    sampler: str | None = Field(default=None, max_length=64)
    save_prompt: bool = True


class LayerRenderAllResult(BaseModel):
    """「生成所有层」的结果：每一层各排一条批次。"""

    generations: list[GenerationRead] = Field(default_factory=list)
    submitted: int = 0
    images: int = 0
    skipped: list[str] = Field(default_factory=list)
