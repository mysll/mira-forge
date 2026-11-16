"""程序化执行 Alembic 迁移，保证启动即得到正确 schema。

每个项目一个数据库，所以迁移要按项目分别跑：`upgrade_to_head(project)`。
"""

from __future__ import annotations

from alembic import command
from alembic.config import Config

from app.core.config import BACKEND_DIR
from app.core.projects import Project, active_project


def upgrade_to_head(project: Project | None = None) -> None:
    target = project or active_project()
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    config.set_main_option("sqlalchemy.url", target.database_url)
    command.upgrade(config, "head")
