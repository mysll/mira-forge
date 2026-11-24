"""图集：把项目里已有的透明图打包成一张 atlas + 坐标表。"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.database import Base


def _utcnow() -> datetime:
    return datetime.utcnow()


class Kit(Base):
    __tablename__ = "kits"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    padding: Mapped[int] = mapped_column(Integer, nullable=False, default=4)
    max_width: Mapped[int] = mapped_column(Integer, nullable=False, default=2048)
    cell: Mapped[int] = mapped_column(Integer, nullable=False, default=64)
    # 从某个场景的「元素提取」页顺手建出来的图集，记一下归属，方便页面默认选中
    scene_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, index=True
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )

    items: Mapped[list["KitItem"]] = relationship(
        back_populates="kit",
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="KitItem.sort_order",
    )


class KitItem(Base):
    __tablename__ = "kit_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kit_id: Mapped[int] = mapped_column(
        ForeignKey("kits.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # 两个来源二选一：项目里已有的图（image），或元素提取裁出来的小图（element）
    image_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    element_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    key: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    anchor: Mapped[str] = mapped_column(String(10), nullable=False, default="top")
    note: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # 进图集前先把这张缩小/放大到这个比例（1.0 = 原尺寸），用来统一各件的视觉尺寸
    scale: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )

    kit: Mapped[Kit] = relationship(back_populates="items")
