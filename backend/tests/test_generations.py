"""P1 验收：generation 落库链路。"""

from __future__ import annotations

from fastapi.testclient import TestClient

API = "/api/v1"


def _create(client: TestClient, **overrides) -> dict:
    payload = {
        "prompt": "a neon-lit cyberpunk street at night, rainy",
        "model": "qwen_image_21",
        "generation_type": "text_to_image",
        "width": 1024,
        "height": 1024,
        "count": 1,
    }
    payload.update(overrides)
    response = client.post(f"{API}/generations", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def test_create_generation_makes_n_pending_tasks(client: TestClient) -> None:
    body = _create(client, count=4)
    assert body["status"] == "pending"
    assert body["requested_count"] == 4
    assert body["model_name"] == "qwen_image_21"
    assert body["width"] == 1024 and body["height"] == 1024
    assert len(body["tasks"]) == 4
    assert {task["status"] for task in body["tasks"]} == {"pending"}
    seeds = [task["seed"] for task in body["tasks"]]
    assert len(set(seeds)) == 4, "每个 task 必须有独立 seed"
    assert all(0 <= seed < 2**31 for seed in seeds)
    assert body["workflow_id"] is not None


def test_edit_without_reference_is_rejected(client: TestClient) -> None:
    response = client.post(
        f"{API}/generations",
        json={
            "prompt": "make it night",
            "model": "qwen_image_21",
            "generation_type": "image_edit",
            "count": 1,
        },
    )
    assert response.status_code == 422
    assert "参考图" in response.json()["detail"]


def test_count_over_limit_is_rejected(client: TestClient) -> None:
    response = client.post(
        f"{API}/generations",
        json={"prompt": "x", "model": "qwen_image_21", "count": 9},
    )
    assert response.status_code == 422
    assert "最多" in response.json()["detail"]


def test_unknown_model_is_rejected(client: TestClient) -> None:
    response = client.post(
        f"{API}/generations", json={"prompt": "x", "model": "not_a_model", "count": 1}
    )
    assert response.status_code == 422
    assert "未知模型" in response.json()["detail"]


def test_empty_prompt_is_rejected(client: TestClient) -> None:
    response = client.post(
        f"{API}/generations", json={"prompt": "   ", "model": "qwen_image_21", "count": 1}
    )
    assert response.status_code == 422


def test_detail_persists_and_task_is_queryable(client: TestClient) -> None:
    created = _create(client, count=2)
    detail = client.get(f"{API}/generations/{created['id']}")
    assert detail.status_code == 200
    body = detail.json()
    assert body["id"] == created["id"]
    assert [task["id"] for task in body["tasks"]] == [task["id"] for task in created["tasks"]]

    task_id = body["tasks"][0]["id"]
    task = client.get(f"{API}/tasks/{task_id}")
    assert task.status_code == 200
    assert task.json()["generation_id"] == created["id"]

    assert client.get(f"{API}/generations/999999").status_code == 404
    assert client.get(f"{API}/tasks/999999").status_code == 404


def test_list_returns_newest_first(client: TestClient) -> None:
    first = _create(client, prompt="first prompt")
    second = _create(client, prompt="second prompt")
    response = client.get(f"{API}/generations", params={"limit": 5})
    assert response.status_code == 200
    body = response.json()
    assert body["total"] >= 2
    ids = [item["id"] for item in body["items"]]
    assert ids.index(second["id"]) < ids.index(first["id"])
    assert all(len(item["tasks"]) >= 1 for item in body["items"])


def test_websocket_handshake(client: TestClient) -> None:
    with client.websocket_connect(f"{API}/ws/tasks") as websocket:
        message = websocket.receive_json()
        assert message["type"] == "connected"
