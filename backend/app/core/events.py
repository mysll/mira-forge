"""WebSocket 事件通道：任务状态变更广播给前端。

P1 只完成连接管理与握手；P2 起由 worker 在任务状态变化时调用 broadcast。
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import WebSocket


class ConnectionManager:
    """单进程内的 WebSocket 连接注册表。"""

    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    @property
    def connection_count(self) -> int:
        return len(self._connections)

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(websocket)

    async def broadcast(self, event: dict[str, Any]) -> None:
        """向所有在线连接推送事件；发送失败的连接直接剔除，不影响其他人。"""
        async with self._lock:
            targets = list(self._connections)
        if not targets:
            return
        stale: list[WebSocket] = []
        for websocket in targets:
            try:
                await websocket.send_json(event)
            except Exception:
                stale.append(websocket)
        if stale:
            async with self._lock:
                for websocket in stale:
                    self._connections.discard(websocket)


manager = ConnectionManager()
