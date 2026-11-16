"""健康检查响应模型。"""

from __future__ import annotations

from pydantic import BaseModel


class ComponentStatus(BaseModel):
    status: str  # ok | degraded | error
    detail: str | None = None


class DatabaseStatus(ComponentStatus):
    path: str | None = None


class ComfyUIStatus(ComponentStatus):
    url: str
    reachable: bool = False
    version: str | None = None
    device: str | None = None
    error: str | None = None


class HealthResponse(BaseModel):
    status: str
    app: str
    version: str
    database: DatabaseStatus
    comfyui: ComfyUIStatus
    storage: ComponentStatus
    storage_path: str | None = None
    max_generation_count: int = 8
    # 当前激活项目（多项目工作区）
    project_id: str | None = None
    project_name: str | None = None
    project_path: str | None = None
