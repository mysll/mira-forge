"""LLM 配置的读写：设置页可以改，改完立刻生效（不用重启后端）。

优先级：`data/llm_config.json`（设置页写入）> `backend/.env`（部署时写死）。
密钥只在服务端落盘，接口只回掩码（`sk-••••abcd`），前端拿不到明文。
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

from app.core.config import PROJECT_DIR, get_settings

CONFIG_PATH = PROJECT_DIR / "data" / "llm_config.json"


@dataclass
class LLMConfig:
    enabled: bool
    base_url: str
    model: str
    api_key: str
    timeout_seconds: float

    def public(self) -> dict:
        return {
            "enabled": self.enabled,
            "base_url": self.base_url,
            "model": self.model,
            "api_key_masked": mask_key(self.api_key),
            "api_key_set": bool(self.api_key),
            "timeout_seconds": self.timeout_seconds,
        }


def mask_key(key: str) -> str:
    """`sk-1234567890abcd` → `sk-••••abcd`；太短就整串打码。"""
    if not key:
        return ""
    if len(key) <= 8:
        return "•" * len(key)
    return f"{key[:3]}••••{key[-4:]}"


def _read_file() -> dict:
    try:
        with CONFIG_PATH.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_file(data: dict) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=CONFIG_PATH.parent, delete=False, suffix=".tmp"
    )
    try:
        with handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(handle.name, CONFIG_PATH)
    except OSError:
        try:
            os.unlink(handle.name)
        except OSError:
            pass
        raise


def load() -> LLMConfig:
    """文件 > 环境变量，逐字段回退。"""
    settings = get_settings()
    stored = _read_file()
    return LLMConfig(
        enabled=bool(stored.get("enabled", settings.llm_enabled)),
        base_url=str(stored.get("base_url", settings.llm_base_url) or ""),
        model=str(stored.get("model", settings.llm_model) or ""),
        api_key=str(stored.get("api_key", settings.llm_api_key) or ""),
        timeout_seconds=float(stored.get("timeout_seconds", settings.llm_timeout_seconds)),
    )


def save(
    *,
    enabled: bool | None = None,
    base_url: str | None = None,
    model: str | None = None,
    api_key: str | None = None,
    clear_api_key: bool = False,
    timeout_seconds: float | None = None,
) -> LLMConfig:
    """只覆盖传进来的字段；`api_key` 传空串等于「不改」。"""
    current = load()
    data = _read_file()
    if enabled is not None:
        data["enabled"] = enabled
    if base_url is not None:
        data["base_url"] = base_url.strip().rstrip("/")
    if model is not None:
        data["model"] = model.strip()
    if clear_api_key:
        data["api_key"] = ""
    elif api_key:
        data["api_key"] = api_key.strip()
    if timeout_seconds is not None:
        data["timeout_seconds"] = float(timeout_seconds)
    if not data:
        return current
    _write_file(data)
    return load()


def is_configured() -> bool:
    config = load()
    return bool(config.enabled and config.base_url.strip() and config.model.strip())


__all__ = [
    "CONFIG_PATH",
    "LLMConfig",
    "is_configured",
    "load",
    "mask_key",
    "save",
]
