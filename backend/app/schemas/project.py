"""项目（工作区）相关的请求 / 响应模型。"""

from __future__ import annotations

from pydantic import BaseModel, Field


class ProjectRead(BaseModel):
    id: str
    name: str
    created_at: str
    is_active: bool = False
    # 磁盘位置，前端在设置页展示，方便用户自己去文件夹里找图
    path: str
    database_path: str
    storage_path: str


class ProjectListResponse(BaseModel):
    items: list[ProjectRead]
    active: str


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    # 新建后是否立刻切过去，默认切（用户的下一步动作几乎总是开始创作）
    activate: bool = True


class ProjectRename(BaseModel):
    name: str = Field(min_length=1, max_length=40)
