"""共享的 Pydantic 基类与工具。"""

from __future__ import annotations

from datetime import datetime, timezone

from pydantic import BaseModel, ConfigDict, field_validator


class OrmModel(BaseModel):
    """从 SQLAlchemy 对象直接构造。"""

    model_config = ConfigDict(from_attributes=True)


class TimestampedModel(OrmModel):
    """SQLite 取出的 datetime 无时区，统一补成 UTC，避免前端显示错乱。"""

    @field_validator("created_at", "completed_at", "started_at", mode="before", check_fields=False)
    @classmethod
    def _attach_utc(cls, value: object) -> object:
        if isinstance(value, datetime) and value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value
