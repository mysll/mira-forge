"""项目管理：新建 / 切换 / 重命名 / 删除，以及项目之间的隔离。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

API = "/api/v1"


def _default_id(client: TestClient) -> str:
    return client.get(f"{API}/projects").json()["items"][0]["id"]


def _activate(client: TestClient, project_id: str) -> None:
    response = client.post(f"{API}/projects/{project_id}/activate")
    assert response.status_code == 200, response.text


@pytest.fixture(autouse=True)
def restore_default_project(client: TestClient):
    """每个用例结束后把激活项目切回默认，避免污染其它用例。"""
    default = _default_id(client)
    yield
    client.post(f"{API}/projects/{default}/activate")


def test_list_has_default_project(client: TestClient) -> None:
    body = client.get(f"{API}/projects").json()
    assert body["active"] == body["items"][0]["id"]
    first = body["items"][0]
    assert first["name"] == "默认项目"
    assert first["is_active"] is True
    assert first["database_path"].replace("\\", "/").endswith("/default/app.db")
    assert first["storage_path"].replace("\\", "/").endswith("/default/storage")


def test_create_activates_and_starts_empty(client: TestClient) -> None:
    created = client.post(f"{API}/projects", json={"name": "项目甲"})
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["name"] == "项目甲"
    assert body["is_active"] is True
    # 新项目是空的：作品流和模型目录都在，但没有任何生成
    assert client.get(f"{API}/generations").json()["total"] == 0
    assert client.get(f"{API}/images").json()["total"] == 0
    assert client.get(f"{API}/models").json()["items"]
    # 工作流注册表已经同步进新库（条数跟 /models 里声明的保持一致，不写死数字）
    workflows = client.get(f"{API}/workflows").json()["items"]
    models = client.get(f"{API}/models").json()["items"]
    assert len(workflows) == sum(len(item["workflows"]) for item in models)
    assert workflows


def test_projects_are_isolated(client: TestClient) -> None:
    default = _default_id(client)
    _activate(client, default)
    first = client.post(
        f"{API}/generations",
        json={"prompt": "在默认项目里生成", "model": "qwen_image_21", "count": 1},
    )
    assert first.status_code == 201, first.text

    second_project = client.post(f"{API}/projects", json={"name": "项目乙"}).json()
    assert client.get(f"{API}/generations").json()["total"] == 0
    created = client.post(
        f"{API}/generations",
        json={"prompt": "在项目乙里生成", "model": "qwen_image_21", "count": 2},
    )
    assert created.status_code == 201, created.text
    assert client.get(f"{API}/generations").json()["total"] == 1

    _activate(client, default)
    items = client.get(f"{API}/generations").json()["items"]
    assert items[0]["prompt"] == "在默认项目里生成"

    _activate(client, second_project["id"])
    items = client.get(f"{API}/generations").json()["items"]
    assert items[0]["prompt"] == "在项目乙里生成"
    assert len(items[0]["tasks"]) == 2


def test_rename_and_duplicate_name(client: TestClient) -> None:
    created = client.post(f"{API}/projects", json={"name": "待改名"}).json()
    renamed = client.patch(f"{API}/projects/{created['id']}", json={"name": "改好了"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "改好了"

    duplicated = client.post(f"{API}/projects", json={"name": "改好了"})
    assert duplicated.status_code == 422
    assert "已经有叫" in duplicated.json()["detail"]

    blank = client.post(f"{API}/projects", json={"name": "   "})
    assert blank.status_code == 422


def test_delete_removes_folder_and_keeps_last(client: TestClient) -> None:
    created = client.post(f"{API}/projects", json={"name": "临时项目"}).json()
    path = created["path"]
    from pathlib import Path

    assert Path(path).is_dir()

    deleted = client.delete(f"{API}/projects/{created['id']}")
    assert deleted.status_code == 200, deleted.text
    assert created["id"] not in [item["id"] for item in deleted.json()["items"]]
    assert not Path(path).exists()
    assert deleted.json()["active"] == _default_id(client)


def test_active_project_cannot_be_the_only_one(client: TestClient) -> None:
    # 逐个删到只剩一个项目（只要还剩多个，删任何项目都是允许的）
    for _ in range(20):
        items = client.get(f"{API}/projects").json()["items"]
        if len(items) <= 1:
            break
        response = client.delete(f"{API}/projects/{items[0]['id']}")
        assert response.status_code == 200, response.text

    items = client.get(f"{API}/projects").json()["items"]
    assert len(items) == 1
    refused = client.delete(f"{API}/projects/{items[0]['id']}")
    assert refused.status_code == 422
    assert "至少" in refused.json()["detail"]


def test_health_reports_active_project(client: TestClient) -> None:
    created = client.post(f"{API}/projects", json={"name": "健康检查项目"}).json()
    body = client.get(f"{API}/health").json()
    assert body["project_id"] == created["id"]
    assert body["project_name"] == "健康检查项目"
    assert body["project_path"] == created["path"]
