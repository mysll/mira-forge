"""API 路由聚合。"""

from fastapi import APIRouter

from app.api import editor, generations, health, images, projects, tasks, workflows

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(projects.router)
api_router.include_router(workflows.router)
api_router.include_router(generations.router)
api_router.include_router(tasks.router)
api_router.include_router(images.router)
api_router.include_router(editor.router)

__all__ = ["api_router"]
