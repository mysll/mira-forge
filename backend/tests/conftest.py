"""测试环境：使用独立的临时项目目录，绝不碰 data/projects 与真实图片。"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
TMP_DIR = BACKEND_DIR / ".pytest-tmp"

# 必须在 import app.* 之前完成环境覆盖
shutil.rmtree(TMP_DIR, ignore_errors=True)
TMP_DIR.mkdir(parents=True, exist_ok=True)
# 多项目：测试用独立的 projects 目录，启动时会自己建出「默认项目」
os.environ["PROJECTS_DIR"] = (TMP_DIR / "projects").as_posix()
# 老布局路径指向不存在的文件，避免启动时把真实数据搬进测试目录
os.environ["DATABASE_URL"] = f"sqlite:///{(TMP_DIR / 'legacy' / 'app.db').as_posix()}"
os.environ["STORAGE_DIR"] = (TMP_DIR / "legacy" / "storage").as_posix()
os.environ["AUTO_MIGRATE"] = "true"
os.environ["FRONTEND_ORIGIN"] = "http://127.0.0.1:3000"
# 关键：测试绝不启动后台 worker，否则会把测试任务真的提交给 ComfyUI
os.environ["WORKER_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

API = "/api/v1"


@pytest.fixture(scope="session")
def client() -> TestClient:
    with TestClient(app) as test_client:
        yield test_client
