"""生成记录（一次请求 = 一条 generation，含 N 个 task）。"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.database import Base
from app.models.workflow import utcnow

if TYPE_CHECKING:
    from app.models.image import Image
    from app.models.task import GenerationTask


class GenerationStatus(StrEnum):
    PENDING = "pending"
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class GenerationType(StrEnum):
    TEXT_TO_IMAGE = "text_to_image"
    # 参考图引导：参考图只进条件，潜空间仍按 width/height 新开一张
    IMAGE_TO_IMAGE = "image_to_image"
    IMAGE_EDIT = "image_edit"
    # 视频（二期）：首帧 / 尾帧都可选，两张都不给就是纯文生视频
    TEXT_TO_VIDEO = "text_to_video"
    IMAGE_TO_VIDEO = "image_to_video"

    @property
    def is_video(self) -> bool:
        return self in (GenerationType.TEXT_TO_VIDEO, GenerationType.IMAGE_TO_VIDEO)


class Generation(Base):
    __tablename__ = "generations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    workflow_id: Mapped[int | None] = mapped_column(
        ForeignKey("workflows.id", ondelete="SET NULL"), nullable=True
    )
    generation_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    model_name: Mapped[str] = mapped_column(String(64), nullable=False)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    requested_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    reference_image_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # 参考图全部路径（JSON 数组），reference_image_path 是其中第一张，方便单图端点直接用
    reference_image_paths: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 用户显式给出的生成参数；为 None 时回落到 registry.yaml 里模型默认值
    negative_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    steps: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cfg: Mapped[float | None] = mapped_column(Float, nullable=True)
    sampler: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 视频用的时长（秒）与帧率；图片任务为 None
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    fps: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=GenerationStatus.PENDING, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, index=True
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    tasks: Mapped[list["GenerationTask"]] = relationship(
        back_populates="generation",
        cascade="all, delete-orphan",
        order_by="GenerationTask.id",
        lazy="selectin",
    )
    images: Mapped[list["Image"]] = relationship(
        back_populates="generation",
        order_by="Image.id",
        lazy="selectin",
    )
