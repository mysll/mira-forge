"""本地图片编辑器接口。

与生成式图片编辑（`/generations/edit`，走 ComfyUI）完全分开：
这里的操作是确定性的、秒级返回、不占用 GPU。除了 `/editor/save`
会把成品存进资产库（建一条 `local_edit` 记录），其余都是无状态处理。
"""

from __future__ import annotations

import binascii

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.models.database import get_db
from app.models.image import Image
from app.schemas.editor import LocalEditSaved
from app.services.generation_service import create_local_edit

from app.services.editor_service import (
    EditorError,
    describe,
    load_image,
    remove_background,
    trim_transparent,
)

router = APIRouter(prefix="/editor", tags=["editor"])

PNG_MEDIA = "image/png"


def _hex(color: tuple[int, int, int]) -> str:
    return "#{:02x}{:02x}{:02x}".format(*color)


def _parse_color(value: str | None) -> tuple[int, int, int] | None:
    """接受 `#rrggbb` / `rrggbb`；解析不了就当没给（让服务自己估）。"""
    if not value:
        return None
    text = value.strip().lstrip("#")
    if len(text) != 6:
        return None
    try:
        return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))
    except ValueError:
        return None


async def _read_image(image: UploadFile) -> bytes:
    content = await image.read()
    if not content:
        raise HTTPException(status_code=422, detail="图片是空的")
    return content


@router.post("/analyze")
async def analyze(image: UploadFile = File(...)) -> dict[str, object]:
    """读尺寸、估计背景色与建议容差，供编辑器一开始就把面板填好。"""
    content = await _read_image(image)
    try:
        parsed = await run_in_threadpool(load_image, content)
        return await run_in_threadpool(describe, parsed)
    except EditorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/remove-background")
async def remove_background_endpoint(
    image: UploadFile = File(...),
    mode: str = Form("edge"),
    tolerance: int = Form(22),
    feather: int = Form(1),
    denoise: int = Form(0),
    color: str | None = Form(None),
    channel: str = Form("max"),
) -> Response:
    """把背景抠成透明，直接返回 PNG 字节。

    结果放在响应体里而不是落盘：编辑器是即时预览，产物的去留由用户决定。
    """
    content = await _read_image(image)
    try:
        parsed = await run_in_threadpool(load_image, content)
        result = await run_in_threadpool(
            remove_background,
            parsed,
            mode=mode,
            tolerance=tolerance,
            feather=feather,
            denoise=denoise,
            color=_parse_color(color),
            channel=channel,
        )
    except EditorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return Response(
        content=result.png,
        media_type=PNG_MEDIA,
        headers={
            "X-Background-Color": _hex(result.background),
            "X-Removed-Ratio": f"{result.removed_ratio:.4f}",
            "X-Image-Width": str(result.width),
            "X-Image-Height": str(result.height),
            "Cache-Control": "no-store",
        },
    )


@router.post("/trim")
async def trim_endpoint(
    image: UploadFile = File(...),
    padding: int = Form(0),
) -> Response:
    """裁掉透明边，返回 PNG + `X-Content-Box: left,top,right,bottom`。"""
    content = await _read_image(image)
    try:
        parsed = await run_in_threadpool(load_image, content)
        result = await run_in_threadpool(trim_transparent, parsed, padding=padding)
    except EditorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return Response(
        content=result.png,
        media_type=PNG_MEDIA,
        status_code=status.HTTP_200_OK,
        headers={
            "X-Content-Box": ",".join(str(value) for value in result.box),
            "X-Image-Width": str(result.width),
            "X-Image-Height": str(result.height),
            "Cache-Control": "no-store",
        },
    )


@router.post("/decode")
async def decode_endpoint(image: UploadFile = File(...)) -> dict[str, object]:
    """只做类型与尺寸校验，返回宽高（编辑器上传前先验一遍，避免大文件白传）。"""
    content = await _read_image(image)
    try:
        parsed = await run_in_threadpool(load_image, content)
    except EditorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except binascii.Error as exc:  # pragma: no cover - 兜底，理论上 load_image 已拦住
        raise HTTPException(status_code=422, detail=f"图片解析失败：{exc}") from exc
    return {
        "width": parsed.width,
        "height": parsed.height,
        "bytes": len(content),
    }


@router.post("/save", response_model=LocalEditSaved, status_code=status.HTTP_201_CREATED)
async def save_edited_image(
    image: UploadFile = File(...),
    source_image_id: int | None = Form(None),
    prompt: str | None = Form(None),
    db: Session = Depends(get_db),
) -> LocalEditSaved:
    """把编辑器导出的 PNG 存进资产库。

    存成 `local_edit` 类型的一条已完成记录：不用模型、不排队、不碰 GPU，
    但在作品流、资产库、收藏与删除上的行为和生成出来的图完全一致。
    """
    content = await _read_image(image)
    loaded = await run_in_threadpool(load_image, content)

    source: Image | None = None
    if source_image_id is not None:
        source = db.scalar(select(Image).where(Image.id == source_image_id))

    label = (prompt or "").strip()
    if not label:
        label = "本地编辑"
        if source is not None:
            label = f"本地编辑 · 来自图 #{source.id}"

    generation, image = await run_in_threadpool(
        create_local_edit,
        db,
        content=content,
        width=loaded.width,
        height=loaded.height,
        prompt=label[:500],
        source_image=source,
    )
    return LocalEditSaved(
        generation_id=generation.id,
        image_id=image.id,
        width=image.width,
        height=image.height,
        file_size=image.file_size,
    )
