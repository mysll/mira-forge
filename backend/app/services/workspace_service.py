"""工作区级别的清理：把当前项目里的生成物一次性收进回收站。

只服务一个场景——资产页的「清空工作区」。它现在也走回收站，所以：
1. 有任务在排队或生成时直接拒绝，避免把正在写的文件删掉一半；
2. 只打 `deleted_at`，文件留在磁盘上，30 天内可以在回收站里恢复；
3. 不清空模型、工作流注册表这类配置，只清生成物；
4. 真正的文件删除只发生在回收站的「立即删除 / 过期清理」。
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.generation import Generation
from app.models.image import Image
from app.models.task import GenerationTask, TaskStatus
from app.models.workflow import utcnow

_ACTIVE = (TaskStatus.QUEUED, TaskStatus.RUNNING)


class WorkspaceBusyError(RuntimeError):
    """还有任务在跑，不允许清空。"""


def count_active_tasks(db: Session) -> int:
    """还在排队/生成的任务数；回收站里的任务不算，否则一次删除就能永久挡住清空。"""
    return int(
        db.scalar(
            select(func.count())
            .select_from(GenerationTask)
            .join(Generation, GenerationTask.generation_id == Generation.id)
            .where(
                GenerationTask.status.in_(_ACTIVE),
                GenerationTask.deleted_at.is_(None),
                Generation.deleted_at.is_(None),
            )
        )
        or 0
    )


def clear_workspace(db: Session) -> dict[str, int]:
    """把全部产物、任务与批次移入回收站（不删文件）。"""
    active = count_active_tasks(db)
    if active:
        raise WorkspaceBusyError(f"还有 {active} 个任务在排队或生成，清空会丢掉它们，请先等完成或取消")

    stamp = utcnow()

    images = list(db.scalars(select(Image).where(Image.deleted_at.is_(None))).all())
    for image in images:
        image.deleted_at = stamp

    tasks = list(
        db.scalars(select(GenerationTask).where(GenerationTask.deleted_at.is_(None))).all()
    )
    for task in tasks:
        task.deleted_at = stamp

    generations = list(
        db.scalars(select(Generation).where(Generation.deleted_at.is_(None))).all()
    )
    for generation in generations:
        generation.deleted_at = stamp

    db.commit()
    return {"images": len(images), "generations": len(generations)}
