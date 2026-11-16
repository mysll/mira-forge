"""数据库引擎与会话。

多项目之后，数据库不再是一个全局文件，而是「每个项目一个 app.db」。所以这里
按数据库路径缓存引擎与会话工厂：

- `engine_for(db_path)` / `session_for(project)`：给 worker 这类需要明确操作某个
  项目的调用方用；
- `SessionLocal()`：沿用旧的调用方式，等价于「当前激活项目」的会话；
- `get_db()`：FastAPI 依赖，请求进来时绑定当时的激活项目。
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.projects import Project, active_project


class Base(DeclarativeBase):
    pass


_LOCK = threading.RLock()
_ENGINES: dict[str, Engine] = {}
_FACTORIES: dict[str, sessionmaker[Session]] = {}


def _apply_sqlite_pragmas(dbapi_connection: Any, _connection_record: Any) -> None:
    """WAL 提升并发读、外键约束开启、锁等待 5 秒。"""
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=5000")
    finally:
        cursor.close()


def engine_for(db_path: Path) -> Engine:
    """按数据库文件路径取（并缓存）引擎。"""
    key = db_path.resolve().as_posix()
    with _LOCK:
        engine = _ENGINES.get(key)
        if engine is None:
            db_path.parent.mkdir(parents=True, exist_ok=True)
            engine = create_engine(
                f"sqlite:///{key}",
                connect_args={"check_same_thread": False},
                pool_pre_ping=True,
            )
            event.listen(engine, "connect", _apply_sqlite_pragmas)
            _ENGINES[key] = engine
        return engine


def session_factory_for(db_path: Path) -> sessionmaker[Session]:
    key = db_path.resolve().as_posix()
    with _LOCK:
        factory = _FACTORIES.get(key)
        if factory is None:
            factory = sessionmaker(
                bind=engine_for(db_path),
                autoflush=False,
                expire_on_commit=False,
                future=True,
            )
            _FACTORIES[key] = factory
        return factory


def session_for(project: Project) -> Session:
    """打开某个项目的会话。调用方负责 close（建议用 with）。"""
    project.ensure_directories()
    return session_factory_for(project.db_path)()


def dispose_engine_for(db_path: Path) -> None:
    """删项目前调用：不释放连接，Windows 上删不掉被占用的 db 文件。"""
    key = db_path.resolve().as_posix()
    with _LOCK:
        engine = _ENGINES.pop(key, None)
        _FACTORIES.pop(key, None)
    if engine is not None:
        engine.dispose()


def dispose_all() -> None:
    with _LOCK:
        engines = list(_ENGINES.values())
        _ENGINES.clear()
        _FACTORIES.clear()
    for engine in engines:
        engine.dispose()


class _ActiveSessionFactory:
    """兼容旧的 `SessionLocal()` 写法：每次调用都绑定当前的激活项目。"""

    def __call__(self) -> Session:
        return session_for(active_project())


SessionLocal = _ActiveSessionFactory()


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def __getattr__(name: str) -> Any:
    """`from app.models.database import engine` 这类旧引用仍可用（取当前项目的引擎）。"""
    if name == "engine":
        return engine_for(active_project().db_path)
    raise AttributeError(name)
