"""FastAPI 应用入口。"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from app.api import api_router
from app.core.config import get_settings
from app.core.events import manager
from app.core.migrations import upgrade_to_head
from app.models.database import SessionLocal
from app.services.workflow_service import sync_workflows

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("miraforge")

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    settings.ensure_directories()
    if settings.auto_migrate:
        upgrade_to_head()
        logger.info("数据库迁移完成: %s", settings.database_url_absolute)
    with SessionLocal() as db:
        written = sync_workflows(db)
    logger.info("工作流注册表同步完成，共 %s 条", written)
    logger.info("MiraForge 后端就绪 http://%s:%s", settings.app_host, settings.app_port)
    yield


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="本地 AI 图片生成与编辑平台后端（一期：图片）",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.frontend_origin.split(",") if origin.strip()],
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
    """任务事件通道。P1 只握手并回一条 connected；P2 起由 worker 广播状态变更。"""
    await manager.connect(websocket)
    try:
        await websocket.send_json({"type": "connected", "active_tasks": 0})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(websocket)
    finally:
        await manager.disconnect(websocket)
