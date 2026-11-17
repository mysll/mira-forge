"""回收站：所有删除都变成软删除，30 天内可以恢复。

设计取舍：
1. **删除只打时间戳**，文件留在磁盘上，恢复就是把 `deleted_at` 清掉——不需要备份目录，
   也不会出现「记录恢复了但文件已经没了」；
2. **过期清理是唯一真正删文件的地方**（`purge_expired`），由启动时与打开回收站时触发，
   不引入常驻定时器：本地单机没有必须准点执行的业务；
3. 恢复单个产物时**连带把它所属的任务与批次一起救回来**——否则图恢复了却卡在一个
   被标记删除的批次里，界面上还是看不见；
4. 批次被整批删除时才标记 `generation.deleted_at`；只删了其中几张的话批次仍在，
   当它所有产物都被删掉时，作品流里显示成「无产物」的占位卡（用户可以再删那一格）。
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Iterable, Sequence

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.generation import Generation
from app.models.image import Image
from app.models.task import GenerationTask
from app.models.workflow import utcnow
from app.services.image_service import remove_files

# 进回收站后保留多少天；到期后由 purge_expired 从磁盘上真正删掉
RETENTION_DAYS = 30


def _naive_utc(value: datetime) -> datetime:
    """SQLite 读回来的时间可能没有时区，统一成 naive UTC 再比较。"""
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def expires_at(deleted_at: datetime, days: int = RETENTION_DAYS) -> datetime:
    """回收站里这条记录的过期时间（UTC，带时区）。"""
    return _naive_utc(deleted_at) + timedelta(days=days)


def days_left(deleted_at: datetime, days: int = RETENTION_DAYS) -> int:
    """还剩几天到期（不满一天算一天）；已过期返回 0。"""
    remaining = expires_at(deleted_at, days) - _naive_utc(utcnow())
    if remaining.total_seconds() <= 0:
        return 0
    return max(1, math.ceil(remaining.total_seconds() / 86400))


def soft_delete_images(db: Session, images: Iterable[Image]) -> list[int]:
    """把一批产物放进回收站（不删文件）。已经删过的跳过。"""
    stamp = utcnow()
    moved: list[int] = []
    for image in images:
        if image.deleted_at is not None:
            continue
        image.deleted_at = stamp
        moved.append(image.id)
    db.commit()
    return sorted(moved)


def soft_delete_task(db: Session, task: GenerationTask) -> int:
    """删一个任务：它的产物进回收站，任务本身也标记删除。返回产物数量。"""
    moved = soft_delete_images(db, task.generation.images if task.generation else [])
    if task.deleted_at is None:
        task.deleted_at = utcnow()
        db.commit()
    return len(moved)


def soft_delete_generation(db: Session, generation: Generation) -> int:
    """删一个批次：产物、任务、批次记录一起进回收站。返回产物数量。"""
    stamp = utcnow()
    count = 0
    for image in generation.images:
        if image.deleted_at is None:
            image.deleted_at = stamp
            count += 1
    for task in generation.tasks:
        if task.deleted_at is None:
            task.deleted_at = stamp
    if generation.deleted_at is None:
        generation.deleted_at = stamp
    db.commit()
    return count


def list_bin(
    db: Session,
    *,
    limit: int = 60,
    offset: int = 0,
    media: str | None = None,
) -> tuple[list[Image], int]:
    """回收站列表，最近删的在前。"""
    conditions = [Image.deleted_at.is_not(None)]
    if media:
        conditions.append(Image.media_type == media)

    count_stmt = select(func.count()).select_from(Image)
    stmt = select(Image)
    for condition in conditions:
        count_stmt = count_stmt.where(condition)
        stmt = stmt.where(condition)

    total = db.scalar(count_stmt) or 0
    rows = list(
        db.scalars(
            stmt.order_by(Image.deleted_at.desc(), Image.id.desc())
            .limit(limit)
            .offset(offset)
        ).all()
    )
    return rows, total


def restore_images(db: Session, image_ids: Sequence[int]) -> tuple[list[int], list[int]]:
    """从回收站恢复。返回 (恢复的 id, 本来就不在回收站的 id)。

    连带把所属任务与批次解冻：否则图回来了，作品流里还是看不见它。
    """
    wanted = list(dict.fromkeys(int(image_id) for image_id in image_ids))
    if not wanted:
        return [], []

    rows = list(db.scalars(select(Image).where(Image.id.in_(wanted))).all())
    restored: list[int] = []
    for image in rows:
        if image.deleted_at is None:
            continue
        image.deleted_at = None
        restored.append(image.id)
        if image.task_id is not None:
            task = db.get(GenerationTask, image.task_id)
            if task is not None and task.deleted_at is not None:
                task.deleted_at = None
        if image.generation_id is not None:
            generation = db.get(Generation, image.generation_id)
            if generation is not None and generation.deleted_at is not None:
                generation.deleted_at = None

    db.commit()
    return sorted(restored), sorted(set(wanted) - set(restored))


def delete_forever(db: Session, image: Image) -> None:
    """从回收站彻底删除单条：删文件 + 删记录。"""
    remove_files(image)
    db.delete(image)
    db.commit()
    _drop_empty_generations(db)


def clear_bin(db: Session, *, media: str | None = None) -> int:
    """清空回收站：把里面所有产物立刻删掉（文件也删）。返回删除数量。"""
    conditions = [Image.deleted_at.is_not(None)]
    if media:
        conditions.append(Image.media_type == media)
    stmt = select(Image)
    for condition in conditions:
        stmt = stmt.where(condition)
    rows = list(db.scalars(stmt).all())

    for image in rows:
        remove_files(image)
        db.delete(image)
    db.commit()
    _drop_empty_generations(db)
    return len(rows)


def purge_expired(db: Session, *, days: int = RETENTION_DAYS) -> int:
    """把过期（默认 30 天）的回收站条目真正删掉。返回删除数量。"""
    cutoff = _naive_utc(utcnow()) - timedelta(days=days)
    rows = [
        image
        for image in db.scalars(select(Image).where(Image.deleted_at.is_not(None))).all()
        if _naive_utc(image.deleted_at) <= cutoff  # type: ignore[arg-type]
    ]
    if not rows:
        return 0

    for image in rows:
        remove_files(image)
        db.delete(image)
    db.commit()
    _drop_empty_generations(db)
    return len(rows)


def _drop_empty_generations(db: Session) -> int:
    """已经进回收站、且一件产物都不剩的批次，连它的任务一起删掉。"""
    removed = 0
    for generation in db.scalars(select(Generation).where(Generation.deleted_at.is_not(None))).all():
        if generation.images:
            continue
        db.delete(generation)
        removed += 1
    if removed:
        db.commit()
    return removed
