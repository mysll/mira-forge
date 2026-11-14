"""工作流参数绑定配置。

每个 ComfyUI API 图配一个 YAML，声明「MiraForge 的参数写进哪个节点的哪个输入」。
这样换工作流只改 YAML，不用改 Python；也让节点 ID 不用在代码里出现。
"""

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel, Field

from app.core.config import BACKEND_DIR


class WorkflowConfigError(ValueError):
    pass


class ParamBinding(BaseModel):
    """一个参数在图里的落点。"""

    node: str
    input: str


class ReferenceImageBinding(BaseModel):
    """参考图：先填 LoadImage.image，再把该 LoadImage 接到编码器的 AUTOGROW 输入。"""

    loader_node: str
    loader_input: str = "image"
    encoder_node: str
    encoder_input: str


class WorkflowConfig(BaseModel):
    output_node: str
    bindings: dict[str, ParamBinding] = Field(default_factory=dict)
    reference_image: ReferenceImageBinding | None = None


def resolve_workflow_path(relative: str) -> Path:
    """注册表里的路径以 backend/ 为基准。"""
    path = Path(relative)
    return path if path.is_absolute() else BACKEND_DIR / path


def load_workflow_config(relative: str) -> WorkflowConfig:
    path = resolve_workflow_path(relative)
    if not path.is_file():
        raise WorkflowConfigError(f"工作流配置不存在：{relative}")
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise WorkflowConfigError(f"工作流配置 {relative} 不是合法 YAML：{exc}") from exc
    try:
        return WorkflowConfig.model_validate(raw)
    except Exception as exc:  # pydantic.ValidationError
        raise WorkflowConfigError(f"工作流配置 {relative} 结构不正确：{exc}") from exc
