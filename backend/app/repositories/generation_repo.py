"""generation 数据访问。"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Integer, Select, cast, func, or_, select
from sqlalchemy.orm import Session

from app.models.generation import Generation, GenerationStatus
from app.models.image import Image


def _epoch(column) -> object:
    """把 SQLite 里的 ISO 时间转成 epoch 秒，避免时区/微秒格式差异影响比较。"""
    return cast(func.strftime("%s", column), Integer)


class GenerationRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get(self, generation_id: int) -> Generation | None:
        generation = self.db.get(Generation, generation_id)
        if generation is None or generation.deleted_at is not None:
            return None
        return generation

    def _filtered(
        self,
        *,
        q: str | None = None,
        models: list[str] | None = None,
        types: list[str] | None = None,
        favorites_only: bool = False,
        with_products: bool = False,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
    ) -> Select[tuple[Generation]]:
        # 进了回收站的批次不出现在列表里
        stmt = select(Generation).where(Generation.deleted_at.is_(None))
        if q:
            pattern = f"%{q.strip()}%"
            stmt = stmt.where(Generation.prompt.ilike(pattern))
        if models:
            stmt = stmt.where(Generation.model_name.in_(models))
        if types:
            stmt = stmt.where(Generation.generation_type.in_(types))
        if favorites_only:
            stmt = stmt.where(
                Generation.id.in_(
                    select(Image.generation_id).where(
                        Image.is_favorite.is_(True), Image.deleted_at.is_(None)
                    )
                )
            )
        if with_products:
            # 「有东西可看」= 已经有产物，或者还在排队/生成（此时卡片是占位图）。
            # 只删掉图片的批次、失败且没产物的批次都不该出现在首页和作品流里。
            busy = Generation.status.in_(
                (
                    GenerationStatus.PENDING,
                    GenerationStatus.QUEUED,
                    GenerationStatus.RUNNING,
                )
            )
            stmt = stmt.where(
                or_(
                    Generation.id.in_(
                        select(Image.generation_id).where(Image.deleted_at.is_(None))
                    ),
                    busy,
                )
            )
        if date_from is not None:
            stmt = stmt.where(_epoch(Generation.created_at) >= int(date_from.timestamp()))
        if date_to is not None:
            stmt = stmt.where(_epoch(Generation.created_at) <= int(date_to.timestamp()))
        return stmt

    def list(
        self,
        limit: int = 20,
        offset: int = 0,
        *,
        q: str | None = None,
        models: list[str] | None = None,
        types: list[str] | None = None,
        favorites_only: bool = False,
        with_products: bool = False,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
    ) -> tuple[list[Generation], int]:
        stmt = self._filtered(
            q=q,
            models=models,
            types=types,
            favorites_only=favorites_only,
            with_products=with_products,
            date_from=date_from,
            date_to=date_to,
        )
        total = self.db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
        rows = self.db.scalars(
            stmt.order_by(Generation.created_at.desc(), Generation.id.desc())
            .limit(limit)
            .offset(offset)
        ).all()
        return list(rows), total
