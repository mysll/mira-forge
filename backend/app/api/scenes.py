"""场景接口：列表 / 新建 / 详情 / 改名 / 删除。

场景里的图仍然走 /generations 与 /images，只是带上 `scene=<id>`；
不带 scene 的列表默认**排除**场景内的记录，所以场景产物不进主图片流。
"""

from __future__ import annotations

from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.models.database import get_db
from app.schemas.scene import (
    SceneCreate,
    SceneDeleted,
    SceneListResponse,
    SceneRead,
    SceneUpdate,
)
from app.services.scene_service import (
    SceneValidationError,
    create_scene,
    delete_scene,
    get_scene,
    scene_covers,
    list_scenes,
    scene_stats,
    update_scene,
)

router = APIRouter(prefix="/scenes", tags=["scenes"])


def _to_read(
    scene,
    image_count: int = 0,
    generation_count: int = 0,
    cover: tuple[int, datetime | None] | None = None,
) -> SceneRead:
    payload = SceneRead.model_validate(scene)
    payload.image_count = image_count
    payload.generation_count = generation_count
    # 封面由 scene_covers() 算好传进来：显式封面可用就用它，否则退回本场景最新一张，
    # 一张都没有就是 None（前端显示占位图）
    payload.cover_image_id = cover[0] if cover else None
    payload.cover_image_created_at = cover[1] if cover else None
    return payload


@router.get("", response_model=SceneListResponse)
def list_all(db: Session = Depends(get_db)) -> SceneListResponse:
    rows = list_scenes(db)
    covers = scene_covers(db, [scene for scene, _, _ in rows])
    return SceneListResponse(
        items=[
            _to_read(scene, images, generations, covers.get(scene.id))
            for scene, images, generations in rows
        ],
        total=len(rows),
    )


@router.post("", response_model=SceneRead, status_code=status.HTTP_201_CREATED)
def create(payload: SceneCreate, db: Session = Depends(get_db)) -> SceneRead:
    """新建场景：落库 + 建 `storage/scenes/<id>/images/` 目录。"""
    try:
        scene = create_scene(db, name=payload.name, description=payload.description)
    except SceneValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _to_read(scene)


@router.get("/{scene_id}", response_model=SceneRead)
def get_detail(scene_id: int, db: Session = Depends(get_db)) -> SceneRead:
    scene = get_scene(db, scene_id)
    if scene is None:
        raise HTTPException(status_code=404, detail=f"场景 {scene_id} 不存在")
    images, generations = scene_stats(db, scene_id)
    cover = scene_covers(db, [scene]).get(scene_id)
    return _to_read(scene, images, generations, cover)


@router.patch("/{scene_id}", response_model=SceneRead)
def patch(
    scene_id: int, payload: SceneUpdate, db: Session = Depends(get_db)
) -> SceneRead:
    """改名字 / 场景说明 / 封面；只改传了的字段。"""
    scene = get_scene(db, scene_id)
    if scene is None:
        raise HTTPException(status_code=404, detail=f"场景 {scene_id} 不存在")
    try:
        scene = update_scene(
            db,
            scene,
            name=payload.name,
            description=payload.description,
            cover_image_id=payload.cover_image_id,
            fields=set(payload.model_dump(exclude_unset=True).keys()),
        )
    except SceneValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    images, generations = scene_stats(db, scene_id)
    cover = scene_covers(db, [scene]).get(scene_id)
    return _to_read(scene, images, generations, cover)


@router.delete("/{scene_id}", response_model=SceneDeleted)
def delete(scene_id: int, db: Session = Depends(get_db)) -> SceneDeleted:
    """删场景：场景软删，里面的批次与产物一起进回收站。"""
    scene = get_scene(db, scene_id)
    if scene is None:
        raise HTTPException(status_code=404, detail=f"场景 {scene_id} 不存在")
    generations, images = delete_scene(db, scene)
    return SceneDeleted(scene_id=scene_id, generations=generations, images=images)
