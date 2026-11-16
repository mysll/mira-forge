"""项目管理：列表 / 新建 / 重命名 / 切换 / 删除。

项目之间完全隔离（一个文件夹一套数据库 + 产物），所以这里没有「项目 id 过滤」
之类的参数——切项目就是切当前上下文，其它接口不需要知道项目的存在。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select

from app.core.config import get_settings
from app.core.migrations import upgrade_to_head
from app.core.projects import (
    Project,
    ProjectError,
    activate_project,
    active_project,
    create_project,
    delete_project,
    get_project,
    list_projects,
    rename_project,
)
from app.models.database import session_for
from app.models.generation import Generation
from app.models.task import GenerationTask, TaskStatus
from app.schemas.project import ProjectCreate, ProjectListResponse, ProjectRead, ProjectRename
from app.services.workflow_service import sync_workflows

logger = logging.getLogger("miraforge.projects")

router = APIRouter(prefix="/projects", tags=["projects"])


def _read(project: Project, *, active_id: str) -> ProjectRead:
    return ProjectRead(
        id=project.id,
        name=project.name,
        created_at=project.created_at,
        is_active=project.id == active_id,
        path=project.path.as_posix(),
        database_path=project.db_path.as_posix(),
        storage_path=project.storage_path.as_posix(),
    )


def _snapshot() -> ProjectListResponse:
    active = active_project()
    items = [_read(project, active_id=active.id) for project in list_projects()]
    return ProjectListResponse(items=items, active=active.id)


def prepare(project: Project) -> None:
    """新建 / 切换 / 启动时都要做：建目录、跑迁移、同步工作流注册表。"""
    project.ensure_directories()
    if get_settings().auto_migrate:
        upgrade_to_head(project)
    with session_for(project) as db:
        sync_workflows(db)


@router.get("", response_model=ProjectListResponse)
def list_all() -> ProjectListResponse:
    return _snapshot()


@router.post("", response_model=ProjectRead, status_code=201)
def create(payload: ProjectCreate) -> ProjectRead:
    try:
        project = create_project(payload.name)
    except ProjectError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    prepare(project)
    if payload.activate:
        project = activate_project(project.id)
    return _read(project, active_id=active_project().id)


@router.patch("/{project_id}", response_model=ProjectRead)
def rename(project_id: str, payload: ProjectRename) -> ProjectRead:
    try:
        project = rename_project(project_id, payload.name)
    except ProjectError as exc:
        status = 404 if "不存在" in str(exc) else 422
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    return _read(project, active_id=active_project().id)


@router.post("/{project_id}/activate", response_model=ProjectRead)
def activate(project_id: str) -> ProjectRead:
    project = get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"项目 {project_id} 不存在")
    prepare(project)
    try:
        project = activate_project(project_id)
    except ProjectError as exc:  # pragma: no cover - get_project 已兜住
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _read(project, active_id=project.id)


@router.delete("/{project_id}", response_model=ProjectListResponse)
def delete(project_id: str) -> ProjectListResponse:
    project = get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"项目 {project_id} 不存在")

    # 删除整个文件夹，正在跑的任务会连文件带结果一起消失，所以先拦住
    with session_for(project) as db:
        active_tasks = int(
            db.scalar(
                select(func.count())
                .select_from(GenerationTask)
                .where(GenerationTask.status.in_([TaskStatus.QUEUED, TaskStatus.RUNNING]))
            )
            or 0
        )
        generations = int(db.scalar(select(func.count()).select_from(Generation)) or 0)

    if active_tasks:
        raise HTTPException(
            status_code=409,
            detail=f"项目「{project.name}」还有 {active_tasks} 个任务在排队或生成，请先等完成或取消",
        )

    try:
        delete_project(project_id)
    except ProjectError as exc:
        status = 404 if "不存在" in str(exc) else 422
        raise HTTPException(status_code=status, detail=str(exc)) from exc

    logger.info("项目 %s 已删除（含 %s 个生成记录）", project.name, generations)
    return _snapshot()
