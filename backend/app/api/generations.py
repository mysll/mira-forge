"""生成相关接口。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.models.database import get_db
from app.repositories.generation_repo import GenerationRepository
from app.schemas.generation import (
    GenerationCreate,
    GenerationListResponse,
    GenerationRead,
    GenerationSummary,
)
from app.services.generation_service import GenerationValidationError, create_generation

router = APIRouter(prefix="/generations", tags=["generations"])


@router.post("", response_model=GenerationRead, status_code=status.HTTP_201_CREATED)
def create(
    payload: GenerationCreate, db: Session = Depends(get_db)
) -> GenerationRead:
    """创建一次生成请求。P1 只落库为 pending，不提交 ComfyUI。"""
    try:
        generation = create_generation(db, payload)
    except GenerationValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return GenerationRead.model_validate(generation)


@router.get("", response_model=GenerationListResponse)
def list_generations(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
) -> GenerationListResponse:
    rows, total = GenerationRepository(db).list(limit=limit, offset=offset)
    items = [
        GenerationSummary(
            id=row.id,
            prompt=row.prompt,
            generation_type=row.generation_type,
            model_name=row.model_name,
            width=row.width,
            height=row.height,
            requested_count=row.requested_count,
            status=row.status,
            created_at=row.created_at,
            completed_at=row.completed_at,
            task_count=len(row.tasks),
        )
        for row in rows
    ]
    return GenerationListResponse(items=items, total=total, limit=limit, offset=offset)


@router.get("/{generation_id}", response_model=GenerationRead)
def get_generation(generation_id: int, db: Session = Depends(get_db)) -> GenerationRead:
    generation = GenerationRepository(db).get(generation_id)
    if generation is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"generation {generation_id} 不存在"
        )
    return GenerationRead.model_validate(generation)
