"""测试环境：使用独立的临时数据库，绝不碰 data/app.db。"""

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
os.environ["DATABASE_URL"] = f"sqlite:///{(TMP_DIR / 'test.db').as_posix()}"
os.environ["STORAGE_DIR"] = (TMP_DIR / "storage").as_posix()
os.environ["AUTO_MIGRATE"] = "true"
os.environ["FRONTEND_ORIGIN"] = "http://127.0.0.1:3000"

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

API = "/api/v1"


@pytest.fixture(scope="session")
def client() -> TestClient:
    with TestClient(app) as test_client:
        yield test_client
