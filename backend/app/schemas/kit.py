"""图集（Kit）的请求 / 响应模型。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, model_validator

from app.schemas.common import TimestampedModel


class KitItemCreate(BaseModel):
    # 二选一：项目里已有的图，或元素提取出来的小图
    image_id: int | None = Field(default=None, ge=1)
    element_id: int | None = Field(default=None, ge=1)
    # 给开发用的名字，比如 platform_a / pillar_left；空的话用图片 id
    key: str | None = Field(default=None, max_length=60)
    # 对齐点：top 表示图的上边缘贴着放置点（平台顶面），bottom 表示下边缘
    anchor: str = Field(default="top", pattern="^(top|bottom)$")
    note: str | None = Field(default=None, max_length=200)
    # 进图集前按这个比例缩放（1.0 = 原尺寸）；有的件出图很大，缩到 25%–50% 才和其它件配得上
    scale: float = Field(default=1.0, gt=0.05, le=2.0)

    @model_validator(mode="after")
    def _one_source(self) -> "KitItemCreate":
        if (self.image_id is None) == (self.element_id is None):
            raise ValueError("image_id 和 element_id 必须二选一")
        return self


class KitItemUpdate(BaseModel):
    key: str | None = Field(default=None, max_length=60)
    anchor: str | None = Field(default=None, pattern="^(top|bottom)$")
    note: str | None = Field(default=None, max_length=200)
    sort_order: int | None = Field(default=None, ge=0)
    scale: float | None = Field(default=None, gt=0.05, le=2.0)


class KitItemRead(TimestampedModel):
    id: int
    kit_id: int
    image_id: int | None = None
    element_id: int | None = None
    key: str
    anchor: str
    note: str | None = None
    scale: float = 1.0
    sort_order: int = 0
    created_at: datetime
    # 打包时才填：在图集里的像素矩形
    rect: dict | None = None


class KitCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    description: str | None = Field(default=None, max_length=2000)
    padding: int = Field(default=4, ge=0, le=64)
    max_width: int = Field(default=2048, ge=512, le=8192)
    # 格子对齐：0 表示不限制（像素级装箱），否则件按 N×N 的整格摆放
    cell: int = Field(default=64, ge=0, le=256)
    # 从场景的元素提取页建出来时带上场景 id，页面就能默认选中它
    scene_id: int | None = Field(default=None, ge=1)


class KitUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    description: str | None = Field(default=None, max_length=2000)
    padding: int | None = Field(default=None, ge=0, le=64)
    max_width: int | None = Field(default=None, ge=512, le=8192)
    cell: int | None = Field(default=None, ge=0, le=256)


class KitRead(TimestampedModel):
    id: int
    name: str
    description: str | None = None
    padding: int = 4
    max_width: int = 2048
    cell: int = 64
    scene_id: int | None = None
    created_at: datetime
    item_count: int = 0
    items: list[KitItemRead] = Field(default_factory=list)


class KitListResponse(BaseModel):
    items: list[KitRead] = Field(default_factory=list)
    total: int


class AtlasSummary(BaseModel):
    """打包结果：整张图多大、几个件、每个件的矩形。"""

    width: int
    height: int
    cell: int = 0
    fill: float = 0.0
    item_count: int
    items: list[KitItemRead] = Field(default_factory=list)
    # 有件比画布还宽、被等比缩小了：界面提示一下，用户可以去元素页调小比例
    shrunk: list[str] = Field(default_factory=list)


class KitDeleted(BaseModel):
    kit_id: int
