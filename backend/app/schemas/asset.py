"""素材相关的响应模型。

素材 = 不是模型生成、也不是本地编辑器成品的产物：目前只有序列帧工坊导出的
atlas.png / atlas.json / 图集 ZIP。它们与图片共用 `images` 表，用
`media_type="asset"` 区分，文件落在 `storage/assets/`。
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class AssetSaved(BaseModel):
    generation_id: int
    image_id: int
    name: str
    file_size: int
    width: int
    height: int
    media_type: str = "asset"


class AssetSaveRequest(BaseModel):
    """仅用于文档示例的请求体说明（真实接口走 multipart）。"""

    name: str | None = Field(default=None, max_length=200)
    source_image_id: int | None = None
