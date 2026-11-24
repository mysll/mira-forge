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
        scene_id: int | None = None,
        layer_id: int | None = None,
        element_id: int | None = None,
        exclude_scene: bool = False,
        exclude_layer: bool = False,
        exclude_element: bool = False,
    ) -> Select[tuple[Generation]]:
        # 进了回收站的批次不出现在列表里
        stmt = select(Generation).where(Generation.deleted_at.is_(None))
        # 场景产物靠类型隔离（media=image 的查询不含 scene / scene_layer），
        # 这里只做「显式按场景取」的收窄，不再默认排除。
        if scene_id is not None:
            stmt = stmt.where(Generation.scene_id == scene_id)
        # 分层页签只关心自己这一层出的图
        if layer_id is not None:
            stmt = stmt.where(Generation.layer_id == layer_id)
        # 元素页签只要这个元素出的图
        if element_id is not None:
            stmt = stmt.where(Generation.element_id == element_id)
        if exclude_scene:
            stmt = stmt.where(Generation.generation_type.not_in(("scene", "scene_layer")))
        if exclude_layer:
            # 场景页 / 首页只要「场景底图」，不要每个层各自的那一批
            stmt = stmt.where(Generation.layer_id.is_(None))
        if exclude_element:
            # 元素提取的产物只属于「元素」页签，不进场景信息流 / 首页 / 资产
            stmt = stmt.where(Generation.element_id.is_(None))
            stmt = stmt.where(Generation.generation_type != "element")
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
        scene_id: int | None = None,
        layer_id: int | None = None,
        element_id: int | None = None,
        exclude_scene: bool = False,
        exclude_layer: bool = False,
        exclude_element: bool = False,
    ) -> tuple[list[Generation], int]:
        stmt = self._filtered(
            q=q,
            models=models,
            types=types,
            favorites_only=favorites_only,
            with_products=with_products,
            date_from=date_from,
            date_to=date_to,
            scene_id=scene_id,
            layer_id=layer_id,
            element_id=element_id,
            exclude_scene=exclude_scene,
            exclude_layer=exclude_layer,
            exclude_element=exclude_element,
        )
        total = self.db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
        rows = self.db.scalars(
            stmt.order_by(Generation.created_at.desc(), Generation.id.desc())
            .limit(limit)
            .offset(offset)
        ).all()
        return list(rows), total
