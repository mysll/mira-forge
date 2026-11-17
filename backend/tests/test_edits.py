"""P4 验收：图片编辑的参考图上传与副作用。"""

from __future__ import annotations

import base64

from fastapi.testclient import TestClient

API = "/api/v1"

# 1×1 的合法 PNG，用来验证"是不是真图片"这道门
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _edit(client: TestClient, **form_overrides) -> dict:
    data = {
        "prompt": "make it night, neon reflections",
        "model": "qwen_image_21_turbo",
        "count": 1,
        "width": 1024,
        "height": 1024,
    }
    data.update(form_overrides)
    files = {"images": ("ref.png", TINY_PNG, "image/png")}
    response = client.post(f"{API}/generations/edit", data=data, files=files)
    assert response.status_code == 201, response.text
    return response.json()


def test_edit_records_reference_and_size(client: TestClient) -> None:
    body = _edit(client, count=2)
    assert body["generation_type"] == "image_edit"
    assert body["status"] == "pending"
    # 编辑的输出比例来自参考图，宽高只决定像素量级，但仍记录请求的目标尺寸
    assert (body["width"], body["height"]) == (1024, 1024)
    assert body["reference_image_path"], "必须记住参考图落盘路径"
    assert body["reference_image_path"].startswith("uploads/")
    assert len(body["tasks"]) == 2
    assert len({task["seed"] for task in body["tasks"]}) == 2


def test_reference_file_is_served(client: TestClient) -> None:
    body = _edit(client)
    response = client.get(f"{API}/generations/{body['id']}/reference")
    assert response.status_code == 200
    assert response.content == TINY_PNG


def test_edit_accepts_one_or_two_images(client: TestClient) -> None:
    data = {"prompt": "x", "model": "qwen_image_21", "count": 1}
    response = client.post(
        f"{API}/generations/edit",
        data=data,
        files={"images": ("ref.png", TINY_PNG, "image/png")},
    )
    assert response.status_code == 201

    response = client.post(
        f"{API}/generations/edit",
        data=data,
        files=[
            ("images", ("ref1.png", TINY_PNG, "image/png")),
            ("images", ("ref2.png", TINY_PNG, "image/png")),
        ],
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["generation_type"] == "image_edit"
    # 两张都记住：第 1 张定结构，第 2 张是服装 / 材质参考
    assert len(body["reference_images"]) == 2
    assert body["reference_image_path"] == body["reference_images"][0]


def test_edit_requires_at_least_one_image(client: TestClient) -> None:
    data = {"prompt": "x", "model": "qwen_image_21", "count": 1}
    response = client.post(f"{API}/generations/edit", data=data, files=[])
    assert response.status_code == 422
    assert "至少" in response.json()["detail"]


def test_edit_rejects_more_than_two_images(client: TestClient) -> None:
    data = {"prompt": "x", "model": "qwen_image_21", "count": 1}
    files = [("images", (f"ref{i}.png", TINY_PNG, "image/png")) for i in range(3)]
    response = client.post(f"{API}/generations/edit", data=data, files=files)
    assert response.status_code == 422
    assert "最多 2 张" in response.json()["detail"]


def test_edit_rejects_non_image_upload(client: TestClient) -> None:
    data = {"prompt": "x", "model": "qwen_image_21", "count": 1}
    response = client.post(
        f"{API}/generations/edit",
        data=data,
        files={"images": ("ref.png", b"definitely not an image", "image/png")},
    )
    assert response.status_code == 422
    assert "PNG" in response.json()["detail"]


def test_text_to_image_ignores_reference(client: TestClient) -> None:
    response = client.post(
        f"{API}/generations",
        json={"prompt": "x", "model": "qwen_image_21", "count": 1},
    )
    assert response.status_code == 201
    assert response.json()["reference_image_path"] is None
