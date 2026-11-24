"""图集（Kit）接口：条目增删、打包预览、导出 zip。"""

from __future__ import annotations

from io import BytesIO
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.core.projects import active_project
from app.models.database import get_db
from app.models.kit import Kit, KitItem
from app.schemas.kit import (
    AtlasSummary,
    KitCreate,
    KitDeleted,
    KitItemCreate,
    KitItemRead,
    KitItemUpdate,
    KitListResponse,
    KitRead,
    KitUpdate,
)
from app.services import kit_service
from app.services.kit_service import KitError

router = APIRouter(prefix="/kits", tags=["kits"])
items_router = APIRouter(prefix="/kit-items", tags=["kits"])


def _item_read(item: KitItem) -> KitItemRead:
    return KitItemRead(
        id=item.id,
        kit_id=item.kit_id,
        image_id=item.image_id,
        element_id=item.element_id,
        key=item.key,
        anchor=item.anchor,
        note=item.note,
        scale=float(item.scale or 1.0),
        sort_order=item.sort_order,
        created_at=item.created_at,
    )


def _to_read(kit: Kit, item_count: int | None = None, with_items: bool = True) -> KitRead:
    items = sorted(kit.items, key=lambda item: (item.sort_order, item.id))
    return KitRead(
        id=kit.id,
        name=kit.name,
        description=kit.description,
        padding=kit.padding,
        max_width=kit.max_width,
        cell=kit.cell,
        scene_id=kit.scene_id,
        created_at=kit.created_at,
        item_count=len(items) if item_count is None else item_count,
        items=[_item_read(item) for item in items] if with_items else [],
    )


def _kit_or_404(db: Session, kit_id: int) -> Kit:
    try:
        return kit_service.get_kit(db, kit_id)
    except KitError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get("", response_model=KitListResponse)
def list_kits(db: Session = Depends(get_db)) -> KitListResponse:
    rows = kit_service.list_kits(db)
    return KitListResponse(
        items=[_to_read(kit, count, with_items=False) for kit, count in rows],
        total=len(rows),
    )


@router.post("", response_model=KitRead, status_code=201)
def create_kit(payload: KitCreate, db: Session = Depends(get_db)) -> KitRead:
    try:
        kit = kit_service.create_kit(
            db,
            name=payload.name,
            description=payload.description,
            padding=payload.padding,
            max_width=payload.max_width,
            cell=payload.cell,
        scene_id=payload.scene_id,
        )
    except KitError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return _to_read(kit)


@router.get("/{kit_id}", response_model=KitRead)
def get_kit(kit_id: int, db: Session = Depends(get_db)) -> KitRead:
    return _to_read(_kit_or_404(db, kit_id))


@router.patch("/{kit_id}", response_model=KitRead)
def update_kit(kit_id: int, payload: KitUpdate, db: Session = Depends(get_db)) -> KitRead:
    kit = _kit_or_404(db, kit_id)
    try:
        kit = kit_service.update_kit(
            db, kit, fields=set(payload.model_fields_set), **payload.model_dump()
        )
    except KitError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return _to_read(kit)


@router.delete("/{kit_id}", response_model=KitDeleted)
def delete_kit(kit_id: int, db: Session = Depends(get_db)) -> KitDeleted:
    kit = _kit_or_404(db, kit_id)
    kit_service.delete_kit(db, kit)
    return KitDeleted(kit_id=kit_id)


@router.post("/{kit_id}/items", response_model=KitItemRead, status_code=201)
def add_item(kit_id: int, payload: KitItemCreate, db: Session = Depends(get_db)) -> KitItemRead:
    kit = _kit_or_404(db, kit_id)
    try:
        item = kit_service.add_item(
            db,
            kit,
            image_id=payload.image_id,
            element_id=payload.element_id,
            key=payload.key,
            anchor=payload.anchor,
            note=payload.note,
            scale=payload.scale,
        )
    except KitError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return _item_read(item)


@router.get("/{kit_id}/preview", response_model=AtlasSummary)
def preview(kit_id: int, db: Session = Depends(get_db)) -> AtlasSummary:
    kit = _kit_or_404(db, kit_id)
    try:
        _png, manifest = kit_service.build_atlas(
            db, kit, storage_root=active_project().storage_path
        )
    except KitError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    rects = {entry["id"]: entry for entry in manifest["items"]}
    items: list[KitItemRead] = []
    for item in sorted(kit.items, key=lambda row: row.key):
        read = _item_read(item)
        entry = rects.get(item.id)
        if entry:
            read.rect = {
                "x": entry["x"],
                "y": entry["y"],
                "w": entry["w"],
                "h": entry["h"],
                "bleed": entry["bleed"],
            }
        items.append(read)
    return AtlasSummary(
        width=manifest["width"],
        height=manifest["height"],
        cell=manifest.get("cell", 0),
        fill=manifest.get("fill", 0.0),
        item_count=len(items),
        items=items,
        shrunk=list(manifest.get("shrunk") or []),
    )


@router.get("/{kit_id}/atlas.png")
def atlas_png(
    kit_id: int,
    grid: bool = Query(default=False, description="叠加格子线，方便检查对齐"),
    db: Session = Depends(get_db),
) -> Response:
    kit = _kit_or_404(db, kit_id)
    try:
        png, manifest = kit_service.build_atlas(
            db, kit, storage_root=active_project().storage_path
        )
    except KitError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if grid and manifest.get("cell"):
        png = kit_service.draw_grid(png, manifest["cell"])
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "no-store"})


@router.get("/{kit_id}/export")
def export_kit(kit_id: int, db: Session = Depends(get_db)) -> StreamingResponse:
    kit = _kit_or_404(db, kit_id)
    try:
        data, filename = kit_service.build_export(
            db, kit, storage_root=active_project().storage_path
        )
    except KitError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return StreamingResponse(
        BytesIO(data),
        media_type="application/zip",
        headers={
            # 文件名可能是中文：头部只能放 latin-1，所以 ASCII 兜底 + RFC 5987 的 UTF-8 版本
            "Content-Disposition": (
                'attachment; filename="kit-atlas.zip"; '
                f"filename*=UTF-8''{quote(filename)}"
            )
        },
    )


@items_router.patch("/{item_id}", response_model=KitItemRead)
def update_item(
    item_id: int, payload: KitItemUpdate, db: Session = Depends(get_db)
) -> KitItemRead:
    try:
        item = kit_service.update_item(
            db, item_id, fields=set(payload.model_fields_set), **payload.model_dump()
        )
    except KitError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return _item_read(item)


@router.delete("/{kit_id}/elements/{element_id}", status_code=204)
def remove_kit_element(kit_id: int, element_id: int, db: Session = Depends(get_db)) -> Response:
    """把一件从图集里移出去（元素提取页的「移出图集」用）。"""
    kit = kit_service.get_kit(db, kit_id)
    kit_service.remove_element(db, kit, element_id)
    return Response(status_code=204)


@items_router.delete("/{item_id}", status_code=204)
def delete_item(item_id: int, db: Session = Depends(get_db)) -> Response:
    try:
        kit_service.delete_item(db, item_id)
    except KitError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return Response(status_code=204)
