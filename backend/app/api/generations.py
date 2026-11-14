"""生成相关接口。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.database import get_db
from app.repositories.generation_repo import GenerationRepository
from app.schemas.generation import (
    GenerationCreate,
    GenerationListResponse,
    GenerationRead,
    GenerationSummary,
)
from app.services.generation_service import GenerationValidationError, create_generation
from app.services.image_service import (
    MAX_UPLOAD_BYTES,
    ImageStoreError,
    detect_image_extension,
    store_upload,
)

router = APIRouter(prefix="/generations", tags=["generations"])


@router.post("", response_model=GenerationRead, status_code=status.HTTP_201_CREATED)
def create(
    payload: GenerationCreate, db: Session = Depends(get_db)
) -> GenerationRead:
    """创建一次文生图请求：只落库为 pending，由 Worker 串行执行。"""
    try:
        generation = create_generation(db, payload)
    except GenerationValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return GenerationRead.model_validate(generation)


@router.post("/edit", response_model=GenerationRead, status_code=status.HTTP_201_CREATED)
async def create_edit(
    prompt: str = Form(..., min_length=1, max_length=8000),
    model: str = Form(..., min_length=1, max_length=64),
    count: int = Form(1, ge=1),
    width: int | None = Form(None, ge=64, le=4096),
    height: int | None = Form(None, ge=64, le=4096),
    images: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
) -> GenerationRead:
    """创建一次图片编辑请求（multipart，带 1 张参考图）。"""
    if len(images) != 1:
        raise HTTPException(
            status_code=422,
            detail=f"当前仅支持 1 张参考图，收到 {len(images)} 张",
        )

    upload = images[0]
    content = await upload.read()
    if not content:
        raise HTTPException(status_code=422, detail="参考图内容为空")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=422,
            detail=f"参考图过大（{len(content) // 1024} KB），上限 {MAX_UPLOAD_BYTES // 1024 // 1024} MB",
        )
    extension = detect_image_extension(content)
    if extension is None:
        raise HTTPException(status_code=422, detail="参考图必须是 PNG / JPEG / WEBP")

    try:
        relative = store_upload(content, extension=extension)
    except ImageStoreError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    payload = GenerationCreate(
        prompt=prompt,
        model=model,
        generation_type="image_edit",
        width=width,
        height=height,
        count=count,
    )
    try:
        generation = create_generation(db, payload, reference_image_path=relative)
    except GenerationValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return GenerationRead.model_validate(generation)


@router.get("/{generation_id}/reference")
def get_reference(generation_id: int, db: Session = Depends(get_db)) -> FileResponse:
    """回显该次生成使用的参考图（前端历史里用）。"""
    generation = GenerationRepository(db).get(generation_id)
    if generation is None or not generation.reference_image_path:
        raise HTTPException(
            status_code=404, detail=f"generation {generation_id} 没有参考图"
        )
    path = get_settings().storage_path / generation.reference_image_path
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"参考图文件缺失：{path}")
    return FileResponse(path)


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
            progress=_overall_progress(row.tasks),
            created_at=row.created_at,
            completed_at=row.completed_at,
            task_count=len(row.tasks),
        )
        for row in rows
    ]
    return GenerationListResponse(items=items, total=total, limit=limit, offset=offset)


def _overall_progress(tasks) -> int:
    """整体进度按任务数平均，避免 8 张里前 7 张完成却显示 99%。"""
    if not tasks:
        return 0
    return round(sum(task.progress for task in tasks) / len(tasks))


@router.get("/{generation_id}", response_model=GenerationRead)
def get_generation(generation_id: int, db: Session = Depends(get_db)) -> GenerationRead:
    generation = GenerationRepository(db).get(generation_id)
    if generation is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"generation {generation_id} 不存在"
        )
    return GenerationRead.model_validate(generation)
