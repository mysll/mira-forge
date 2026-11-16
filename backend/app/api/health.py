"""健康检查：数据库 / ComfyUI / 存储。任何单项失败都不返回 5xx。"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.projects import Project, active_project
from app.models.database import get_db
from app.schemas.health import (
    ComfyUIStatus,
    DatabaseStatus,
    FreeMemoryResponse,
    HealthResponse,
)
from app.services.comfyui_client import ComfyUIClient

router = APIRouter(tags=["health"])


def _check_database(db: Session, project: Project) -> DatabaseStatus:
    try:
        db.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001 - 健康检查必须吞掉一切异常
        return DatabaseStatus(status="error", detail=str(exc)[:300])
    return DatabaseStatus(status="ok", path=project.db_path.as_posix())


def _check_comfyui(settings: Settings) -> ComfyUIStatus:
    url = settings.comfyui_url.rstrip("/")
    try:
        response = httpx.get(
            f"{url}/system_stats", timeout=settings.comfyui_timeout_seconds, trust_env=False
        )
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:  # noqa: BLE001
        return ComfyUIStatus(
            status="error",
            url=url,
            reachable=False,
            error=f"{type(exc).__name__}: {exc}"[:300],
        )

    system = payload.get("system") or {}
    devices = payload.get("devices") or []
    device = devices[0].get("name") if devices else None
    vram_total = devices[0].get("vram_total") if devices else None
    vram_free = devices[0].get("vram_free") if devices else None
    return ComfyUIStatus(
        status="ok",
        url=url,
        reachable=True,
        version=system.get("comfyui_version"),
        device=device,
        vram_total=vram_total,
        vram_free=vram_free,
    )


def _check_storage(project: Project) -> tuple[str, str | None]:
    probe = Path(project.storage_path) / ".write_probe"
    try:
        probe.parent.mkdir(parents=True, exist_ok=True)
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except Exception as exc:  # noqa: BLE001
        return "error", str(exc)[:300]
    return "ok", project.storage_path.as_posix()


@router.get("/health", response_model=HealthResponse)
def health(db: Session = Depends(get_db)) -> HealthResponse:
    settings = get_settings()
    project = active_project()
    database = _check_database(db, project)
    comfyui = _check_comfyui(settings)
    storage_status, storage_detail = _check_storage(project)

    if database.status != "ok" or storage_status != "ok":
        overall = "error"
    elif not comfyui.reachable:
        overall = "degraded"
    else:
        overall = "ok"

    return HealthResponse(
        status=overall,
        app=settings.app_name,
        version=settings.app_version,
        database=database,
        comfyui=comfyui,
        storage={"status": storage_status, "detail": storage_detail},
        storage_path=project.storage_path.as_posix(),
        max_generation_count=settings.max_generation_count,
        project_id=project.id,
        project_name=project.name,
        project_path=project.path.as_posix(),
    )

async def _read_vram(client: ComfyUIClient) -> tuple[int | None, int | None]:
    """(空闲, 总量)，读不到就是 (None, None)。"""
    try:
        payload: dict[str, Any] = await client.system_stats()
    except Exception:  # noqa: BLE001 - 显存只是附加信息，读不到不算失败
        return None, None
    devices = payload.get("devices") or []
    if not devices:
        return None, None
    return devices[0].get("vram_free"), devices[0].get("vram_total")


@router.post("/comfyui/unload", response_model=FreeMemoryResponse)
async def unload_comfyui_models() -> FreeMemoryResponse:
    """让 ComfyUI 卸载模型、把显存还回来。

    ComfyUI 收到 /free 只是给队列打标记，真正卸载要等它跑一轮队列，
    所以这里会轮询最多 ~3 秒，等空闲显存涨上来再回报。
    """
    settings = get_settings()
    client = ComfyUIClient()
    url = client.base_url

    before_free, total = await _read_vram(client)
    try:
        await client.free_memory()
    except Exception as exc:  # noqa: BLE001 - 前端要能显示原因
        return FreeMemoryResponse(
            ok=False,
            url=url,
            vram_total=total,
            vram_free_before=before_free,
            detail=f"{type(exc).__name__}: {exc}"[:300],
        )

    after_free = before_free
    for _ in range(10):
        await asyncio.sleep(0.3)
        current, total_now = await _read_vram(client)
        if total_now:
            total = total_now
        if current is None:
            continue
        after_free = current
        # 涨了 64MB 以上就认为卸载生效，不必等满 3 秒
        if before_free is None or current - before_free > 64 * 1024 * 1024:
            break

    freed = None
    if before_free is not None and after_free is not None:
        freed = max(0, after_free - before_free)

    return FreeMemoryResponse(
        ok=True,
        url=url,
        vram_total=total,
        vram_free_before=before_free,
        vram_free_after=after_free,
        freed=freed,
    )
