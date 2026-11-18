"""生成请求的业务逻辑。

P1 只负责「校验 + 落库」：生成 N 条 pending 任务，不触碰 ComfyUI。
"""

from __future__ import annotations

import json
from pathlib import Path
import secrets
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.generation import Generation, GenerationStatus, GenerationType
from app.models.image import Image
from app.models.task import GenerationTask, TaskStatus
from app.models.workflow import Workflow, utcnow
from app.schemas.generation import GenerationCreate
from app.services import workflow_service
from app.services.image_service import store_image

MAX_SEED = 2**31 - 1

_ACTIVE = {TaskStatus.PENDING, TaskStatus.QUEUED, TaskStatus.RUNNING}


class GenerationValidationError(ValueError):
    """请求本身合法（通过 Pydantic）但业务上不成立。"""


def aggregate_generation_status(statuses: Sequence[str]) -> GenerationStatus:
    """由子任务状态推出整体状态：还有活跃任务就跟着它，全终态再判成败。"""
    if not statuses:
        return GenerationStatus.PENDING
    active = [status for status in statuses if status in _ACTIVE]
    if active:
        if TaskStatus.RUNNING in active:
            return GenerationStatus.RUNNING
        if TaskStatus.QUEUED in active:
            return GenerationStatus.QUEUED
        return GenerationStatus.PENDING
    if all(status == TaskStatus.COMPLETED for status in statuses):
        return GenerationStatus.COMPLETED
    if any(status == TaskStatus.COMPLETED for status in statuses):
        # 部分成功仍然是可用结果：取消掉一半不该让已有的图变成「失败」
        return GenerationStatus.COMPLETED
    if all(status == TaskStatus.CANCELLED for status in statuses):
        return GenerationStatus.CANCELLED
    return GenerationStatus.FAILED


def _distinct_seeds(count: int) -> list[int]:
    seeds: list[int] = []
    seen: set[int] = set()
    while len(seeds) < count:
        seed = secrets.randbelow(MAX_SEED)
        if seed in seen:
            continue
        seen.add(seed)
        seeds.append(seed)
    return seeds


def _fixed_seeds(base: int, count: int) -> list[int]:
    """固定 seed 模式下，第 i 张用 base+i，保证同批可复现且互不重复。"""
    return [(base + index) % MAX_SEED for index in range(count)]


def new_seed(exclude: Sequence[int] = ()) -> int:
    """重试用的新 seed：保证和这一批里已有的不撞。"""
    taken = set(exclude)
    while True:
        seed = secrets.randbelow(MAX_SEED)
        if seed not in taken:
            return seed


def sync_generation_status(db: Session, generation: Generation) -> GenerationStatus:
    """按子任务状态刷新整体状态并落库。"""
    generation.status = aggregate_generation_status([task.status for task in generation.tasks])
    if generation.status == GenerationStatus.COMPLETED and generation.completed_at is None:
        generation.completed_at = utcnow()
    elif generation.status not in (GenerationStatus.COMPLETED, GenerationStatus.FAILED):
        generation.completed_at = None
    db.commit()
    return generation.status


def reset_interrupted_tasks(db: Session) -> int:
    """把上次进程退出时卡在 queued/running 的任务复位成 pending。

    Worker 是单进程内存队列，进程一死这些任务就永远不会有人捡了；
    启动时统一复位，避免界面上一排永不结束的 running。
    """
    stuck = list(
        db.scalars(
            select(GenerationTask).where(
                GenerationTask.status.in_([TaskStatus.QUEUED, TaskStatus.RUNNING])
            )
        ).all()
    )
    if not stuck:
        return 0

    touched: set[int] = set()
    for task in stuck:
        task.status = TaskStatus.PENDING
        task.progress = 0
        task.started_at = None
        task.completed_at = None
        task.comfy_prompt_id = None
        task.error_message = None
        touched.add(task.generation_id)
    db.commit()

    for generation_id in touched:
        generation = db.get(Generation, generation_id)
        if generation is not None:
            sync_generation_status(db, generation)
    return len(stuck)


def encode_reference_paths(paths: Sequence[str]) -> str | None:
    """参考图路径统一存成 JSON 数组，空列表存 None。"""
    cleaned = [path for path in paths if path]
    return json.dumps(cleaned, ensure_ascii=False) if cleaned else None


def decode_reference_paths(raw: str | None, fallback: str | None = None) -> list[str]:
    """读回参考图路径；旧数据只有 reference_image_path 时用它兜底。"""
    if raw:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = None
        if isinstance(data, list):
            return [str(path) for path in data if path]
    return [fallback] if fallback else []


def create_generation(
    db: Session,
    payload: GenerationCreate,
    *,
    reference_image_path: str | None = None,
    reference_image_paths: Sequence[str] | None = None,
    mask_image_path: str | None = None,
) -> Generation:
    settings = get_settings()
    prompt = payload.prompt.strip()
    if not prompt:
        raise GenerationValidationError("prompt 不能为空")
    if payload.count > settings.max_generation_count:
        raise GenerationValidationError(
            f"单次最多生成 {settings.max_generation_count} 张，收到 {payload.count}"
        )

    model = workflow_service.get_model(payload.model)
    if model is None:
        available = ", ".join(item.id for item in workflow_service.list_models())
        raise GenerationValidationError(f"未知模型 '{payload.model}'，可选: {available}")

    paths = [path for path in (reference_image_paths or ()) if path]
    if not paths and reference_image_path:
        paths = [reference_image_path]

    # 图生视频但首帧尾帧都没给：按约定退化成文生视频，而不是报错
    generation_type = GenerationType(payload.generation_type)
    if generation_type == GenerationType.IMAGE_TO_VIDEO and not paths:
        generation_type = GenerationType.TEXT_TO_VIDEO
    # 编辑带了遮罩：输入完全一样，只是换一张带 SetLatentNoiseMask 的图，
    # 掩码外的像素由 VAEEncode 原样保留
    if generation_type == GenerationType.IMAGE_EDIT and mask_image_path:
        generation_type = GenerationType.IMAGE_INPAINT
    is_video = generation_type.is_video

    target = workflow_service.get_workflow_target(model, generation_type)
    if target is None:
        raise GenerationValidationError(
            f"模型 '{model.id}' 不支持任务类型 '{generation_type}'"
        )

    if is_video:
        # 视频一次最多 4 条（串行出，每条约 1–3 分钟）；上限写在模型能力里，
        # 免得以后换模型还要改这里。
        limit = int(model.capabilities.max_count or settings.max_generation_count)
        if payload.count > limit:
            raise GenerationValidationError(
                f"视频一次最多生成 {limit} 条，收到 {payload.count}"
            )
        duration = payload.duration_seconds or model.defaults.get("duration_seconds")
        low = float(model.capabilities.duration_min)
        high = float(model.capabilities.duration_max)
        if duration is None or not (low <= float(duration) <= high):
            raise GenerationValidationError(
                f"视频时长需要在 {low:g}–{high:g} 秒之间，收到 {duration}"
            )
        fps = payload.fps or model.defaults.get("fps")
        if fps is None or float(fps) <= 0:
            raise GenerationValidationError("视频帧率必须大于 0")
        if len(paths) > settings.max_reference_images:
            raise GenerationValidationError(
                f"图生视频最多 {settings.max_reference_images} 张图（首帧 + 尾帧），收到 {len(paths)} 张"
            )
    elif generation_type in (GenerationType.IMAGE_EDIT, GenerationType.IMAGE_INPAINT):
        # 第 1 张定结构（必填），第 2 张可选的服装 / 材质参考
        if not paths:
            raise GenerationValidationError("图片编辑至少需要 1 张参考图（第 1 张定结构）")
        if len(paths) > settings.max_reference_images:
            raise GenerationValidationError(
                f"图片编辑最多 {settings.max_reference_images} 张参考图（第 2 张可选），收到 {len(paths)} 张"
            )
    elif generation_type == GenerationType.IMAGE_TO_IMAGE:
        if not paths:
            raise GenerationValidationError("图生图必须提供 1 张参考图")
        if len(paths) > settings.max_reference_images:
            raise GenerationValidationError(
                f"图生图最多 {settings.max_reference_images} 张参考图，收到 {len(paths)} 张"
            )
    else:
        paths = []

    # 编辑的输出比例跟随参考图，width/height 只决定像素量级（映射到节点的 resolution）
    width = int(payload.width or model.defaults.get("width") or 0)
    height = int(payload.height or model.defaults.get("height") or 0)
    if is_video:
        # MiniMax 的 width/height 在节点里是 step=32，不对齐会被 ComfyUI 静默改值
        for name, value in (("宽", width), ("高", height)):
            if value % 32:
                raise GenerationValidationError(f"视频{name}度必须是 32 的倍数，收到 {value}")

    negative_prompt = (payload.negative_prompt or "").strip() or None
    cfg = payload.cfg if payload.cfg is not None else model.defaults.get("cfg")
    # ComfyUI 在 cfg≈1 时会走 cfg1 优化，直接跳过 uncond 分支（comfy/samplers.py:610），
    # 负面提示词因此完全不参与采样。用户没有显式指定 CFG 时，按模型建议值自动提上去；
    # 显式给了 CFG（包括显式 1.0）一律尊重，落库的就是实际生效值。
    if negative_prompt and payload.cfg is None and model.negative_prompt_cfg:
        if cfg is None or float(cfg) <= 1.0:
            cfg = model.negative_prompt_cfg

    workflow_row = db.scalar(
        select(Workflow).where(Workflow.name == model.label, Workflow.type == target.type)
    )

    generation = Generation(
        prompt=prompt,
        workflow_id=workflow_row.id if workflow_row else None,
        generation_type=str(generation_type),
        model_name=model.id,
        width=width,
        height=height,
        requested_count=payload.count,
        status="pending",
        reference_image_path=paths[0] if paths else None,
        reference_image_paths=encode_reference_paths(paths),
        mask_image_path=mask_image_path if generation_type == GenerationType.IMAGE_INPAINT else None,
        negative_prompt=negative_prompt,
        steps=payload.steps,
        cfg=cfg,
        sampler=payload.sampler,
        duration_seconds=float(duration) if is_video and duration is not None else None,
        fps=float(fps) if is_video and fps is not None else None,
    )
    if payload.seed is not None:
        seeds = _fixed_seeds(payload.seed, payload.count)
    else:
        seeds = _distinct_seeds(payload.count)
    for seed in seeds:
        generation.tasks.append(
            GenerationTask(seed=seed, status=TaskStatus.PENDING, progress=0)
        )

    db.add(generation)
    db.commit()
    db.refresh(generation)
    return generation


def create_local_edit(
    db: Session,
    *,
    content: bytes,
    width: int,
    height: int,
    prompt: str,
    source_image: Image | None = None,
) -> tuple[Generation, Image]:
    """把本地编辑器导出的 PNG 存成一条已完成的作品记录。

    编辑器不经过 ComfyUI，所以这里直接建 generation + 一个已完成 task + 图片行，
    产物与生成出来的图完全同构（同样的目录、同样的 /images 接口、同样的收藏与删除）。
    """
    now = utcnow()
    generation = Generation(
        prompt=prompt,
        generation_type=str(GenerationType.LOCAL_EDIT),
        model_name="local_editor",
        width=width,
        height=height,
        requested_count=1,
        status=GenerationStatus.COMPLETED,
        completed_at=now,
    )
    task = GenerationTask(
        seed=None,
        status=TaskStatus.COMPLETED,
        progress=100,
        started_at=now,
        completed_at=now,
    )
    generation.tasks.append(task)
    db.add(generation)
    db.flush()

    image = store_image(
        db,
        content=content,
        generation_id=generation.id,
        task_id=task.id,
        index=0,
        width=width,
        height=height,
    )
    if source_image is not None:
        image.original_image_id = source_image.id
        generation.reference_image_path = source_image.file_path
    db.commit()
    db.refresh(generation)
    return generation, image


def replace_local_asset(
    db: Session,
    *,
    image: Image,
    content: bytes,
    filename: str,
    width: int = 0,
    height: int = 0,
    prompt: str | None = None,
    poster: bytes | None = None,
) -> tuple[Generation, Image]:
    """用新导出的图集覆盖已有的素材记录。

    覆盖 = 删掉旧产物（行 + 文件 + 缩略图）再在同一批次/任务下写一份新的：
    - 批次 id 不变，所以资产库里不会多出一条，时间线也不跳；
    - 产物 id 复用旧的（外部链接不失效），前端靠 `?v=<created_at>` 的变化拿到新文件；
    - 旧文件当场删除，这是用户要的「覆盖」，不是版本历史。
    """
    from app.services.image_service import remove_files, store_image

    generation = image.generation
    if generation is None:
        raise ValueError("这条素材没有所属批次，无法覆盖")
    task_id = image.task_id
    if task_id is None:
        raise ValueError("这条素材没有所属任务，无法覆盖")

    suffix = Path(filename).suffix.lower() or ".bin"
    # 覆盖后仍用同一个产物 id：外部链接（详情弹窗、深链、收藏）不会失效，
    # 缓存则靠 created_at 变化时的 ?v= 版本串自然失效。
    keep_id = image.id
    remove_files(image)
    db.delete(image)
    db.flush()

    if prompt:
        generation.prompt = prompt
    generation.width = width
    generation.height = height
    generation.completed_at = utcnow()

    replaced = store_image(
        db,
        content=content,
        generation_id=generation.id,
        task_id=task_id,
        index=0,
        width=width,
        height=height,
        extension=suffix.lstrip("."),
        media_type="asset",
        poster=poster,
    )
    replaced.id = keep_id
    db.commit()
    db.refresh(generation)
    db.refresh(replaced)
    return generation, replaced

def create_local_asset(
    db: Session,
    *,
    content: bytes,
    filename: str,
    width: int = 0,
    height: int = 0,
    prompt: str,
    poster: bytes | None = None,
    source_image: Image | None = None,
) -> tuple[Generation, Image]:
    """把外部产物（图集 ZIP、atlas.png、atlas.json）存成一条「素材」记录。

    素材和生成图共用 images 表，靠 media_type="asset" 与 storage/assets/ 目录区分；
    ZIP / JSON 没法预览，就用调用方给的 poster（通常是图集的第一张 PNG）当缩略图。
    """
    from app.services.image_service import store_image

    suffix = Path(filename).suffix.lower() or ".bin"
    now = utcnow()
    generation = Generation(
        prompt=prompt,
        generation_type=str(GenerationType.LOCAL_ASSET),
        model_name="spriteforge",
        width=width,
        height=height,
        requested_count=1,
        status=GenerationStatus.COMPLETED,
        completed_at=now,
    )
    task = GenerationTask(
        seed=None,
        status=TaskStatus.COMPLETED,
        progress=100,
        started_at=now,
        completed_at=now,
    )
    generation.tasks.append(task)
    db.add(generation)
    db.flush()

    image = store_image(
        db,
        content=content,
        generation_id=generation.id,
        task_id=task.id,
        index=0,
        width=width,
        height=height,
        extension=suffix.lstrip("."),
        media_type="asset",
        poster=poster,
    )
    if source_image is not None:
        image.original_image_id = source_image.id
        generation.reference_image_path = source_image.file_path
    db.commit()
    db.refresh(generation)
    return generation, image