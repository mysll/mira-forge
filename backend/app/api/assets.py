"""素材：把工坊导出的图集（PNG / JSON / ZIP）存进资产库。

和 `/editor/save` 同一套路：不经过 ComfyUI，直接建一条已完成的 generation
（`generation_type="local_asset"`）+ 一个已完成 task + 一行产物，文件落在
`storage/assets/`。ZIP 与 JSON 没法预览，所以尽量给一张 poster（通常是图集第一页）
当缩略图；拿不到就退回占位（宽度 0）。
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.models.database import get_db
from app.models.image import Image
from app.schemas.asset import AssetSaved
from app.services.generation_service import create_local_asset

router = APIRouter(prefix="/assets", tags=["assets"])

MAX_ASSET_BYTES = 64 * 1024 * 1024
ALLOWED_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".json", ".zip"}


def _image_dimensions(content: bytes) -> tuple[int, int]:
    try:
        from PIL import Image as PillowImage

        with PillowImage.open(io.BytesIO(content)) as opened:
            return int(opened.width), int(opened.height)
    except Exception:  # noqa: BLE001 - 拿不到尺寸不该挡住保存
        return 0, 0


def _first_png_from_zip(content: bytes) -> bytes | None:
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            for name in archive.namelist():
                if name.lower().endswith(".png"):
                    return archive.read(name)
    except Exception:  # noqa: BLE001 - 坏 ZIP 就按无封面处理
        return None
    return None


@router.post("", response_model=AssetSaved, status_code=201)
async def save_asset(
    file: UploadFile = File(...),
    name: str | None = Form(None),
    prompt: str | None = Form(None),
    source_image_id: int | None = Form(None),
    db: Session = Depends(get_db),
) -> AssetSaved:
    filename = Path(file.filename or "asset.bin").name
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(
            status_code=422,
            detail=f"素材只支持 PNG / JPEG / WebP / JSON / ZIP，收到 {suffix or '无扩展名'}",
        )

    content = await file.read()
    if not content:
        raise HTTPException(status_code=422, detail="素材内容为空")
    if len(content) > MAX_ASSET_BYTES:
        raise HTTPException(
            status_code=422,
            detail=f"素材不能超过 {MAX_ASSET_BYTES // (1024 * 1024)} MB，收到 {len(content) / (1024 * 1024):.1f} MB",
        )

    poster: bytes | None = None
    width = height = 0
    if suffix == ".zip":
        poster = _first_png_from_zip(content)
        if poster:
            width, height = _image_dimensions(poster)
    elif suffix in {".png", ".jpg", ".jpeg", ".webp"}:
        width, height = _image_dimensions(content)
        poster = content
    else:
        width, height = 0, 0

    source: Image | None = None
    if source_image_id is not None:
        source = db.get(Image, source_image_id)

    label = (name or "").strip() or filename
    text = (prompt or "").strip() or f"素材 · {label}"

    generation, image = create_local_asset(
        db,
        content=content,
        filename=filename,
        width=width,
        height=height,
        prompt=text[:500],
        poster=poster,
        source_image=source,
    )

    return AssetSaved(
        generation_id=generation.id,
        image_id=image.id,
        name=filename,
        file_size=image.file_size,
        width=image.width,
        height=image.height,
        media_type=image.media_type,
    )
