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


class LoaderBinding(BaseModel):
    """一张参考图的入口节点。"""

    node: str
    input: str = "image"


class ReferenceImageBinding(BaseModel):
    """参考图：先填 LoadImage.image，再把该 LoadImage 接到编码器的 AUTOGROW 输入。

    键名本身带序号（`images.image_1`），第 n 张按序号顺延，所以 loaders 的顺序
    就是图里输入的先后顺序。单图工作流可以只写 loader_node，与旧配置兼容。
    """

    encoder_node: str
    encoder_input: str
    loaders: list[LoaderBinding] = Field(default_factory=list)
    loader_node: str | None = None
    loader_input: str = "image"

    def slots(self) -> list[LoaderBinding]:
        if self.loaders:
            return list(self.loaders)
        if self.loader_node:
            return [LoaderBinding(node=self.loader_node, input=self.loader_input)]
        return []


class FrameBinding(BaseModel):
    """视频的首帧 / 尾帧：两个 LoadImage 分别接到同一个节点的两个固定输入。

    与 reference_image 的区别是这里不按序号顺延——首帧和尾帧语义不同，
    而且两张都可以缺席（都缺席就退化成文生视频）。
    """

    node: str
    first_input: str = "first_frame"
    last_input: str = "last_frame"
    first_loader: str | None = None
    last_loader: str | None = None

    def loader_for(self, which: str) -> str | None:
        return self.first_loader if which == "first" else self.last_loader

    def input_for(self, which: str) -> str:
        return self.first_input if which == "first" else self.last_input


class WorkflowConfig(BaseModel):
    output_node: str
    # 视频工作流额外产出一张封面图（第 0 帧），用来做缩略图
    poster_node: str | None = None
    bindings: dict[str, ParamBinding] = Field(default_factory=dict)
    reference_image: ReferenceImageBinding | None = None
    frames: FrameBinding | None = None


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
