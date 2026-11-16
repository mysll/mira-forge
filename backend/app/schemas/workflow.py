"""工作流与模型目录的响应模型。"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.schemas.common import OrmModel


class WorkflowRead(OrmModel):
    id: int
    name: str
    type: str
    json_path: str
    config_path: str
    enabled: bool


class WorkflowListResponse(BaseModel):
    items: list[WorkflowRead]


class ModelCapabilities(BaseModel):
    """前端据此决定显示哪些参数控件，避免出现调了没用的假参数。"""

    exposes_steps: bool = True
    exposes_cfg: bool = True
    exposes_sampler: bool = True
    exposes_negative_prompt: bool = True
    sampler_options: list[str] = Field(default_factory=list)


class WorkflowTarget(BaseModel):
    type: str
    label: str
    json_path: str
    config_path: str
    validated: bool
    available: bool


class ModelInfo(BaseModel):
    id: str
    label: str
    description: str
    defaults: dict[str, Any] = Field(default_factory=dict)
    capabilities: ModelCapabilities
    workflows: list[WorkflowTarget]
    available: bool
    is_default: bool = False
    negative_prompt_cfg: float | None = None


class ModelListResponse(BaseModel):
    items: list[ModelInfo]
