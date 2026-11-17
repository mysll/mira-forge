"""FastAPI 应用入口。"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from app.api import api_router
from app.api.projects import prepare
from app.core.config import get_settings
from app.core.events import manager
from app.core.migrations import upgrade_to_head
from app.core.projects import active_project, ensure_catalog, list_projects
from app.models.database import session_for
from app.services.generation_service import reset_interrupted_tasks
from app.services.workflow_service import sync_workflows
from app.workers.generation_worker import start_worker, stop_worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("miraforge")

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    settings.ensure_directories()
    project = ensure_catalog()
    logger.info("激活项目：%s（%s）", project.name, project.path)
    if settings.auto_migrate:
        upgrade_to_head(project)
        logger.info("数据库迁移完成：%s", project.db_path)

    for item in list_projects():
        item.ensure_directories()
        if settings.auto_migrate:
            upgrade_to_head(item)
        with session_for(item) as db:
            written = sync_workflows(db)
            recovered = reset_interrupted_tasks(db)
        if recovered:
            logger.info(
                "项目 %s：上次退出时残留的 %s 个 queued/running 任务已复位为 pending",
                item.name,
                recovered,
            )
        logger.debug("项目 %s：工作流注册表同步 %s 条", item.name, written)

    if settings.worker_enabled:
        start_worker()
        logger.info("生成 worker 已随应用启动（%s 个项目轮转）", len(list_projects()))
    else:
        logger.info("生成 worker 未启动（WORKER_ENABLED=false）")
    logger.info("MiraForge 后端就绪 http://%s:%s", settings.app_host, settings.app_port)
    try:
        yield
    finally:
        await stop_worker()


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="本地 AI 图片生成与编辑平台后端（一期：图片）",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.frontend_origin.split(",") if origin.strip()],
    # 用局域网 IP 打开前端时（如 http://10.236.134.52:3000）也放行：
    # 只允许本机与私有网段，不放开公网来源。
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api/v1")


@app.get("/", tags=["meta"])
def root() -> dict[str, str]:
    return {
        "name": settings.app_name,
        "version": settings.app_version,
        "api": "/api/v1",
        "docs": "/docs",
    }


@app.websocket("/api/v1/ws/tasks")
async def tasks_websocket(websocket: WebSocket) -> None:
    """任务事件通道：连接成功后推送 task.updated 事件（带 project 字段）。"""
    await manager.connect(websocket)
    try:
        await websocket.send_json(
            {
                "type": "connected",
                "active_tasks": _active_task_count(),
                "project": _safe_active_project_id(),
            }
        )
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(websocket)
    finally:
        await manager.disconnect(websocket)


def _safe_active_project_id() -> str | None:
    try:
        return active_project().id
    except Exception:  # noqa: BLE001 - 清单还没建好时不要影响握手
        return None


def _active_task_count() -> int:
    """所有项目里排队 + 运行中的任务数（只用于握手时的提示）。"""
    from sqlalchemy import func, select

    from app.models.task import GenerationTask, TaskStatus

    total = 0
    for project in list_projects():
        with session_for(project) as db:
            total += int(
                db.scalar(
                    select(func.count())
                    .select_from(GenerationTask)
                    .where(
                        GenerationTask.status.in_([TaskStatus.QUEUED, TaskStatus.RUNNING])
                    )
                )
                or 0
            )
    return total


__all__ = ["app", "prepare"]
