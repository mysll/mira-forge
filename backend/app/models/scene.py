"""场景：一组围绕同一地点 / 事件的图。

场景是一个**隔离容器**：场景里生成的图落在 `storage/scenes/<id>/` 下，
`images.scene_id` / `generations.scene_id` 非空，默认的作品流与画廊只列
`scene_id IS NULL` 的记录，所以场景产物不会混进主图片流。
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.database import Base
from app.models.workflow import utcnow


class Scene(Base):
    __tablename__ = "scenes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    # 场景设定 / 美术说明：分层与后续生成都会把它当上下文，可为空
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 封面（images.id）；不建外键，图片被彻底删掉时只是封面没了，场景照旧
    cover_image_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, index=True
    )
    # 进回收站：场景列表里消失，目录与产物先留着
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
