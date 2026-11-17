"""多项目工作区。

一个项目 = 一个文件夹，里面是自己的数据库和产物目录：

    data/projects/<项目 id>/
        app.db
        storage/{images,videos,assets,thumbnails,uploads}

这样项目之间天然隔离：切项目就是切数据库 + 切 storage，删项目就是删一个文件夹，
备份 / 搬走一个项目也只需要复制那个目录。项目清单保存在
`data/projects/catalog.json`（人类可读，可以手改，程序只负责保持一致性）。
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from app.core.config import get_settings

CATALOG_FILE = "catalog.json"
CATALOG_VERSION = 1
DEFAULT_PROJECT_ID = "default"
DEFAULT_PROJECT_NAME = "默认项目"
_NAME_LIMIT = 40

_LOCK = threading.RLock()
_state: dict | None = None


class ProjectError(RuntimeError):
    """项目操作被拒绝（名字为空、重名、删最后一个等）。"""


@dataclass(frozen=True)
class Project:
    id: str
    name: str
    created_at: str

    @property
    def path(self) -> Path:
        return get_settings().projects_path / self.id

    @property
    def db_path(self) -> Path:
        return self.path / "app.db"

    @property
    def storage_path(self) -> Path:
        return self.path / "storage"

    @property
    def database_url(self) -> str:
        return f"sqlite:///{self.db_path.as_posix()}"

    def ensure_directories(self) -> None:
        self.path.mkdir(parents=True, exist_ok=True)
        for name in ("images", "videos", "assets", "thumbnails", "uploads"):
            (self.storage_path / name).mkdir(parents=True, exist_ok=True)

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "created_at": self.created_at}


# ---------------------------------------------------------------- catalog 读写


def _catalog_path() -> Path:
    return get_settings().projects_path / CATALOG_FILE


def _now() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def _validate_name(raw: str, *, exclude_id: str | None = None) -> str:
    name = (raw or "").strip()
    if not name:
        raise ProjectError("项目名不能为空")
    if len(name) > _NAME_LIMIT:
        raise ProjectError(f"项目名最多 {_NAME_LIMIT} 个字符")
    for project in _read_state()["projects"]:
        if project["id"] != exclude_id and project["name"].casefold() == name.casefold():
            raise ProjectError(f"已经有叫「{name}」的项目了")
    return name


def _new_id() -> str:
    """文件夹名保持 ASCII：时间戳 + 4 位随机，排序好看又不会重。"""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"p-{stamp}-{uuid.uuid4().hex[:4]}"


def _read_state() -> dict:
    global _state
    with _LOCK:
        if _state is not None:
            return _state
        path = _catalog_path()
        if not path.is_file():
            raise ProjectError(f"项目清单不存在：{path}")
        data = json.loads(path.read_text(encoding="utf-8"))
        projects = [p for p in data.get("projects") or [] if p.get("id")]
        if not projects:
            raise ProjectError("项目清单里没有任何项目")
        active = data.get("active")
        if active not in {p["id"] for p in projects}:
            active = projects[0]["id"]
        _state = {"version": CATALOG_VERSION, "active": active, "projects": projects}
        return _state


def _write_state(state: dict) -> None:
    global _state
    with _LOCK:
        path = _catalog_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
        _state = state


def _invalidate() -> None:
    global _state
    with _LOCK:
        _state = None


# ---------------------------------------------------------------- 初始化 / 迁移


def ensure_catalog() -> Project:
    """保证清单存在且指向有效项目；第一次启动时把老的单项目数据搬进来。"""
    settings = get_settings()
    settings.projects_path.mkdir(parents=True, exist_ok=True)
    with _LOCK:
        if not _catalog_path().is_file():
            _bootstrap_catalog(settings)
        project = active_project()
        project.ensure_directories()
        return project


def _bootstrap_catalog(settings) -> None:
    """没有 catalog.json：建默认项目，顺手迁移老布局。"""
    project = Project(id=DEFAULT_PROJECT_ID, name=DEFAULT_PROJECT_NAME, created_at=_now())
    state = {"version": CATALOG_VERSION, "active": project.id, "projects": [project.to_dict()]}
    _write_state(state)

    legacy_db = settings.database_path
    if legacy_db is not None and legacy_db.is_file():
        _move_legacy_database(legacy_db, project)
    legacy_storage = settings.storage_path
    if legacy_storage.is_dir() and not project.storage_path.exists():
        try:
            project.path.mkdir(parents=True, exist_ok=True)
            shutil.move(str(legacy_storage), str(project.storage_path))
        except OSError:
            # 搬不动就保留原目录，只是这个项目会从空 storage 开始
            pass

    project.ensure_directories()


def _move_legacy_database(legacy_db: Path, project: Project) -> None:
    """把 data/app.db（含 -wal / -shm）搬进项目文件夹。"""
    target = project.db_path
    if target == legacy_db:
        return
    try:
        project.path.mkdir(parents=True, exist_ok=True)
        shutil.move(str(legacy_db), str(target))
        for suffix in ("-wal", "-shm"):
            sidecar = legacy_db.with_name(legacy_db.name + suffix)
            if sidecar.is_file():
                shutil.move(str(sidecar), str(target.with_name(target.name + suffix)))
    except OSError:
        # 迁移失败也不能让应用起不来：退化成新库，旧文件原地保留
        pass


# ---------------------------------------------------------------- 对外接口


def list_projects() -> list[Project]:
    with _LOCK:
        return [Project(**item) for item in _read_state()["projects"]]


def active_project() -> Project:
    with _LOCK:
        state = _read_state()
        for item in state["projects"]:
            if item["id"] == state["active"]:
                return Project(**item)
        return Project(**state["projects"][0])


def get_project(project_id: str) -> Project | None:
    for project in list_projects():
        if project.id == project_id:
            return project
    return None


def create_project(name: str) -> Project:
    with _LOCK:
        clean = _validate_name(name)
        state = _read_state()
        project = Project(id=_new_id(), name=clean, created_at=_now())
        state["projects"].append(project.to_dict())
        _write_state(state)
    project.ensure_directories()
    return project


def rename_project(project_id: str, name: str) -> Project:
    with _LOCK:
        state = _read_state()
        for item in state["projects"]:
            if item["id"] == project_id:
                item["name"] = _validate_name(name, exclude_id=project_id)
                _write_state(state)
                return Project(**item)
    raise ProjectError(f"项目 {project_id} 不存在")


def activate_project(project_id: str) -> Project:
    with _LOCK:
        state = _read_state()
        for item in state["projects"]:
            if item["id"] == project_id:
                state["active"] = project_id
                _write_state(state)
                project = Project(**item)
                break
        else:
            raise ProjectError(f"项目 {project_id} 不存在")
    project.ensure_directories()
    return project


def delete_project(project_id: str) -> list[Project]:
    """删项目 = 删文件夹。返回删除之后剩下的项目（新的激活项目已在其中）。"""
    with _LOCK:
        state = _read_state()
        target = next((item for item in state["projects"] if item["id"] == project_id), None)
        if target is None:
            raise ProjectError(f"项目 {project_id} 不存在")
        if len(state["projects"]) <= 1:
            raise ProjectError("至少要保留一个项目")

        project = Project(**target)
        remaining = [item for item in state["projects"] if item["id"] != project_id]
        if state["active"] == project_id:
            state["active"] = remaining[0]["id"]
        state["projects"] = remaining
        _write_state(state)

    # 先把 SQLite 连接放掉，否则 Windows 上删不掉被占用的 app.db
    from app.models.database import dispose_engine_for

    dispose_engine_for(project.db_path)
    if project.path.is_dir():
        shutil.rmtree(project.path, ignore_errors=True)
    return list_projects()


def catalog_snapshot() -> dict:
    with _LOCK:
        state = _read_state()
        return {
            "version": state["version"],
            "active": state["active"],
            "projects": [Project(**item) for item in state["projects"]],
        }


def reset_catalog_cache() -> None:
    """测试用：丢掉内存缓存，下次重新读盘。"""
    _invalidate()
