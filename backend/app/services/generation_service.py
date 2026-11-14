"""生成请求的业务逻辑。

P1 只负责「校验 + 落库」：生成 N 条 pending 任务，不触碰 ComfyUI。
"""

from __future__ import annotations

import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.generation import Generation, GenerationType
from app.models.task import GenerationTask, TaskStatus
from app.models.workflow import Workflow
from app.schemas.generation import GenerationCreate
from app.services import workflow_service

MAX_SEED = 2**31 - 1


class GenerationValidationError(ValueError):
    """请求本身合法（通过 Pydantic）但业务上不成立。"""


def _distinct_seeds(count: int) -> list[int]:
    seeds: list[int] = []
    seen: set[int] = set()
    while len(seeds) < count:
        seed = secrets.randbelow(MAX_SEED)
        if seed in seen:
            continue
        seen.add(seed)
        seeds.append(seed)
    return seeds


def create_generation(db: Session, payload: GenerationCreate) -> Generation:
    settings = get_settings()
    prompt = payload.prompt.strip()
    if not prompt:
        raise GenerationValidationError("prompt 不能为空")
    if payload.count > settings.max_generation_count:
        raise GenerationValidationError(
            f"单次最多生成 {settings.max_generation_count} 张，收到 {payload.count}"
        )

    model = workflow_service.get_model(payload.model)
    if model is None:
        available = ", ".join(item.id for item in workflow_service.list_models())
        raise GenerationValidationError(f"未知模型 '{payload.model}'，可选: {available}")

    target = workflow_service.get_workflow_target(model, payload.generation_type)
    if target is None:
        raise GenerationValidationError(
            f"模型 '{model.id}' 不支持任务类型 '{payload.generation_type}'"
        )

    # 编辑链路的潜空间来自参考图编码器，宽高不生效，因此不记录宽高（见环境报告 Q4）。
    if payload.generation_type == GenerationType.IMAGE_EDIT:
        width: int | None = None
        height: int | None = None
    else:
        width = payload.width or model.defaults.get("width")
        height = payload.height or model.defaults.get("height")

    workflow_row = db.scalar(
        select(Workflow).where(Workflow.name == model.label, Workflow.type == target.type)
    )

    generation = Generation(
        prompt=prompt,
        workflow_id=workflow_row.id if workflow_row else None,
        generation_type=payload.generation_type,
        model_name=model.id,
        width=width,
        height=height,
        requested_count=payload.count,
        status="pending",
    )
    for seed in _distinct_seeds(payload.count):
        generation.tasks.append(
            GenerationTask(seed=seed, status=TaskStatus.PENDING, progress=0)
        )

    db.add(generation)
    db.commit()
    db.refresh(generation)
    return generation
