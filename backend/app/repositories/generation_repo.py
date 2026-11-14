"""generation 数据访问。"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.generation import Generation


class GenerationRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get(self, generation_id: int) -> Generation | None:
        return self.db.get(Generation, generation_id)

    def list(self, limit: int = 20, offset: int = 0) -> tuple[list[Generation], int]:
        total = self.db.scalar(select(func.count()).select_from(Generation)) or 0
        rows = self.db.scalars(
            select(Generation)
            .order_by(Generation.created_at.desc(), Generation.id.desc())
            .limit(limit)
            .offset(offset)
        ).all()
        return list(rows), total
