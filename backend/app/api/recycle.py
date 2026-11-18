"""回收站接口：列出被删的产物、恢复、彻底删除、清空。

删除动作本身发生在各自的资源端点上（`DELETE /images/{id}`、`DELETE /tasks/{id}`、
`DELETE /generations/{id}`、`POST /images/clear`），它们现在都是软删除；
这里只负责查看与清理。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.models.database import get_db
from app.models.image import Image
from app.schemas.recycle import (
    RecycleClearResponse,
    RecycleItem,
    RecycleListResponse,
    RecycleRestoreRequest,
    RecycleRestoreResponse,
)
from app.services.recycle_service import (
    RETENTION_DAYS,
    clear_bin,
    days_left,
    delete_forever,
    expires_at,
    list_bin,
    purge_expired,
    restore_images,
)

router = APIRouter(prefix="/recycle-bin", tags=["recycle-bin"])


def _to_item(image: Image) -> RecycleItem:
    generation = image.generation
    return RecycleItem(
        id=image.id,
        generation_id=image.generation_id,
        task_id=image.task_id,
        file_path=image.file_path,
        thumbnail_path=image.thumbnail_path,
        media_type=image.media_type,
        width=image.width,
        height=image.height,
        file_size=image.file_size,
        duration_seconds=image.duration_seconds,
        fps=image.fps,
        frame_count=image.frame_count,
        created_at=image.created_at,
        deleted_at=image.deleted_at,
        expires_at=expires_at(image.deleted_at),
        days_left=days_left(image.deleted_at),
        prompt=generation.prompt if generation else "",
        model_name=generation.model_name if generation else "",
        generation_type=generation.generation_type if generation else "",
    )


@router.get("", response_model=RecycleListResponse)
def list_recycle_bin(
    limit: int = Query(default=60, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    media: str | None = Query(default=None, pattern="^(image|video|asset|frameset)$"),
    db: Session = Depends(get_db),
) -> RecycleListResponse:
    """回收站列表。顺带清理过期的条目，所以打开页面就会自动过期。"""
    purge_expired(db)
    rows, total = list_bin(db, limit=limit, offset=offset, media=media)
    return RecycleListResponse(
        items=[_to_item(row) for row in rows],
        total=total,
        limit=limit,
        offset=offset,
        retention_days=RETENTION_DAYS,
    )


@router.post("/restore", response_model=RecycleRestoreResponse)
def restore(
    payload: RecycleRestoreRequest,
    db: Session = Depends(get_db),
) -> RecycleRestoreResponse:
    """恢复选中的产物；所属任务与批次一起解冻，作品流里立刻能再看到它们。"""
    restored, missing = restore_images(db, payload.ids)
    return RecycleRestoreResponse(restored=restored, missing=missing)


@router.post("/clear", response_model=RecycleClearResponse)
def clear_recycle_bin(db: Session = Depends(get_db)) -> RecycleClearResponse:
    """清空回收站：文件真正从磁盘删掉，不可恢复。"""
    return RecycleClearResponse(deleted=clear_bin(db))


@router.delete("/{image_id}", response_model=RecycleClearResponse)
def delete_forever_one(image_id: int, db: Session = Depends(get_db)) -> RecycleClearResponse:
    """彻底删除回收站里的单件产物。"""
    image = db.get(Image, image_id)
    if image is None or image.deleted_at is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"回收站里没有 id 为 {image_id} 的产物",
        )
    delete_forever(db, image)
    return RecycleClearResponse(deleted=1)
