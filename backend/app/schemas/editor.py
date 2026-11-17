"""本地编辑器相关的响应模型。"""

from __future__ import annotations

from pydantic import BaseModel


class LocalEditSaved(BaseModel):
    """保存到资产库之后回给前端的定位信息。"""

    generation_id: int
    image_id: int
    width: int
    height: int
    file_size: int
