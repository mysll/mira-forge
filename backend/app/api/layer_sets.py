"""场景分层接口：发起分析 / 看方案 / 改层卡 / 删方案。

分析是异步的：POST 立刻返回 `status=analyzing`，前端轮询 `/layer-sets/{id}`；
真正的 LLM 调用在后台线程里，失败写进 `error_message`，不影响场景里已有的图。
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from starlette.background import BackgroundTask

from app.core.projects import active_project
from app.models.database import get_db
from app.models.layer import Layer, LayerSet, LayerSetStatus
from app.schemas.generation import GenerationListResponse, GenerationRead
from app.schemas.layer import (
    LayerRead,
    LayerRenderAllResult,
    LayerRenderCreate,
    LayerSetCreate,
    LayerSetListResponse,
    LayerSetRead,
    LayerUpdate,
    LLMExchangeEntry,
)
from app.services import llm_client
from app.services.layer_service import (
    LayerError,
    create_layer_set,
    delete_layer_set,
    get_layer_set,
    list_layer_sets,
    merge_negative,
    start_analysis,
    update_layer,
    UNIVERSAL_NEGATIVE,
)
from app.services.scene_service import get_scene

router = APIRouter(tags=["layers"])

# 线程挂了 / 进程重启后，analyzing 会永远停在那里；超过这个时长就当失败
_STALE_AFTER = timedelta(minutes=10)


def _to_read(layer_set: LayerSet) -> LayerSetRead:
    payload = LayerSetRead.model_validate(layer_set)
    payload.layers = [LayerRead.model_validate(layer) for layer in layer_set.layers]
    # 对话记录存在 llm_meta JSON 里，单独拆成结构化的 llm_exchange 给前端
    try:
        meta = json.loads(layer_set.llm_meta) if layer_set.llm_meta else {}
    except ValueError:
        meta = {}
    exchange = meta.get("exchange") if isinstance(meta, dict) else None
    if isinstance(exchange, list):
        payload.llm_exchange = [
            LLMExchangeEntry(**item) for item in exchange if isinstance(item, dict)
        ]
    return payload


def _reap_stale(db: Session, layer_sets: list[LayerSet]) -> None:
    """把卡在 analyzing 的旧记录收成 failed，让前端能重试。"""
    changed = False
    now = datetime.now(timezone.utc)
    for layer_set in layer_sets:
        if layer_set.status != LayerSetStatus.ANALYZING.value:
            continue
        created = layer_set.created_at
        if created is not None and created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if created is not None and now - created > _STALE_AFTER:
            layer_set.status = LayerSetStatus.FAILED.value
            layer_set.error_message = "分析超时（后台线程已结束），可以重新分析"
            layer_set.completed_at = now
            changed = True
    if changed:
        db.commit()


@router.post(
    "/scenes/{scene_id}/layer-sets", response_model=LayerSetRead, status_code=status.HTTP_201_CREATED
)
def create_set(scene_id: int, payload: LayerSetCreate, db: Session = Depends(get_db)) -> LayerSetRead:
    get_scene(db, scene_id)
    if not llm_client.is_configured():
        raise HTTPException(
            status_code=400,
            detail="还没有配置 LLM：去「设置 → LLM 分层分析」填 Base URL、模型与 API Key，保存后就能直接分析",
        )
    try:
        layer_set = create_layer_set(db, scene_id, payload)
    except LayerError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    start_analysis(active_project().id, layer_set.id)
    return _to_read(layer_set)


@router.get("/scenes/{scene_id}/layer-sets", response_model=LayerSetListResponse)
def list_sets(scene_id: int, db: Session = Depends(get_db)) -> LayerSetListResponse:
    get_scene(db, scene_id)
    items = list_layer_sets(db, scene_id)
    _reap_stale(db, items)
    return LayerSetListResponse(items=[_to_read(item) for item in items], total=len(items))


@router.get("/layer-sets/{set_id}", response_model=LayerSetRead)
def get_set(set_id: int, db: Session = Depends(get_db)) -> LayerSetRead:
    layer_set = get_layer_set(db, set_id)
    return _to_read(layer_set)


@router.delete("/layer-sets/{set_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_set(set_id: int, db: Session = Depends(get_db)) -> None:
    delete_layer_set(db, get_layer_set(db, set_id))


@router.get("/scenes/{scene_id}/layers/{source_image_id}/export")
def export_layers(scene_id: int, source_image_id: int, db: Session = Depends(get_db)) -> FileResponse:
    """把场景底图 + 这套方案每一层选定的那张图打成一个 zip 下载。"""
    from app.models.image import Image
    from app.services import layer_export_service

    scene = get_scene(db, scene_id)
    source = db.get(Image, source_image_id)
    if source is None or source.deleted_at is not None or source.scene_id != scene_id:
        raise HTTPException(status_code=404, detail="这张场景图不存在")

    layer_set = next(
        (
            item
            for item in list_layer_sets(db, scene_id, limit=50)
            if item.source_image_id == source_image_id and item.status == LayerSetStatus.PLANNED.value
        ),
        None,
    )
    if layer_set is None:
        raise HTTPException(status_code=404, detail="这张图还没有分层方案，先做一次分层再导出")
    if not layer_set.layers:
        raise HTTPException(status_code=422, detail="这套方案里没有层，无法导出")

    path, filename, manifest = layer_export_service.build_export_zip(
        db, layer_set, source, scene_name=scene.name, storage_root=active_project().storage_path
    )
    return FileResponse(
        path,
        media_type="application/zip",
        filename=filename,
        background=BackgroundTask(lambda: path.unlink(missing_ok=True)),
        headers={"X-Layer-Count": str(len(manifest.get("layers", [])))},
    )


@router.patch("/layers/{layer_id}", response_model=LayerRead)
def patch_layer(layer_id: int, payload: LayerUpdate, db: Session = Depends(get_db)) -> LayerRead:
    layer = db.get(Layer, layer_id)
    if layer is None or layer.layer_set.deleted_at is not None:
        raise HTTPException(status_code=404, detail=f"层 {layer_id} 不存在")
    try:
        layer = update_layer(db, layer, payload)
    except LayerError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return LayerRead.model_validate(layer)


def _layer_or_404(db: Session, layer_id: int) -> Layer:
    layer = db.get(Layer, layer_id)
    if layer is None or layer.layer_set is None or layer.layer_set.deleted_at is not None:
        raise HTTPException(status_code=404, detail=f"层 {layer_id} 不存在")
    return layer


def _submit_layer_generation(
    db: Session,
    layer: Layer,
    *,
    count: int,
    prompt: str | None = None,
    negative: str | None = None,
    model: str | None = None,
    seed: int | None = None,
    steps: int | None = None,
    cfg: float | None = None,
    sampler: str | None = None,
    save_prompt: bool = False,
):
    """给一层建一条 scene_layer 批次（单层出图与「生成所有层」共用）。"""
    from app.models.generation import GenerationType
    from app.models.image import Image
    from app.schemas.generation import GenerationCreate
    from app.services.generation_service import create_generation

    layer_set = layer.layer_set
    if layer_set.source_image_id is None:
        raise HTTPException(
            status_code=422, detail="这个分层方案没有源图，无法按层出图，请重新分析"
        )
    source = db.get(Image, layer_set.source_image_id)
    if source is None or source.deleted_at is not None:
        raise HTTPException(status_code=422, detail="分层源图已经不在了，请重新选一张场景图分析")

    text = (prompt or layer.prompt or "").strip() or layer.name
    if prompt and save_prompt and prompt.strip() != (layer.prompt or ""):
        layer.prompt = prompt.strip()

    selection = GenerationCreate(
        prompt=text,
        model=model or layer_set.model_name,
        generation_type=GenerationType.SCENE_LAYER,
        scene_id=layer_set.scene_id,
        layer_id=layer.id,
        width=source.width,
        height=source.height,
        count=count,
        # 这一层的专属负向词 + 系统通用负面词（去重后一起发给采样器）
        negative_prompt=merge_negative(negative or layer.negative_prompt, UNIVERSAL_NEGATIVE),
        seed=seed,
        steps=steps,
        cfg=cfg,
        sampler=sampler,
    )
    generation = create_generation(
        db,
        selection,
        # 路径必须相对项目 storage（worker 用 read_storage_file 解析，绝对路径会被拒）
        reference_image_paths=[source.file_path],
    )
    layer.generation_id = generation.id
    db.commit()
    db.refresh(generation)
    return generation


@router.post(
    "/layers/{layer_id}/generations",
    response_model=GenerationRead,
    status_code=status.HTTP_201_CREATED,
)
def render_layer(
    layer_id: int, payload: LayerRenderCreate, db: Session = Depends(get_db)
) -> GenerationRead:
    """按层出一批图：参考图是这一层的分层源图，产物记成 scene_layer。"""
    from app.api.generations import _to_read as _generation_read
    from app.services.generation_service import GenerationValidationError

    layer = _layer_or_404(db, layer_id)
    try:
        generation = _submit_layer_generation(
            db,
            layer,
            count=payload.count,
            prompt=payload.prompt,
            negative=payload.negative_prompt,
            model=payload.model,
            seed=payload.seed,
            steps=payload.steps,
            cfg=payload.cfg,
            sampler=payload.sampler,
            save_prompt=payload.save_prompt,
        )
    except GenerationValidationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return _generation_read(generation)


@router.post(
    "/layer-sets/{set_id}/generations",
    response_model=LayerRenderAllResult,
    status_code=status.HTTP_201_CREATED,
)
def render_all_layers(set_id: int, db: Session = Depends(get_db)) -> LayerRenderAllResult:
    """一次把整套方案的每一层都排进去：一层一条批次，worker 单协程会依次跑。

    每一层都只用自己的提示词 + 负向词，张数取方案的「每层张数」。某一层提交失败
    （比如模型不支持编辑）不会影响其它层，失败的层名会放进 skipped。
    """
    from app.api.generations import _to_read as _generation_read
    from app.services.generation_service import GenerationValidationError

    layer_set = get_layer_set(db, set_id)
    if not layer_set.layers:
        raise HTTPException(status_code=422, detail="这套方案里还没有层，无法生成")
    count = max(1, min(4, layer_set.count_per_layer or 1))

    generations: list[GenerationRead] = []
    skipped: list[str] = []
    for layer in layer_set.layers:
        try:
            generation = _submit_layer_generation(db, layer, count=count)
            generations.append(_generation_read(generation))
        except GenerationValidationError as error:
            skipped.append(f"{layer.name}：{error}")
        except HTTPException as error:
            raise error
    if not generations:
        raise HTTPException(
            status_code=422,
            detail="每一层都提交失败：" + ("；".join(skipped) if skipped else "未知原因"),
        )
    return LayerRenderAllResult(
        generations=generations,
        submitted=len(generations),
        images=len(generations) * count,
        skipped=skipped,
    )


@router.get("/layers/{layer_id}/generations", response_model=GenerationListResponse)
def list_layer_generations(
    layer_id: int,
    limit: int = Query(default=20, ge=1, le=50),
    db: Session = Depends(get_db),
) -> GenerationListResponse:
    """这一层出过的批次（页签里的信息流）。"""
    from app.api.generations import _to_read as _generation_read
    from app.repositories.generation_repo import GenerationRepository

    layer = _layer_or_404(db, layer_id)
    rows, total = GenerationRepository(db).list(
        limit=limit, layer_id=layer.id, with_products=True
    )
    return GenerationListResponse(
        items=[_generation_read(row) for row in rows], total=total, limit=limit, offset=0
    )
