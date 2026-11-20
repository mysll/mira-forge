"""API 路由聚合。"""

from fastapi import APIRouter

from app.api import (
    assets,
    editor,
    frames,
    generations,
    health,
    images,
    layer_sets,
    projects,
    prompt_templates,
    recycle,
    scenes,
    settings,
    tasks,
    workflows,
)

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(projects.router)
api_router.include_router(workflows.router)
api_router.include_router(generations.router)
api_router.include_router(tasks.router)
api_router.include_router(images.router)
api_router.include_router(recycle.router)
api_router.include_router(frames.router)
api_router.include_router(editor.router)
api_router.include_router(assets.router)
api_router.include_router(prompt_templates.router)
api_router.include_router(scenes.router)
api_router.include_router(layer_sets.router)
api_router.include_router(settings.router)

__all__ = ["api_router"]
