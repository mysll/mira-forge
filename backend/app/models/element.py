"""元素提取：让 LLM 从一张场景图里点名「可以复用的构件」，再逐件用图片编辑重绘成透明件。

和分层不是一回事：
- 分层回答「这张图由哪几层组成」，产物是一层一张整幅透明图，用来做视差；
- 元素提取回答「这张图里有哪些零件能拆下来重复用」，产物是若干张小图，
  按格子摆进 `kits` 之后导出成 atlas，在 Godot 里当 TileMap 的地形片或场景里的贴纸。

**为什么不裁框**：文本 VLM 的坐标回归误差很大（实测会把拱门的框落到灯笼上），
所以 LLM 只负责「有哪些件、叫什么、大概在哪」，几何交给图片编辑：每件拿底图当参考图，
按提示词重画成「只有这一件、其余透明」的图。这样出来的件有真 alpha，风格也跟着底图走。
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.database import Base
from app.models.workflow import utcnow


class ElementSetStatus(str, Enum):
    """一次提取任务的状态：分析中 → 出候选 / 失败。"""

    ANALYZING = "analyzing"
    READY = "ready"
    FAILED = "failed"


class ElementStatus(str, Enum):
    """单个元素的状态：候选 → 已排进队列 → 出图中 → 有图 / 失败。"""

    DRAFT = "draft"
    QUEUED = "queued"
    RUNNING = "running"
    READY = "ready"
    FAILED = "failed"


class ElementSet(Base):
    __tablename__ = "element_sets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    scene_id: Mapped[int] = mapped_column(
        ForeignKey("scenes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # 源图（images.id）：从哪张场景图上拆零件
    source_image_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=ElementSetStatus.ANALYZING.value, index=True
    )
    # 用户的额外要求（会拼进 user 消息）
    brief: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 模型、耗时、原始返回、每轮对话（和分层一样，前端要按对话展示）
    llm_meta: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, index=True
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )

    elements: Mapped[list["Element"]] = relationship(
        back_populates="element_set",
        cascade="all, delete-orphan",
        order_by="Element.sort_order",
        lazy="selectin",
    )


class Element(Base):
    __tablename__ = "elements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    set_id: Mapped[int] = mapped_column(
        ForeignKey("element_sets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # terrain 地形 / structure 结构 / prop 道具 / decor 装饰
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="prop")
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    # 进图集时的键名（英文 snake_case，导出给 Godot 用）
    key: Mapped[str] = mapped_column(String(60), nullable=False)
    # 出图用的提示词（LLM 写好的「只画这一件」的那种描述）
    prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 手画的遮罩（灰度 PNG，白色 = 这件的位置）；有遮罩时按它裁参考图
    mask_path: Mapped[str | None] = mapped_column(String(400), nullable=True)
    # 对齐点：top 让顶面贴碰撞线，bottom 让底边坐在地上
    anchor: Mapped[str] = mapped_column(String(10), nullable=False, default="top")
    note: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # 出图任务（image_edit，参考图 = 源场景图）；有图之后 generation 下挂着产物
    generation_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    # 用户在图集里「用这张」选中的那张图；为空时退回这个元素最新一次出图
    selected_image_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=ElementStatus.DRAFT.value
    )
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )

    element_set: Mapped[ElementSet] = relationship(back_populates="elements")
