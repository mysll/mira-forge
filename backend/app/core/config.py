"""应用配置：所有可调项集中在此，键名与 docs/PROJECT.md 的 .env 约定一致。"""

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
    # 允许来源：浏览器里 127.0.0.1 与 localhost 是两个不同的 Origin，两个都要放行
    frontend_origin: str = "http://127.0.0.1:3000,http://localhost:3000"

    # ComfyUI（只允许后端访问，前端绝不直连）
    comfyui_url: str = "http://127.0.0.1:8188"
    comfyui_timeout_seconds: float = 2.0

    # 存储：多项目之后，每个项目一个文件夹（数据库 + 产物都在里面），
    # 下面两项只在「把老的单项目数据搬进 projects/」时作为来源路径使用。
    projects_dir: str = "./data/projects"
    database_url: str = "sqlite:///./data/app.db"
    storage_dir: str = "./storage"

    # 任务
    max_generation_count: int = 8
    # 图生图一次最多几张参考图（工作流里声明的 LoadImage 槽位要够）
    max_reference_images: int = 2
    worker_concurrency: int = 1
    # 后台 worker 是否随应用启动（测试置 false，避免真的去碰 ComfyUI）
    worker_enabled: bool = True

    # 启动时自动执行 alembic upgrade head（测试可关闭）
    auto_migrate: bool = True

    # 分层分析用的 LLM：任何 OpenAI 兼容的 /chat/completions 端点都能接，
    # 换供应商只改这三项。没配 base_url / model 时，分层接口直接 400 提示去填。
    llm_enabled: bool = True
    llm_base_url: str = ""
    llm_api_key: str = ""
    llm_model: str = ""
    llm_timeout_seconds: float = 300.0
    # 调 LLM 时源图缩到长边这个像素，控制 token 与上传体积
    llm_image_max_side: int = 1024

    @property
    def projects_path(self) -> Path:
        """所有项目文件夹的父目录。"""
        return self.resolve_path(self.projects_dir)

    @property
    def storage_path(self) -> Path:
        """老布局的 storage 目录（仅用于迁移与兼容）。"""
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
        self.projects_path.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
