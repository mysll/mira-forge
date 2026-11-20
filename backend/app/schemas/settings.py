"""设置页相关的入参/出参。"""

from __future__ import annotations

from pydantic import BaseModel, Field


class LLMSettingsRead(BaseModel):
    enabled: bool
    base_url: str
    model: str
    api_key_masked: str = ""
    api_key_set: bool = False
    timeout_seconds: float


class LLMSettingsUpdate(BaseModel):
    enabled: bool | None = None
    base_url: str | None = Field(default=None, max_length=400)
    model: str | None = Field(default=None, max_length=120)
    # 传空串或 None 都表示「不改」，要清空请用 clear_api_key
    api_key: str | None = Field(default=None, max_length=400)
    clear_api_key: bool = False
    timeout_seconds: float | None = Field(default=None, ge=5, le=600)


class LLMTestResult(BaseModel):
    ok: bool
    detail: str = ""


class LayerPromptRead(BaseModel):
    """设置页里的「分层提示词」。"""

    prompt: str
    is_default: bool = False
    max_length: int = 20000


class LayerPromptUpdate(BaseModel):
    prompt: str = Field(min_length=1, max_length=20000)
