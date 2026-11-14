"""健康检查：数据库 / ComfyUI / 存储。任何单项失败都不返回 5xx。"""

from __future__ import annotations

from pathlib import Path

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.models.database import get_db
from app.schemas.health import ComfyUIStatus, DatabaseStatus, HealthResponse

router = APIRouter(tags=["health"])


def _check_database(db: Session, settings: Settings) -> DatabaseStatus:
    try:
        db.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001 - 健康检查必须吞掉一切异常
        return DatabaseStatus(status="error", detail=str(exc)[:300])
    path = settings.database_path
    return DatabaseStatus(status="ok", path=path.as_posix() if path else None)


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
    return ComfyUIStatus(
        status="ok",
        url=url,
        reachable=True,
        version=system.get("comfyui_version"),
        device=device,
    )


def _check_storage(settings: Settings) -> tuple[str, str | None]:
    probe = Path(settings.storage_path) / ".write_probe"
    try:
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except Exception as exc:  # noqa: BLE001
        return "error", str(exc)[:300]
    return "ok", settings.storage_path.as_posix()


@router.get("/health", response_model=HealthResponse)
def health(db: Session = Depends(get_db)) -> HealthResponse:
    settings = get_settings()
    database = _check_database(db, settings)
    comfyui = _check_comfyui(settings)
    storage_status, storage_detail = _check_storage(settings)

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
    )
