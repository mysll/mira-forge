"""视频提示词模板：视频创作框下面那排按钮的数据来源。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.models.database import get_db
from app.models.prompt_template import PromptTemplate
from app.schemas.prompt_template import (
    PromptTemplateCreate,
    PromptTemplateListResponse,
    PromptTemplateRead,
    PromptTemplateUpdate,
)
from app.services import prompt_template_service

router = APIRouter(prefix="/prompt-templates", tags=["prompt-templates"])


def _get(db: Session, template_id: int) -> PromptTemplate:
    template = db.get(PromptTemplate, template_id)
    if template is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"模板 {template_id} 不存在"
        )
    return template


@router.get("", response_model=PromptTemplateListResponse)
def list_templates(db: Session = Depends(get_db)) -> PromptTemplateListResponse:
    return PromptTemplateListResponse(items=prompt_template_service.list_templates(db))


@router.post("", response_model=PromptTemplateRead, status_code=status.HTTP_201_CREATED)
def create_template(
    payload: PromptTemplateCreate, db: Session = Depends(get_db)
) -> PromptTemplate:
    try:
        return prompt_template_service.create_template(db, payload.label, payload.prompt)
    except prompt_template_service.TemplateError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error


@router.post("/reset", response_model=PromptTemplateListResponse)
def reset_templates(db: Session = Depends(get_db)) -> PromptTemplateListResponse:
    return PromptTemplateListResponse(items=prompt_template_service.reset_defaults(db))


@router.patch("/{template_id}", response_model=PromptTemplateRead)
def update_template(
    template_id: int, payload: PromptTemplateUpdate, db: Session = Depends(get_db)
) -> PromptTemplate:
    template = _get(db, template_id)
    try:
        return prompt_template_service.update_template(db, template, payload.label, payload.prompt)
    except prompt_template_service.TemplateError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_template(template_id: int, db: Session = Depends(get_db)) -> Response:
    template = _get(db, template_id)
    db.delete(template)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
