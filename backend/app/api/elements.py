"""元素提取接口。

流程：POST 一条提取记录 → 后台线程让 LLM 看图、只列出「有哪些可拆的件」（不给坐标）
→ 人工挑 → 每件单独排一次 `image_edit`（参考图＝场景底图）→ 出真透明的小图。
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.core.projects import active_project
from app.models.database import get_db
from app.models.element import Element, ElementSet, ElementSetStatus
from app.models.image import Image
from app.schemas.element import (
    ElementExtractPayload,
    ElementRead,
    ElementSetCreate,
    ElementSetDeleted,
    ElementSetListResponse,
    ElementSetRead,
    ElementUpdate,
)
from app.schemas.generation import GenerationListResponse, GenerationRead, ImageBrief
from app.schemas.layer import LLMExchangeEntry
from app.services import element_service, image_service, llm_client
from app.services.element_service import ElementError
from app.services.scene_service import get_scene

router = APIRouter(tags=["elements"])

# 线程挂了 / 进程重启后 analyzing 会永远停在那里；超过这个时长就当失败
_STALE_AFTER = timedelta(minutes=10)


def _enrich(db: Session, element_set: ElementSet) -> ElementSetRead:
    """把每个元素的状态、最新出图、源图缩略图补上（都要查库，所以单独一层）。"""
    rows: list[ElementRead] = []
    kit_map = element_service.element_kit_ids(
        db, [element.id for element in element_set.elements]
    )
    for element in element_set.elements:
        element_service.sync_element_status(db, element)
        image = element_service.element_image(db, element)
        rows.append(
            ElementRead(
                id=element.id,
                set_id=element.set_id,
                kind=element.kind,
                name=element.name,
                key=element.key,
                anchor=element.anchor,
                note=element.note,
                prompt=element.prompt,
                status=element.status,
                sort_order=element.sort_order,
                image_id=image.id if image else None,
                selected_image_id=element.selected_image_id,
                kit_count=len(kit_map.get(element.id, [])),
                kit_ids=kit_map.get(element.id, []),
                has_mask=bool(element.mask_path),
                has_alpha=(
                    element_service.image_has_alpha(image) if image else False
                ),
                created_at=element.created_at,
            )
        )
    payload = ElementSetRead.model_validate(element_set)
    payload.elements = rows
    if element_set.source_image_id:
        source = db.get(Image, element_set.source_image_id)
        if source is not None and source.deleted_at is None:
            payload.source_image = ImageBrief.model_validate(source)
    try:
        meta = json.loads(element_set.llm_meta) if element_set.llm_meta else {}
    except ValueError:
        meta = {}
    exchange = meta.get("exchange") if isinstance(meta, dict) else None
    if isinstance(exchange, list):
        payload.llm_exchange = [
            LLMExchangeEntry(**item) for item in exchange if isinstance(item, dict)
        ]
    return payload


def _reap_stale(db: Session, rows: list[ElementSet]) -> None:
    changed = False
    now = datetime.now(timezone.utc)
    for row in rows:
        if row.status != ElementSetStatus.ANALYZING.value:
            continue
        created = row.created_at
        if created is not None and created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if created is not None and now - created > _STALE_AFTER:
            row.status = ElementSetStatus.FAILED.value
            row.error_message = "提取超时（后台线程已结束），可以重新提取"
            row.completed_at = now
            changed = True
    if changed:
        db.commit()


@router.post(
    "/scenes/{scene_id}/element-sets",
    response_model=ElementSetRead,
    status_code=status.HTTP_201_CREATED,
)
def create_set(
    scene_id: int, payload: ElementSetCreate, db: Session = Depends(get_db)
) -> ElementSetRead:
    get_scene(db, scene_id)
    if not llm_client.is_configured():
        raise HTTPException(
            status_code=400,
            detail="还没有配置 LLM：去「设置 → LLM」填 Base URL、模型与 API Key，保存后就能提取",
        )
    try:
        element_set = element_service.create_set(
            db,
            scene_id,
            source_image_id=payload.source_image_id,
            brief=payload.brief,
        )
    except ElementError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    element_service.start_analysis(active_project().id, element_set.id)
    return _enrich(db, element_set)


@router.get("/scenes/{scene_id}/element-sets", response_model=ElementSetListResponse)
def list_sets(
    scene_id: int, db: Session = Depends(get_db), limit: int = 20
) -> ElementSetListResponse:
    get_scene(db, scene_id)
    rows = element_service.list_sets(db, scene_id, limit=limit)
    _reap_stale(db, rows)
    return ElementSetListResponse(items=[_enrich(db, row) for row in rows], total=len(rows))


@router.get("/element-sets/{set_id}", response_model=ElementSetRead)
def get_set(set_id: int, db: Session = Depends(get_db)) -> ElementSetRead:
    try:
        element_set = element_service.get_set(db, set_id)
    except ElementError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    _reap_stale(db, [element_set])
    return _enrich(db, element_set)


@router.delete("/element-sets/{set_id}", response_model=ElementSetDeleted)
def delete_set(set_id: int, db: Session = Depends(get_db)) -> ElementSetDeleted:
    try:
        element_set = element_service.get_set(db, set_id)
    except ElementError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    count = len(element_set.elements)
    element_service.delete_set(db, element_set)
    return ElementSetDeleted(set_id=set_id, elements=count)


@router.post(
    "/element-sets/{set_id}/extractions",
    response_model=list[GenerationRead],
    status_code=status.HTTP_201_CREATED,
)
def extract(set_id: int, payload: ElementExtractPayload, db: Session = Depends(get_db)):
    """给选中的元素逐件排一次图片编辑（参考图＝场景底图）。"""
    from app.api.generations import _to_read as _generation_read

    try:
        element_set = element_service.get_set(db, set_id)
    except ElementError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    model = payload.model
    if not model:
        from app.services import workflow_service

        models = [item for item in workflow_service.list_models()]
        preferred = next((item for item in models if item.is_default), models[0] if models else None)
        if preferred is None:
            raise HTTPException(status_code=422, detail="没有可用的模型")
        model = preferred.id
        # 元素提取是图片编辑：优先挑一个能跑 image_edit 的模型
        edit_ready = next(
            (item for item in models if any(t.type == "image_edit" for t in item.workflows)),
            None,
        )
        if edit_ready is not None:
            model = edit_ready.id
    try:
        generations = element_service.extract_elements(
            db,
            element_set,
            element_ids=payload.element_ids,
            count=payload.count,
            model=model,
            prompt_suffix=payload.prompt_suffix,
            negative_prompt=payload.negative_prompt,
            seed=payload.seed,
            steps=payload.steps,
            cfg=payload.cfg,
            sampler=payload.sampler,
        )
    except ElementError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return [_generation_read(item) for item in generations]


@router.get("/elements/{element_id}/generations", response_model=GenerationListResponse)
def list_element_generations(
    element_id: int,
    limit: int = Query(default=20, ge=1, le=50),
    db: Session = Depends(get_db),
) -> GenerationListResponse:
    from app.api.generations import _to_read as _generation_read
    from app.repositories.generation_repo import GenerationRepository

    element = db.get(Element, element_id)
    if element is None:
        raise HTTPException(status_code=404, detail=f"元素 {element_id} 不存在")
    rows, total = GenerationRepository(db).list(
        limit=limit, element_id=element.id, with_products=True
    )
    return GenerationListResponse(
        items=[_generation_read(row) for row in rows], total=total, limit=limit, offset=0
    )


@router.patch("/elements/{element_id}", response_model=ElementRead)
def update_element(
    element_id: int, payload: ElementUpdate, db: Session = Depends(get_db)
) -> ElementRead:
    element = db.get(Element, element_id)
    if element is None:
        raise HTTPException(status_code=404, detail=f"元素 {element_id} 不存在")
    element = element_service.update_element(
        db,
        element,
        name=payload.name,
        key=payload.key,
        anchor=payload.anchor,
        note=payload.note,
        prompt=payload.prompt,
        selected_image_id=payload.selected_image_id,
    )
    image = element_service.element_image(db, element)
    return ElementRead(
        id=element.id,
        set_id=element.set_id,
        kind=element.kind,
        name=element.name,
        key=element.key,
        anchor=element.anchor,
        note=element.note,
        prompt=element.prompt,
        status=element.status,
        sort_order=element.sort_order,
        image_id=image.id if image else None,
        selected_image_id=element.selected_image_id,
        kit_count=element_service.kit_count(db, element),
        has_alpha=element_service.image_has_alpha(image) if image else False,
        has_mask=bool(element.mask_path),
        created_at=element.created_at,
    )


@router.get("/elements/{element_id}/file")
def element_file(element_id: int, db: Session = Depends(get_db)) -> FileResponse:
    element = db.get(Element, element_id)
    if element is None:
        raise HTTPException(status_code=404, detail=f"元素 {element_id} 不存在")
    image = element_service.element_image(db, element)
    if image is None:
        raise HTTPException(status_code=404, detail="这个元素还没出图")
    path = image_service.absolute_path(image, active_project().storage_path)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="这个元素的图不在了")
    return FileResponse(
        path, media_type="image/png", headers={"Cache-Control": "public, max-age=0, must-revalidate"}
    )

@router.post("/elements/{element_id}/mask", response_model=ElementRead)
async def upload_element_mask(
    element_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> ElementRead:
    """存下这一件手画的遮罩；之后出图会按遮罩的包围盒裁参考图。"""
    element = db.get(Element, element_id)
    if element is None:
        raise HTTPException(status_code=404, detail=f"元素 {element_id} 不存在")
    content = await file.read()
    try:
        element_service.save_mask(
            db, element, content, storage_root=active_project().storage_path
        )
    except ElementError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return update_element(element_id, ElementUpdate(), db)


@router.delete("/elements/{element_id}/mask", status_code=status.HTTP_204_NO_CONTENT)
def delete_element_mask(element_id: int, db: Session = Depends(get_db)) -> None:
    element = db.get(Element, element_id)
    if element is None:
        raise HTTPException(status_code=404, detail=f"元素 {element_id} 不存在")
    element_service.clear_mask(db, element, storage_root=active_project().storage_path)


@router.get("/elements/{element_id}/mask")
def element_mask(element_id: int, db: Session = Depends(get_db)) -> FileResponse:
    element = db.get(Element, element_id)
    if element is None:
        raise HTTPException(status_code=404, detail=f"元素 {element_id} 不存在")
    path = element_service.mask_absolute_path(element, active_project().storage_path)
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="这一件还没画遮罩")
    return FileResponse(
        path, media_type="image/png", headers={"Cache-Control": "public, max-age=0, must-revalidate"}
    )
