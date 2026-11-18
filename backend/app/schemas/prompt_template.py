"""视频提示词模板的请求/响应模型。"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class PromptTemplateRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    label: str
    prompt: str
    sort_order: int


class PromptTemplateListResponse(BaseModel):
    items: list[PromptTemplateRead]


class PromptTemplateCreate(BaseModel):
    label: str
    prompt: str


class PromptTemplateUpdate(BaseModel):
    label: str | None = None
    prompt: str | None = None
