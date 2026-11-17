"""任务接口：查询、取消、重试。"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.database import get_db
from app.models.generation import Generation, GenerationStatus
from app.models.task import GenerationTask, TaskStatus
from app.models.image import Image
from app.models.workflow import utcnow
from app.schemas.generation import TaskDeleted, TaskRead
from app.services.comfyui_client import ComfyUIClient, ComfyUIError
from app.services.image_service import remove_files
from app.services.generation_service import new_seed, sync_generation_status

logger = logging.getLogger("miraforge.tasks")

router = APIRouter(prefix="/tasks", tags=["tasks"])

_FINISHED = {TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED}


def _get_task(db: Session, task_id: int) -> GenerationTask:
    task = db.get(GenerationTask, task_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"task {task_id} 不存在")
    return task


@router.get("/{task_id}", response_model=TaskRead)
def get_task(task_id: int, db: Session = Depends(get_db)) -> TaskRead:
    return TaskRead.model_validate(_get_task(db, task_id))


@router.post("/{task_id}/cancel", response_model=TaskRead)
async def cancel_task(task_id: int, db: Session = Depends(get_db)) -> TaskRead:
    """取消任务。跑着的那张会顺手打断 ComfyUI 里对应的 prompt。"""
    task = _get_task(db, task_id)
    if task.status in _FINISHED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"task {task_id} 已经结束（{task.status}），无法取消",
        )

    if task.status == TaskStatus.RUNNING and task.comfy_prompt_id:
        try:
            await ComfyUIClient().interrupt(task.comfy_prompt_id)
        except ComfyUIError as exc:
            # 打断失败不影响我们把它标记成取消：worker 会自己丢弃结果
            logger.warning("打断 ComfyUI prompt 失败（task=%s）：%s", task_id, exc)

    task.status = TaskStatus.CANCELLED
    task.error_message = "任务已取消"
    task.completed_at = utcnow()
    db.commit()

    generation = db.get(Generation, task.generation_id)
    if generation is not None:
        sync_generation_status(db, generation)
        db.refresh(task)
    return TaskRead.model_validate(task)


@router.post("/{task_id}/retry", response_model=TaskRead, status_code=status.HTTP_201_CREATED)
def retry_task(task_id: int, db: Session = Depends(get_db)) -> TaskRead:
    """重试 = 在同一个生成记录下追加一个新任务，换一个新 seed。"""
    task = _get_task(db, task_id)
    if task.status in (TaskStatus.QUEUED, TaskStatus.RUNNING):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="任务正在执行，先取消再重试",
        )

    generation = db.get(Generation, task.generation_id)
    if generation is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="生成记录已不存在，无法重试"
        )

    seed = new_seed([item.seed for item in generation.tasks])
    attempt = GenerationTask(
        generation_id=generation.id,
        seed=seed,
        status=TaskStatus.PENDING,
        progress=0,
    )
    db.add(attempt)
    generation.status = GenerationStatus.PENDING
    generation.completed_at = None
    db.commit()
    db.refresh(attempt)
    return TaskRead.model_validate(attempt)

@router.delete("/{task_id}", response_model=TaskDeleted)
def delete_task(task_id: int, db: Session = Depends(get_db)) -> TaskDeleted:
    """删除一个任务（连同它名下的产物）。

    产物被删光之后，任务会留下来占一格——用户在这里把它清掉。批次里再没有
    其它任务时，批次本身也一起删掉，避免留下点进去是空的壳。
    """
    task = _get_task(db, task_id)
    if task.status in (TaskStatus.QUEUED, TaskStatus.RUNNING):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"task {task_id} 还在执行，先取消再删除",
        )

    generation_id = task.generation_id
    images = list(db.scalars(select(Image).where(Image.task_id == task_id)).all())
    for image in images:
        remove_files(image)
        db.delete(image)

    db.delete(task)
    db.flush()

    generation_deleted = False
    remaining = db.scalar(
        select(func.count())
        .select_from(GenerationTask)
        .where(GenerationTask.generation_id == generation_id)
    )
    if not remaining:
        generation = db.get(Generation, generation_id)
        if generation is not None:
            db.delete(generation)
            generation_deleted = True

    db.commit()
    return TaskDeleted(task_id=task_id, generation_deleted=generation_deleted)
