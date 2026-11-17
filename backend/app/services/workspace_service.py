"""工作区级别的清理：把库里与磁盘上的生成物一次清空。

只服务一个场景——资产页的「清空工作区」。它是不可撤销的，所以：
1. 有任务在排队或生成时直接拒绝，避免把正在写的文件删掉一半；
2. 先删文件再删库，库里的记录永远是磁盘状态的超集，不会出现「记录还在但文件没了」；
3. 不清空模型、工作流注册表这类配置，只清生成物。
"""

from __future__ import annotations

import shutil

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.models.generation import Generation
from app.models.image import Image
from app.models.task import GenerationTask, TaskStatus
from app.services.image_service import remove_files, storage_root_for

_ACTIVE = (TaskStatus.QUEUED, TaskStatus.RUNNING)
_CLEARED_DIRS = ("images", "videos", "assets", "thumbnails", "uploads")


class WorkspaceBusyError(RuntimeError):
    """还有任务在跑，不允许清空。"""


def count_active_tasks(db: Session) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(GenerationTask)
            .where(GenerationTask.status.in_(_ACTIVE))
        )
        or 0
    )


def clear_workspace(db: Session) -> dict[str, int]:
    """删除全部图片与生成记录，并清空 storage 下的产物目录。"""
    active = count_active_tasks(db)
    if active:
        raise WorkspaceBusyError(f"还有 {active} 个任务在排队或生成，清空会丢掉它们，请先等完成或取消")

    images = list(db.scalars(select(Image)).all())
    for image in images:
        remove_files(image)

    generation_count = int(db.scalar(select(func.count()).select_from(Generation)) or 0)

    # 顺序不能反：images → generation_tasks → generations，外键才不会拦
    db.execute(delete(Image))
    db.execute(delete(GenerationTask))
    db.execute(delete(Generation))
    db.commit()

    storage_root = storage_root_for()
    for name in _CLEARED_DIRS:
        shutil.rmtree(storage_root / name, ignore_errors=True)
        (storage_root / name).mkdir(parents=True, exist_ok=True)

    return {"images": len(images), "generations": generation_count}
