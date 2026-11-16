"""ComfyUI HTTP / WebSocket 客户端。

只有 Worker 使用它。前端永远拿不到 ComfyUI 地址。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import websockets

from app.core.config import get_settings


class ComfyUIError(RuntimeError):
    """ComfyUI 明确拒绝了请求，或返回了无法理解的结果。"""


class ComfyUIClient:
    def __init__(self, base_url: str | None = None) -> None:
        settings = get_settings()
        self.base_url = (base_url or settings.comfyui_url).rstrip("/")
        self.ws_url = self.base_url.replace("http://", "ws://").replace("https://", "wss://")

    # ---- 基础请求 ----

    def _client(self, **kwargs: Any) -> httpx.AsyncClient:
        # trust_env=False：不要因为系统代理把 127.0.0.1 的请求绕出去
        return httpx.AsyncClient(
            base_url=self.base_url, timeout=httpx.Timeout(30.0), trust_env=False, **kwargs
        )

    async def system_stats(self) -> dict[str, Any]:
        async with self._client() as client:
            response = await client.get("/system_stats")
            response.raise_for_status()
            return response.json()

    async def free_memory(
        self, *, unload_models: bool = True, free_memory: bool = True
    ) -> None:
        """让 ComfyUI 卸载模型、释放显存（POST /free）。

        注意：ComfyUI 只是给队列打标记，真正的卸载发生在它下一次处理队列时，
        所以调用方要自己等一小会儿再看显存。
        """
        async with self._client() as client:
            response = await client.post(
                "/free", json={"unload_models": unload_models, "free_memory": free_memory}
            )
            response.raise_for_status()

    async def submit(self, graph: dict[str, Any], client_id: str) -> str:
        """POST /prompt，返回 prompt_id。校验失败抛 ComfyUIError（带 node_errors 摘要）。"""
        async with self._client() as client:
            response = await client.post(
                "/prompt", json={"prompt": graph, "client_id": client_id}
            )
        if response.status_code != 200:
            raise ComfyUIError(self._describe_rejection(response))
        payload = response.json()
        if payload.get("node_errors"):
            raise ComfyUIError(f"工作流校验失败：{json.dumps(payload['node_errors'], ensure_ascii=False)}")
        prompt_id = payload.get("prompt_id")
        if not prompt_id:
            raise ComfyUIError(f"ComfyUI 未返回 prompt_id：{payload}")
        return prompt_id

    @staticmethod
    def _describe_rejection(response: httpx.Response) -> str:
        try:
            payload = response.json()
        except ValueError:
            return f"ComfyUI 返回 {response.status_code}：{response.text[:500]}"
        error = payload.get("error")
        if isinstance(error, dict):
            message = error.get("message") or error.get("type") or json.dumps(error, ensure_ascii=False)
        else:
            message = str(error or payload)
        node_errors = payload.get("node_errors")
        if node_errors:
            message = f"{message}；节点错误：{json.dumps(node_errors, ensure_ascii=False)[:800]}"
        return f"ComfyUI 拒绝了工作流（{response.status_code}）：{message}"

    async def history(self, prompt_id: str) -> dict[str, Any] | None:
        """返回该 prompt 的历史记录；还没执行完则返回 None。"""
        async with self._client() as client:
            response = await client.get(f"/history/{prompt_id}")
            response.raise_for_status()
            payload = response.json()
        return payload.get(prompt_id)

    async def queue_state(self) -> dict[str, Any]:
        async with self._client() as client:
            response = await client.get("/queue")
            response.raise_for_status()
            return response.json()

    async def download(self, filename: str, subfolder: str, kind: str) -> bytes:
        async with self._client() as client:
            response = await client.get(
                "/view", params={"filename": filename, "subfolder": subfolder, "type": kind}
            )
            response.raise_for_status()
            return response.content

    async def upload_image(self, content: bytes, filename: str) -> dict[str, Any]:
        """上传参考图到 ComfyUI input 目录，返回 {"name", "subfolder", "type"}。"""
        async with self._client() as client:
            response = await client.post(
                "/upload/image",
                files={"image": (filename, content, "image/png")},
                data={"type": "input", "overwrite": "true"},
            )
            response.raise_for_status()
            return response.json()

    async def interrupt(self, prompt_id: str | None = None) -> None:
        async with self._client() as client:
            payload = {"prompt_id": prompt_id} if prompt_id else {}
            response = await client.post("/interrupt", json=payload)
            response.raise_for_status()

    # ---- 进度 ----

    async def progress_messages(self, client_id: str, prompt_id: str):
        """逐条产出属于该 prompt 的进度事件。

        连不上或中途断开都只是停止产出，不影响由 /history 判定的最终结果。
        """
        url = f"{self.ws_url}/ws?clientId={client_id}"
        try:
            async with websockets.connect(url, open_timeout=5, max_size=2**22) as socket:
                while True:
                    raw = await socket.recv()
                    if isinstance(raw, bytes):
                        continue  # 预览图等二进制帧，忽略
                    try:
                        message = json.loads(raw)
                    except ValueError:
                        continue
                    if message.get("type") != "progress":
                        continue
                    data = message.get("data") or {}
                    if data.get("prompt_id") not in (None, prompt_id):
                        continue
                    await asyncio.sleep(0)
                    yield data
        except (OSError, asyncio.TimeoutError, websockets.WebSocketException):
            return
