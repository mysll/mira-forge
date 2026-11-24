"""场景分层：一次「分析」产出一套层方案（LayerSet），方案里是若干层（Layer）。

分层只在**场景**里做：`layer_sets.scene_id` 一定指向一个场景，源图是该场景里的
一张成品图。层方案本身不烧 GPU——它只是 LLM 写完的一组提示词；真正出图在
P2 按层建 `generation`（类型 `scene_layer`）。
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.database import Base
from app.models.workflow import utcnow


class LayerSetStatus(str, Enum):
    """套层方案的状态：分析中 → 已出方案 / 失败。"""

    ANALYZING = "analyzing"
    PLANNED = "planned"
    FAILED = "failed"


class LayerSet(Base):
    __tablename__ = "layer_sets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    scene_id: Mapped[int] = mapped_column(
        ForeignKey("scenes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # 源图（images.id）：本场景里挑的一张贴图，分层与每层编辑都以它做参考
    source_image_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    model_name: Mapped[str] = mapped_column(String(80), nullable=False)
    # 0 / None 表示「让 LLM 自己决定层数」
    layer_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    count_per_layer: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    # 创作者需求：会原样带进 LLM 的 user 消息
    brief: Mapped[str | None] = mapped_column(Text, nullable=True)
    negative_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=LayerSetStatus.ANALYZING.value, index=True
    )
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 调 LLM 的元信息：模型、耗时、原始返回（截断）、重试次数，排错用
    llm_meta: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, index=True
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )

    layers: Mapped[list["Layer"]] = relationship(
        back_populates="layer_set",
        cascade="all, delete-orphan",
        order_by="Layer.ord",
        lazy="selectin",
    )


class Layer(Base):
    __tablename__ = "layers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    set_id: Mapped[int] = mapped_column(
        ForeignKey("layer_sets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # 从后到前：0 是最远的背景壳
    ord: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    key: Mapped[str] = mapped_column(String(40), nullable=False)
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    # 这一层在画面里承担什么（一句话，层卡上显示）
    role: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # 引擎槽位：far / mid / near / gameplay / foreground，见 services/layer_slots.py
    slot: Mapped[str] = mapped_column(String(20), nullable=False, default="near", index=True)
    # 槽内序号（0 最远）：同一深度面里再分前后时用它，最多到 1
    depth: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # 视差系数：由槽位算出来（远景 0.08 … 前景 1.12），Godot 里 scroll_scale
    scroll_scale: Mapped[float] = mapped_column(Float, nullable=False, default=0.5)
    z_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    negative_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 判断依据：被谁挡、靠什么接地（LLM 的语义，坐标另算）
    occluded_by: Mapped[str | None] = mapped_column(String(240), nullable=True)
    supports: Mapped[str | None] = mapped_column(String(240), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 这一层对应的出图批次（P2 才有）
    # 这一层的手画遮罩（灰度 PNG，白色=这一层，黑色=不管）；空 = 整张都算
    mask_path: Mapped[str | None] = mapped_column(String(400), nullable=True)
    generation_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 导出时用哪一张（images.id）：为空表示「这一层最新的那张」
    selected_image_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    # 软删：硬删会让 SQLite 把这一层的 id 复用给下一层，旧批次就「跑到」新层里了
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )

    layer_set: Mapped[LayerSet] = relationship(back_populates="layers")
