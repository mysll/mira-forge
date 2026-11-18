"""抽帧台（帧集）的出入参。"""

from __future__ import annotations

from pydantic import BaseModel


class FrameSetSaved(BaseModel):
    generation_id: int
    image_id: int
    name: str
    frame_count: int
    fps: float | None = None
    width: int
    height: int
