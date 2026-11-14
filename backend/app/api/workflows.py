"""模型目录与工作流列表。

/models 直接读注册表文件（新增模型只改 YAML）；/workflows 读数据库镜像。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.database import get_db
from app.models.workflow import Workflow
from app.schemas.workflow import (
    ModelInfo,
    ModelListResponse,
    WorkflowListResponse,
    WorkflowRead,
)
from app.services import workflow_service

router = APIRouter(tags=["workflows"])


@router.get("/models", response_model=ModelListResponse)
def list_models() -> ModelListResponse:
    return ModelListResponse(items=workflow_service.list_models())


@router.get("/models/{model_id}", response_model=ModelInfo)
def get_model(model_id: str) -> ModelInfo:
    model = workflow_service.get_model(model_id)
    if model is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"模型 {model_id} 不存在"
        )
    return model


@router.get("/workflows", response_model=WorkflowListResponse)
def list_workflows(db: Session = Depends(get_db)) -> WorkflowListResponse:
    rows = db.scalars(select(Workflow).order_by(Workflow.id)).all()
    return WorkflowListResponse(items=[WorkflowRead.model_validate(row) for row in rows])
