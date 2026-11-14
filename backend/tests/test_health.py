"""P1 验收：健康检查与模型/工作流目录。"""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_health_reports_db_and_comfyui(client: TestClient) -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    body = response.json()
    assert body["app"] == "MiraForge"
    assert body["database"]["status"] == "ok"
    assert body["database"]["path"].endswith("test.db")
    assert body["storage"]["status"] == "ok"
    # ComfyUI 可能没开：只要求字段存在且不 5xx
    assert isinstance(body["comfyui"]["reachable"], bool)
    assert body["status"] in {"ok", "degraded", "error"}


def test_health_never_returns_5xx_when_comfyui_down(client: TestClient, monkeypatch) -> None:
    from app.core import config as config_module

    settings = config_module.get_settings()
    monkeypatch.setattr(settings, "comfyui_url", "http://127.0.0.1:59999")
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    body = response.json()
    assert body["comfyui"]["reachable"] is False
    assert body["comfyui"]["error"]
    assert body["status"] == "degraded"


def test_models_catalog_is_data_driven(client: TestClient) -> None:
    response = client.get("/api/v1/models")
    assert response.status_code == 200
    items = response.json()["items"]
    ids = {item["id"] for item in items}
    assert {"qwen_image_21", "qwen_image_21_turbo"} <= ids

    turbo = next(item for item in items if item["id"] == "qwen_image_21_turbo")
    standard = next(item for item in items if item["id"] == "qwen_image_21")
    # turbo 的步数与 cfg 被固定 sigma 表锁死，前端不应显示可调控件
    assert turbo["capabilities"]["exposes_steps"] is False
    assert standard["capabilities"]["exposes_steps"] is True
    assert turbo["defaults"]["steps"] == 8

    for item in items:
        types = {workflow["type"] for workflow in item["workflows"]}
        assert types == {"text_to_image", "image_edit"}
        for workflow in item["workflows"]:
            assert isinstance(workflow["available"], bool)


def test_single_model_lookup(client: TestClient) -> None:
    assert client.get("/api/v1/models/qwen_image_21").status_code == 200
    assert client.get("/api/v1/models/does_not_exist").status_code == 404


def test_workflows_table_synced_from_registry(client: TestClient) -> None:
    response = client.get("/api/v1/workflows")
    assert response.status_code == 200
    rows = response.json()["items"]
    assert len(rows) == 4  # 2 个模型 × 2 种任务类型
    assert {row["type"] for row in rows} == {"text_to_image", "image_edit"}
    # P1 阶段工作流 JSON 尚未落地，enabled 必须如实为 False
    assert all(row["json_path"].endswith(".json") for row in rows)
