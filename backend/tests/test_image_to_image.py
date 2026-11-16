"""图生图（参考图引导）的接口行为：1–2 张参考图、宽高生效、参考图可回显。"""

from __future__ import annotations

import base64

from fastapi.testclient import TestClient

API = "/api/v1"

TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _post(client: TestClient, count: int, **form_overrides):
    data = {
        "prompt": "the same garden in autumn, fallen leaves",
        "model": "qwen_image_21_turbo",
        "count": 1,
        "width": 1024,
        "height": 1024,
    }
    data.update(form_overrides)
    files = [("images", (f"ref{index}.png", TINY_PNG, "image/png")) for index in range(count)]
    return client.post(f"{API}/generations/image-to-image", data=data, files=files)


def test_two_references_are_recorded(client: TestClient) -> None:
    response = _post(client, 2)
    assert response.status_code == 201, response.text
    body = response.json()

    assert body["generation_type"] == "image_to_image"
    assert body["status"] == "pending"
    # 图生图的宽高是真的生效的（潜空间新开一张）
    assert (body["width"], body["height"]) == (1024, 1024)
    assert len(body["reference_images"]) == 2
    assert body["reference_image_path"] == body["reference_images"][0]
    assert all(path.startswith("uploads/") for path in body["reference_images"])
    assert len(body["tasks"]) == 1


def test_exactly_one_reference_is_allowed(client: TestClient) -> None:
    response = _post(client, 1)
    assert response.status_code == 201, response.text
    assert len(response.json()["reference_images"]) == 1


def test_three_references_are_rejected(client: TestClient) -> None:
    response = _post(client, 3)
    assert response.status_code == 422
    assert "最多 2 张" in response.json()["detail"]


def test_missing_reference_is_rejected(client: TestClient) -> None:
    data = {"prompt": "x", "model": "qwen_image_21", "count": 1}
    response = client.post(f"{API}/generations/image-to-image", data=data, files=[])
    assert response.status_code == 422


def test_reference_endpoint_returns_first_image(client: TestClient) -> None:
    body = _post(client, 2).json()
    response = client.get(f"{API}/generations/{body['id']}/reference")
    assert response.status_code == 200
    assert response.content == TINY_PNG


def test_reference_endpoint_serves_each_index(client: TestClient) -> None:
    body = _post(client, 2).json()
    second = client.get(f"{API}/generations/{body['id']}/reference?index=1")
    assert second.status_code == 200
    assert second.content == TINY_PNG

    out_of_range = client.get(f"{API}/generations/{body['id']}/reference?index=2")
    assert out_of_range.status_code == 404
    assert "第 3 张" in out_of_range.json()["detail"]
