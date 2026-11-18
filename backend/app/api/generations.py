"""生成相关接口。"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.task import TaskStatus
from app.services.image_service import storage_root_for
from app.models.database import get_db
from app.repositories.generation_repo import GenerationRepository
from app.schemas.generation import (
    GenerationCreate,
    GenerationListResponse,
    GenerationRead,
    GenerationRename,
)
from app.services.generation_service import (
    GenerationValidationError,
    create_generation,
    decode_reference_paths,
)
from app.services.image_service import (
    MAX_UPLOAD_BYTES,
    ImageStoreError,
    detect_image_extension,
    store_upload,
)
from app.services.recycle_service import soft_delete_generation

router = APIRouter(prefix="/generations", tags=["generations"])

_VIDEO_TYPES = ("text_to_video", "image_to_video")
_IMAGE_TYPES = (
    "text_to_image",
    "image_to_image",
    "image_edit",
    "image_inpaint",
    "local_edit",
)
_ASSET_TYPES = ("local_asset", "local_frameset")


def _types_for_media(media: str | None) -> list[str] | None:
    """把 media 参数翻成 generation_type 列表，None 表示不过滤。"""
    if media == "video":
        return list(_VIDEO_TYPES)
    if media == "image":
        return list(_IMAGE_TYPES)
    if media == "asset":
        return list(_ASSET_TYPES)
    return None


def _overall_progress(tasks) -> int:
    """整体进度按任务数平均，避免 8 张里前 7 张完成却显示 99%。"""
    if not tasks:
        return 0
    return round(sum(task.progress for task in tasks) / len(tasks))


def _to_read(generation) -> GenerationRead:
    payload = GenerationRead.model_validate(generation)
    # 进了回收站的产物与任务不在作品流里出现，但仍是这一批的成员（恢复后原样回来）
    live_images = {image.id for image in generation.images if image.deleted_at is None}
    live_tasks = [task for task in generation.tasks if task.deleted_at is None]
    live_task_ids = {task.id for task in live_tasks}
    payload.images = [image for image in payload.images if image.id in live_images]
    payload.tasks = [task for task in payload.tasks if task.id in live_task_ids]
    payload.progress = _overall_progress(live_tasks)
    payload.reference_images = decode_reference_paths(
        generation.reference_image_paths, generation.reference_image_path
    )
    payload.has_mask = bool(generation.mask_image_path)
    # 产物名：批次名（或「批次 #id」）+ 批内序号，资产选择器里用来区分同款
    base = (generation.name or "").strip() or f"批次 #{generation.id}"
    for index, image in enumerate(payload.images, start=1):
        image.label = f"{base} · 第 {index} 个"
    return payload


async def _validated_upload(upload: UploadFile, label: str) -> tuple[bytes, str]:
    """读入并校验一张参考图，返回内容与扩展名。"""
    content = await upload.read()
    if not content:
        raise HTTPException(status_code=422, detail=f"{label}内容为空")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{label}过大（{len(content) // 1024} KB），"
                f"上限 {MAX_UPLOAD_BYTES // 1024 // 1024} MB"
            ),
        )
    extension = detect_image_extension(content)
    if extension is None:
        raise HTTPException(status_code=422, detail=f"{label}必须是 PNG / JPEG / WEBP")
    return content, extension


def _parse_datetime(value: str | None, field: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"{field} 需要 ISO 时间，收到 {value!r}") from exc


@router.post("", response_model=GenerationRead, status_code=status.HTTP_201_CREATED)
def create(
    payload: GenerationCreate, db: Session = Depends(get_db)
) -> GenerationRead:
    """创建一次文生图请求：只落库为 pending，由 Worker 串行执行。"""
    try:
        generation = create_generation(db, payload)
    except GenerationValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _to_read(generation)


@router.post("/edit", response_model=GenerationRead, status_code=status.HTTP_201_CREATED)
async def create_edit(
    prompt: str = Form(..., min_length=1, max_length=8000),
    model: str = Form(..., min_length=1, max_length=64),
    count: int = Form(1, ge=1),
    width: int | None = Form(None, ge=64, le=4096),
    height: int | None = Form(None, ge=64, le=4096),
    negative_prompt: str | None = Form(None, max_length=8000),
    seed: int | None = Form(None, ge=0, le=2**31 - 1),
    steps: int | None = Form(None, ge=1, le=100),
    cfg: float | None = Form(None, ge=0, le=30),
    sampler: str | None = Form(None, max_length=64),
    images: list[UploadFile] = File(default=[]),
    mask: UploadFile | None = File(default=None),
    db: Session = Depends(get_db),
) -> GenerationRead:
    """创建一次图片编辑请求（multipart，1 张必填 + 1 张可选）。

    第 1 张决定被编辑的画面（潜空间与构图都跟它走），第 2 张只作为
    服装 / 材质 / 风格参考——用来做「把 A 的衣服换成 B 的」这类跨图编辑。
    再带一张遮罩（白=要改）时改走局部编辑：掩码外的像素原样保留。
    """
    limit = get_settings().max_reference_images
    if not images:
        raise HTTPException(
            status_code=422, detail="图片编辑至少需要 1 张参考图（第 1 张定结构）"
        )
    if len(images) > limit:
        raise HTTPException(
            status_code=422,
            detail=f"图片编辑最多 {limit} 张参考图（第 2 张可选），收到 {len(images)} 张",
        )

    paths: list[str] = []
    for index, upload in enumerate(images, start=1):
        content, extension = await _validated_upload(upload, f"第 {index} 张参考图")
        try:
            paths.append(store_upload(content, extension=extension))
        except ImageStoreError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    mask_path: str | None = None
    if mask is not None:
        content, extension = await _validated_upload(mask, "遮罩")
        try:
            mask_path = store_upload(content, extension=extension)
        except ImageStoreError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    payload = GenerationCreate(
        prompt=prompt,
        model=model,
        generation_type="image_edit",
        width=width,
        height=height,
        count=count,
        negative_prompt=negative_prompt,
        seed=seed,
        steps=steps,
        cfg=cfg,
        sampler=sampler,
    )
    try:
        generation = create_generation(
            db, payload, reference_image_paths=paths, mask_image_path=mask_path
        )
    except GenerationValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _to_read(generation)


@router.post(
    "/image-to-image", response_model=GenerationRead, status_code=status.HTTP_201_CREATED
)
async def create_image_to_image(
    prompt: str = Form(..., min_length=1, max_length=8000),
    model: str = Form(..., min_length=1, max_length=64),
    count: int = Form(1, ge=1),
    width: int | None = Form(None, ge=64, le=4096),
    height: int | None = Form(None, ge=64, le=4096),
    negative_prompt: str | None = Form(None, max_length=8000),
    seed: int | None = Form(None, ge=0, le=2**31 - 1),
    steps: int | None = Form(None, ge=1, le=100),
    cfg: float | None = Form(None, ge=0, le=30),
    sampler: str | None = Form(None, max_length=64),
    images: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
) -> GenerationRead:
    """创建一次图生图请求（multipart，带 1–2 张参考图）。

    与图片编辑的区别：参考图只进条件，输出按 width/height 新开一张，
    所以宽高生效、不跟随参考图比例。
    """
    limit = get_settings().max_reference_images
    if not images:
        raise HTTPException(status_code=422, detail="图生图至少需要 1 张参考图")
    if len(images) > limit:
        raise HTTPException(
            status_code=422,
            detail=f"图生图最多 {limit} 张参考图，收到 {len(images)} 张",
        )

    paths: list[str] = []
    for index, upload in enumerate(images, start=1):
        content, extension = await _validated_upload(upload, f"第 {index} 张参考图")
        try:
            paths.append(store_upload(content, extension=extension))
        except ImageStoreError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    payload = GenerationCreate(
        prompt=prompt,
        model=model,
        generation_type="image_to_image",
        width=width,
        height=height,
        count=count,
        negative_prompt=negative_prompt,
        seed=seed,
        steps=steps,
        cfg=cfg,
        sampler=sampler,
    )
    try:
        generation = create_generation(db, payload, reference_image_paths=paths)
    except GenerationValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _to_read(generation)


@router.post(
    "/image-to-video", response_model=GenerationRead, status_code=status.HTTP_201_CREATED
)
async def create_image_to_video(
    prompt: str = Form(..., min_length=1, max_length=8000),
    model: str = Form(..., min_length=1, max_length=64),
    duration_seconds: float | None = Form(None, ge=1, le=30),
    fps: float | None = Form(None, ge=1, le=120),
    width: int | None = Form(None, ge=64, le=4096),
    height: int | None = Form(None, ge=64, le=4096),
    count: int = Form(1, ge=1, le=4),
    seed: int | None = Form(None, ge=0, le=2**31 - 1),
    files: list[UploadFile] = File(default=[]),
    db: Session = Depends(get_db),
) -> GenerationRead:
    """创建一次图生视频请求（multipart）。

    第一张图当首帧、第二张当尾帧，两张都可以不给（都不给就退化成文生视频）；
    只给首帧就是「从这张图开始动」。
    """
    limit = get_settings().max_reference_images
    if len(files) > limit:
        raise HTTPException(
            status_code=422,
            detail=f"图生视频最多 {limit} 张图（首帧 + 尾帧），收到 {len(files)} 张",
        )

    labels = ("首帧", "尾帧")
    paths: list[str] = []
    for index, upload in enumerate(files):
        content, extension = await _validated_upload(upload, labels[index])
        try:
            paths.append(store_upload(content, extension=extension))
        except ImageStoreError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    payload = GenerationCreate(
        prompt=prompt,
        model=model,
        generation_type="image_to_video" if paths else "text_to_video",
        width=width,
        height=height,
        count=count,
        seed=seed,
        duration_seconds=duration_seconds,
        fps=fps,
    )
    try:
        generation = create_generation(db, payload, reference_image_paths=paths)
    except GenerationValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _to_read(generation)


@router.get("/{generation_id}/reference")
def get_reference(
    generation_id: int,
    index: int = Query(default=0, ge=0, description="第几张参考图，从 0 开始"),
    db: Session = Depends(get_db),
) -> FileResponse:
    """回显该次生成使用的参考图（前端历史里用）。"""
    generation = GenerationRepository(db).get(generation_id)
    if generation is None:
        raise HTTPException(status_code=404, detail=f"generation {generation_id} 不存在")
    paths = decode_reference_paths(
        generation.reference_image_paths, generation.reference_image_path
    )
    if not paths:
        raise HTTPException(
            status_code=404, detail=f"generation {generation_id} 没有参考图"
        )
    if index >= len(paths):
        raise HTTPException(
            status_code=404,
            detail=f"generation {generation_id} 只有 {len(paths)} 张参考图，没有第 {index + 1} 张",
        )
    path = storage_root_for() / paths[index]
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"参考图文件缺失：{path}")
    return FileResponse(path)


@router.get("/{generation_id}/mask")
def get_mask(
    generation_id: int,
    db: Session = Depends(get_db),
) -> FileResponse:
    """回显该次局部编辑使用的遮罩（前端历史里用）。"""
    generation = GenerationRepository(db).get(generation_id)
    if generation is None:
        raise HTTPException(status_code=404, detail=f"generation {generation_id} 不存在")
    if not generation.mask_image_path:
        raise HTTPException(
            status_code=404, detail=f"generation {generation_id} 没有遮罩"
        )
    path = storage_root_for() / generation.mask_image_path
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"遮罩文件缺失：{path}")
    return FileResponse(path)


@router.get("", response_model=GenerationListResponse)
def list_generations(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    q: str | None = Query(default=None, max_length=200),
    model: str | None = Query(default=None, description="模型 id，多个用逗号分隔"),
    media: str | None = Query(default=None, description="image / video / asset，只取该类别"),
    favorite: bool = Query(default=False, description="只看含收藏图片的批次"),
    has_products: bool = Query(
        default=False,
        description="只取有产物（或有任务在排队/生成）的批次，跳过只剩空壳的批次",
    ),
    date_from: str | None = Query(default=None, description="ISO 时间，含"),
    date_to: str | None = Query(default=None, description="ISO 时间，含"),
    db: Session = Depends(get_db),
) -> GenerationListResponse:
    models = [item.strip() for item in model.split(",") if item.strip()] if model else None
    if media is not None and media not in ("image", "video", "asset"):
        raise HTTPException(
            status_code=422, detail=f"media 只能是 image、video 或 asset，收到 {media!r}"
        )
    rows, total = GenerationRepository(db).list(
        limit=limit,
        offset=offset,
        q=q,
        models=models,
        types=_types_for_media(media),
        favorites_only=favorite,
        with_products=has_products,
        date_from=_parse_datetime(date_from, "date_from"),
        date_to=_parse_datetime(date_to, "date_to"),
    )
    return GenerationListResponse(
        items=[_to_read(row) for row in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.patch("/{generation_id}", response_model=GenerationRead)
def rename_generation(
    generation_id: int,
    payload: GenerationRename,
    db: Session = Depends(get_db),
) -> GenerationRead:
    """给批次起名（产物就叫「名字 · 第 N 个」）；传空字符串就是清掉名字。"""
    generation = GenerationRepository(db).get(generation_id)
    if generation is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"generation {generation_id} 不存在"
        )
    name = (payload.name or "").strip()
    generation.name = name or None
    db.commit()
    db.refresh(generation)
    return _to_read(generation)


@router.get("/{generation_id}", response_model=GenerationRead)
def get_generation(generation_id: int, db: Session = Depends(get_db)) -> GenerationRead:
    generation = GenerationRepository(db).get(generation_id)
    if generation is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"generation {generation_id} 不存在"
        )
    return _to_read(generation)


@router.delete("/{generation_id}")
def delete_generation(generation_id: int, db: Session = Depends(get_db)) -> dict[str, int]:
    """删掉一整个批次：任务、产物一起进回收站，30 天内可恢复。

    和「清空工作区」的区别只在范围；批次里还有任务在排队/生成时拒绝，避免把正在跑的结果写丢。
    """
    generation = GenerationRepository(db).get(generation_id)
    if generation is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"generation {generation_id} 不存在"
        )

    busy = [
        task
        for task in generation.tasks
        if task.deleted_at is None
        and task.status in (TaskStatus.QUEUED, TaskStatus.RUNNING)
    ]
    if busy:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"批次里还有 {len(busy)} 个任务在执行，先取消再删除",
        )

    task_count = len([task for task in generation.tasks if task.deleted_at is None])
    images = soft_delete_generation(db, generation)
    return {"generation_id": generation_id, "images": images, "tasks": task_count}
