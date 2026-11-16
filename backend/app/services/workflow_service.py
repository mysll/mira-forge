"""模型 / 工作流注册表服务。

唯一职责：读 workflow_configs/registry.yaml，解析成带可用性判断的模型目录，
并把条目同步进 workflows 表（供 /api/v1/workflows 使用）。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import BACKEND_DIR
from app.models.workflow import Workflow
from app.schemas.workflow import ModelCapabilities, ModelInfo, WorkflowTarget

REGISTRY_PATH = BACKEND_DIR / "workflow_configs" / "registry.yaml"


class RegistryError(RuntimeError):
    """注册表缺失或格式非法。"""


class _WorkflowSpec(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: str
    label: str
    json_path: str = Field(alias="json")
    config: str
    validated: bool = False


class _ModelSpec(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    label: str
    description: str = ""
    is_default: bool = Field(default=False, alias="default")
    # 负面提示词需要 CFG > 1 才会被 ComfyUI 计算（cfg=1 时走 cfg1 优化，uncond 被跳过）。
    # 这个值是「用户没显式给 CFG 时的自动值」，None 表示该模型不支持负面提示词。
    negative_prompt_cfg: float | None = None
    defaults: dict[str, Any] = Field(default_factory=dict)
    capabilities: ModelCapabilities = Field(default_factory=ModelCapabilities)
    workflows: list[_WorkflowSpec] = Field(default_factory=list)


class _Registry(BaseModel):
    version: int = 1
    models: list[_ModelSpec] = Field(default_factory=list)


def _resolve(relative: str) -> Path:
    path = Path(relative)
    return path if path.is_absolute() else (BACKEND_DIR / path).resolve()


# KSampler / KSamplerSelect 里最常用的一批采样器（ComfyUI object_info 的 45 项里挑的）
SAMPLER_OPTIONS = (
    "euler",
    "euler_ancestral",
    "heun",
    "dpm_2",
    "dpm_2_ancestral",
    "lms",
    "dpmpp_2m",
    "dpmpp_2m_sde",
    "dpmpp_3m_sde",
    "ddim",
    "uni_pc",
    "res_multistep",
)


def load_registry() -> _Registry:
    if not REGISTRY_PATH.is_file():
        raise RegistryError(f"找不到模型注册表: {REGISTRY_PATH}")
    raw = yaml.safe_load(REGISTRY_PATH.read_text(encoding="utf-8")) or {}
    return _Registry.model_validate(raw)


def _to_model_info(spec: _ModelSpec) -> ModelInfo:
    targets: list[WorkflowTarget] = []
    for workflow in spec.workflows:
        json_path = _resolve(workflow.json_path)
        targets.append(
            WorkflowTarget(
                type=workflow.type,
                label=workflow.label,
                json_path=json_path.as_posix(),
                config_path=_resolve(workflow.config).as_posix(),
                validated=workflow.validated,
                available=json_path.is_file(),
            )
        )
    capabilities = spec.capabilities.model_copy(
        update={
            "sampler_options": list(SAMPLER_OPTIONS)
            if spec.capabilities.exposes_sampler
            else []
        }
    )
    return ModelInfo(
        id=spec.id,
        label=spec.label,
        description=spec.description,
        defaults=spec.defaults,
        capabilities=capabilities,
        workflows=targets,
        available=any(target.available for target in targets),
        is_default=spec.is_default,
        negative_prompt_cfg=spec.negative_prompt_cfg,
    )


def list_models() -> list[ModelInfo]:
    return [_to_model_info(spec) for spec in load_registry().models]


def get_model(model_id: str) -> ModelInfo | None:
    for model in list_models():
        if model.id == model_id:
            return model
    return None


def get_workflow_target(model: ModelInfo, generation_type: str) -> WorkflowTarget | None:
    for target in model.workflows:
        if target.type == generation_type:
            return target
    return None


def sync_workflows(db: Session) -> int:
    """把注册表条目写进 workflows 表；(name, type) 为幂等键。返回写入条数。"""
    written = 0
    for spec in load_registry().models:
        for workflow in spec.workflows:
            json_path = _resolve(workflow.json_path)
            config_path = _resolve(workflow.config)
            existing = db.scalar(
                select(Workflow).where(Workflow.name == spec.label, Workflow.type == workflow.type)
            )
            if existing is None:
                db.add(
                    Workflow(
                        name=spec.label,
                        type=workflow.type,
                        json_path=json_path.as_posix(),
                        config_path=config_path.as_posix(),
                        enabled=json_path.is_file(),
                    )
                )
            else:
                existing.json_path = json_path.as_posix()
                existing.config_path = config_path.as_posix()
                existing.enabled = json_path.is_file()
            written += 1
    db.commit()
    return written
