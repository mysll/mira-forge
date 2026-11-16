"""generation 数据访问。"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Integer, Select, cast, func, select
from sqlalchemy.orm import Session

from app.models.generation import Generation
from app.models.image import Image


def _epoch(column) -> object:
    """把 SQLite 里的 ISO 时间转成 epoch 秒，避免时区/微秒格式差异影响比较。"""
    return cast(func.strftime("%s", column), Integer)


class GenerationRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get(self, generation_id: int) -> Generation | None:
        return self.db.get(Generation, generation_id)

    def _filtered(
        self,
        *,
        q: str | None = None,
        models: list[str] | None = None,
        favorites_only: bool = False,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
    ) -> Select[tuple[Generation]]:
        stmt = select(Generation)
        if q:
            pattern = f"%{q.strip()}%"
            stmt = stmt.where(Generation.prompt.ilike(pattern))
        if models:
            stmt = stmt.where(Generation.model_name.in_(models))
        if favorites_only:
            stmt = stmt.where(
                Generation.id.in_(
                    select(Image.generation_id).where(Image.is_favorite.is_(True))
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
        favorites_only: bool = False,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
    ) -> tuple[list[Generation], int]:
        stmt = self._filtered(
            q=q,
            models=models,
            favorites_only=favorites_only,
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
