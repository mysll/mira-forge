"""生成请求的业务逻辑。

P1 只负责「校验 + 落库」：生成 N 条 pending 任务，不触碰 ComfyUI。
"""

from __future__ import annotations

import secrets
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.generation import Generation, GenerationStatus, GenerationType
from app.models.task import GenerationTask, TaskStatus
from app.models.workflow import Workflow, utcnow
from app.schemas.generation import GenerationCreate
from app.services import workflow_service

MAX_SEED = 2**31 - 1

_ACTIVE = {TaskStatus.PENDING, TaskStatus.QUEUED, TaskStatus.RUNNING}


class GenerationValidationError(ValueError):
    """请求本身合法（通过 Pydantic）但业务上不成立。"""


def aggregate_generation_status(statuses: Sequence[str]) -> GenerationStatus:
    """由子任务状态推出整体状态：还有活跃任务就跟着它，全终态再判成败。"""
    if not statuses:
        return GenerationStatus.PENDING
    active = [status for status in statuses if status in _ACTIVE]
    if active:
        if TaskStatus.RUNNING in active:
            return GenerationStatus.RUNNING
        if TaskStatus.QUEUED in active:
            return GenerationStatus.QUEUED
        return GenerationStatus.PENDING
    if all(status == TaskStatus.COMPLETED for status in statuses):
        return GenerationStatus.COMPLETED
    if any(status == TaskStatus.COMPLETED for status in statuses):
        # 部分成功仍然是可用结果：取消掉一半不该让已有的图变成「失败」
        return GenerationStatus.COMPLETED
    if all(status == TaskStatus.CANCELLED for status in statuses):
        return GenerationStatus.CANCELLED
    return GenerationStatus.FAILED


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


def new_seed(exclude: Sequence[int] = ()) -> int:
    """重试用的新 seed：保证和这一批里已有的不撞。"""
    taken = set(exclude)
    while True:
        seed = secrets.randbelow(MAX_SEED)
        if seed not in taken:
            return seed


def sync_generation_status(db: Session, generation: Generation) -> GenerationStatus:
    """按子任务状态刷新整体状态并落库。"""
    generation.status = aggregate_generation_status([task.status for task in generation.tasks])
    if generation.status == GenerationStatus.COMPLETED and generation.completed_at is None:
        generation.completed_at = utcnow()
    elif generation.status not in (GenerationStatus.COMPLETED, GenerationStatus.FAILED):
        generation.completed_at = None
    db.commit()
    return generation.status


def reset_interrupted_tasks(db: Session) -> int:
    """把上次进程退出时卡在 queued/running 的任务复位成 pending。

    Worker 是单进程内存队列，进程一死这些任务就永远不会有人捡了；
    启动时统一复位，避免界面上一排永不结束的 running。
    """
    stuck = list(
        db.scalars(
            select(GenerationTask).where(
                GenerationTask.status.in_([TaskStatus.QUEUED, TaskStatus.RUNNING])
            )
        ).all()
    )
    if not stuck:
        return 0

    touched: set[int] = set()
    for task in stuck:
        task.status = TaskStatus.PENDING
        task.progress = 0
        task.started_at = None
        task.completed_at = None
        task.comfy_prompt_id = None
        task.error_message = None
        touched.add(task.generation_id)
    db.commit()

    for generation_id in touched:
        generation = db.get(Generation, generation_id)
        if generation is not None:
            sync_generation_status(db, generation)
    return len(stuck)


def create_generation(
    db: Session, payload: GenerationCreate, *, reference_image_path: str | None = None
) -> Generation:
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

    if payload.generation_type == GenerationType.IMAGE_EDIT and not reference_image_path:
        raise GenerationValidationError("图片编辑必须提供 1 张参考图")
    if payload.generation_type == GenerationType.TEXT_TO_IMAGE:
        reference_image_path = None

    # 编辑的输出比例跟随参考图，width/height 只决定像素量级（映射到节点的 resolution）
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
        reference_image_path=reference_image_path,
    )
    for seed in _distinct_seeds(payload.count):
        generation.tasks.append(
            GenerationTask(seed=seed, status=TaskStatus.PENDING, progress=0)
        )

    db.add(generation)
    db.commit()
    db.refresh(generation)
    return generation
