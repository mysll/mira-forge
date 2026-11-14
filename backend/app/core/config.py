"""应用配置：所有可调项集中在此，键名与 doc/PROJECT.md 的 .env 约定一致。"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# config.py -> core -> app -> backend
BACKEND_DIR = Path(__file__).resolve().parents[2]
PROJECT_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    """从 .env / 环境变量读取配置。字段名大小写不敏感地映射到同名大写环境变量。"""

    model_config = SettingsConfigDict(
        env_file=str(BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    app_name: str = "MiraForge"
    app_version: str = "0.1.0"
    debug: bool = False

    # 服务监听
    app_host: str = "127.0.0.1"
    app_port: int = 8000
    frontend_origin: str = "http://127.0.0.1:3000"

    # ComfyUI（只允许后端访问，前端绝不直连）
    comfyui_url: str = "http://127.0.0.1:8188"
    comfyui_timeout_seconds: float = 2.0

    # 存储
    database_url: str = "sqlite:///./data/app.db"
    storage_dir: str = "./storage"

    # 任务
    max_generation_count: int = 8
    worker_concurrency: int = 1

    # 启动时自动执行 alembic upgrade head（测试可关闭）
    auto_migrate: bool = True

    @property
    def storage_path(self) -> Path:
        return self.resolve_path(self.storage_dir)

    @property
    def database_path(self) -> Path | None:
        """sqlite 文件路径；非 sqlite 时返回 None。"""
        prefix = "sqlite:///"
        if not self.database_url.startswith(prefix):
            return None
        raw = self.database_url[len(prefix) :]
        if raw == ":memory:":
            return None
        return self.resolve_path(raw)

    @property
    def database_url_absolute(self) -> str:
        """把相对 sqlite 路径解析成绝对路径，避免受启动目录影响。"""
        if not self.database_url.startswith("sqlite:///"):
            return self.database_url
        path = self.database_path
        if path is None:
            return self.database_url
        return f"sqlite:///{path.as_posix()}"

    @staticmethod
    def resolve_path(value: str | Path) -> Path:
        path = Path(value)
        if path.is_absolute():
            return path
        return (PROJECT_DIR / path).resolve()

    def ensure_directories(self) -> None:
        self.storage_path.mkdir(parents=True, exist_ok=True)
        for name in ("images", "thumbnails", "uploads"):
            (self.storage_path / name).mkdir(parents=True, exist_ok=True)
        database_path = self.database_path
        if database_path is not None:
            database_path.parent.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
