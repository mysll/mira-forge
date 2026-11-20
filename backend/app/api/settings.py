"""设置页里的可改配置（分层分析用的 LLM + 分层提示词）。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.schemas.settings import (
    LayerPromptRead,
    LayerPromptUpdate,
    LLMSettingsRead,
    LLMSettingsUpdate,
    LLMTestResult,
)
from app.services import layer_prompt_service, llm_client, llm_settings_service

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("/llm", response_model=LLMSettingsRead)
def read_llm_settings() -> LLMSettingsRead:
    return LLMSettingsRead(**llm_settings_service.load().public())


@router.put("/llm", response_model=LLMSettingsRead)
def update_llm_settings(payload: LLMSettingsUpdate) -> LLMSettingsRead:
    config = llm_settings_service.save(
        enabled=payload.enabled,
        base_url=payload.base_url,
        model=payload.model,
        api_key=payload.api_key,
        clear_api_key=payload.clear_api_key,
        timeout_seconds=payload.timeout_seconds,
    )
    return LLMSettingsRead(**config.public())


@router.post("/llm/test", response_model=LLMTestResult)
def test_llm_settings() -> LLMTestResult:
    """拿已保存的配置发一句最小请求，确认 key / 地址 / 模型都通。"""
    if not llm_client.is_configured():
        return LLMTestResult(ok=False, detail="还没填完：Base URL、模型都要有")
    try:
        text, meta = llm_client.chat_json(
            system="你是连通性测试。",
            user="只回复两个字：可用",
            temperature=0.0,
        )
    except llm_client.LLMError as error:
        return LLMTestResult(ok=False, detail=str(error))
    except llm_client.LLMNotConfigured as error:
        return LLMTestResult(ok=False, detail=str(error))
    model = meta.get("model") or ""
    snippet = text.strip().replace("\n", " ")[:60]
    return LLMTestResult(ok=True, detail=f"{model} 已响应：{snippet}")


@router.get("/layer-prompt", response_model=LayerPromptRead)
def read_layer_prompt() -> LayerPromptRead:
    """分层分析用的系统提示词（不是视频模板，只有这一份）。"""
    return LayerPromptRead(
        prompt=layer_prompt_service.load(),
        is_default=layer_prompt_service.is_default(),
        max_length=layer_prompt_service.MAX_LENGTH,
    )


@router.put("/layer-prompt", response_model=LayerPromptRead)
def update_layer_prompt(payload: LayerPromptUpdate) -> LayerPromptRead:
    try:
        prompt = layer_prompt_service.save(payload.prompt)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return LayerPromptRead(
        prompt=prompt,
        is_default=layer_prompt_service.is_default(),
        max_length=layer_prompt_service.MAX_LENGTH,
    )


@router.post("/layer-prompt/reset", response_model=LayerPromptRead)
def reset_layer_prompt() -> LayerPromptRead:
    prompt = layer_prompt_service.reset()
    return LayerPromptRead(
        prompt=prompt, is_default=True, max_length=layer_prompt_service.MAX_LENGTH
    )
