"""最小 LLM 客户端：OpenAI 兼容的 /chat/completions（可带图片）。

项目里只此一处发外部请求；base_url / model / api_key 走设置页（data/llm_config.json），
换供应商不改代码。分层分析要「看图 + 出 JSON」，所以这里刻意只做一件事：
把 messages 发出去，拿回文本，剩下的解析与校验交给调用方。

请求头按 OpenCode Go 的要求带两样东西（见 docs/console/go#where-can-i-use-it）：
- `User-Agent: MiraForge/<版本>`：客户端要自报身份，不能是 httpx 这种通用名；
- `x-opencode-session`：同一段对话用一个稳定的 id，供它做路由与提示词缓存。
"""

from __future__ import annotations

import base64
import io
import json
import uuid
from pathlib import Path
from typing import Any

import httpx
from PIL import Image

from app.core.config import get_settings
from app.services import llm_settings_service

# 源图缩到这个长边再发：1024 足够看清宫殿结构，又不会把 token 打爆
_JPEG_QUALITY = 88

# 进程级兜底会话：没显式传 session 的调用（比如设置页的连接测试）共用这一个
_PROCESS_SESSION = uuid.uuid4().hex


class LLMNotConfigured(RuntimeError):
    """没配 LLM：提示用户去设置页填。"""


class LLMError(RuntimeError):
    """调用失败：网络、鉴权、返回格式不对，都在这里统一抛出。"""


def is_configured() -> bool:
    return llm_settings_service.is_configured()


def _endpoint(base_url: str) -> str:
    base = base_url.rstrip("/")
    # 允许直接填到 /chat/completions，也允许只填到 /v1
    if base.endswith("/chat/completions"):
        return base
    return f"{base}/chat/completions"


def image_data_uri(path: Path) -> str:
    """把图片转成 data URI：长边压到 llm_image_max_side，JPEG 编码。"""
    settings = get_settings()
    max_side = max(256, settings.llm_image_max_side)
    with Image.open(path) as source:
        image = source.convert("RGB")
        image.thumbnail((max_side, max_side), Image.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=_JPEG_QUALITY, optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def chat_json(
    *,
    system: str,
    user: str,
    image: str | None = None,
    temperature: float = 0.35,
    session: str | None = None,
) -> tuple[str, dict[str, Any]]:
    """发一轮对话，返回 (文本, usage 元信息)。

    `session` 是这段对话的稳定 id：同一次分层分析的多轮请求传同一个值，
    这样支持会话头的供应商（OpenCode Go）才能把请求路由到同一处、命中缓存。
    `response_format=json_object` 只在支持的供应商上生效，所以传了但允许失败：
    真正的 JSON 提取由调用方做（模型常带 ```json 围栏）。
    """
    if not is_configured():
        raise LLMNotConfigured(
            "还没有配置 LLM：在「设置 → LLM 分层分析」里填 Base URL、模型与 API Key 后保存"
        )

    config = llm_settings_service.load()
    content: list[dict[str, Any]] = [{"type": "text", "text": user}]
    if image:
        content.append({"type": "image_url", "image_url": {"url": image}})

    body = {
        "model": config.model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": content},
        ],
        "temperature": temperature,
    }
    headers = {
        "Content-Type": "application/json",
        # 自报身份：供应商按 UA 识别客户端，httpx 的默认 UA 会被当成裸 SDK
        "User-Agent": f"MiraForge/{get_settings().app_version}",
        "x-opencode-session": session or _PROCESS_SESSION,
    }
    if config.api_key:
        headers["Authorization"] = f"Bearer {config.api_key}"

    try:
        response = httpx.post(
            _endpoint(config.base_url), json=body, headers=headers, timeout=config.timeout_seconds
        )
    except httpx.HTTPError as error:
        raise LLMError(f"连不上 LLM：{error}") from error

    if response.status_code >= 400:
        detail = response.text[:600].replace("\n", " ")
        raise LLMError(f"LLM 返回 {response.status_code}：{detail}")

    try:
        payload = response.json()
        text = payload["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as error:
        raise LLMError(f"LLM 返回不是预期结构：{response.text[:400]}") from error

    if isinstance(text, list):  # 少数供应商把 content 拆成 [{type,text}]
        text = "".join(part.get("text", "") for part in text if isinstance(part, dict))

    usage = payload.get("usage") or {}
    return str(text), {
        "model": config.model,
        "base_url": config.base_url,
        "usage": usage,
    }


def extract_json(text: str) -> dict[str, Any]:
    """从模型输出里抠出第一个 JSON 对象（容忍 ```json 围栏与前后废话）。"""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        # ```json\n{...}\n```
        cleaned = cleaned.split("\n", 1)[-1]
        if cleaned.rstrip().endswith("```"):
            cleaned = cleaned.rstrip()[: -3]
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end <= start:
        raise LLMError("模型输出里没有 JSON 对象")
    try:
        return json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError as error:
        raise LLMError(f"模型输出的 JSON 解析不了：{error}") from error
