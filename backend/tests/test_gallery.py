"""P5 验收：缩略图与删除。"""

from __future__ import annotations

import base64

from fastapi.testclient import TestClient

from app.models.database import SessionLocal
from app.services.image_service import absolute_path, store_image

API = "/api/v1"

TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _make_image(client: TestClient) -> tuple[int, int]:
    """直接用 service 落一张图（P5 之前没有"上传产物"的接口）。"""
    body = client.post(
        f"{API}/generations",
        json={"prompt": "gallery seed", "model": "qwen_image_21", "count": 1},
    ).json()
    task_id = body["tasks"][0]["id"]
    with SessionLocal() as db:
        image = store_image(
            db,
            content=TINY_PNG,
            generation_id=body["id"],
            task_id=task_id,
            index=0,
            width=1,
            height=1,
        )
        db.commit()
        return image.id, body["id"]


def test_thumbnail_is_generated_and_cached(client: TestClient) -> None:
    image_id, _ = _make_image(client)

    first = client.get(f"{API}/images/{image_id}/thumbnail")
    assert first.status_code == 200
    assert first.headers["content-type"] == "image/jpeg"
    assert first.content[:2] == b"\xff\xd8", "应该是 JPEG"

    # 第二次直接走磁盘缓存，且库里记下了 thumbnail_path
    second = client.get(f"{API}/images/{image_id}/thumbnail")
    assert second.status_code == 200
    assert second.content == first.content

    detail = client.get(f"{API}/images/{image_id}").json()
    assert detail["thumbnail_path"] and detail["thumbnail_path"].endswith(".jpg")


def test_delete_removes_row_and_file(client: TestClient) -> None:
    image_id, _ = _make_image(client)

    with SessionLocal() as db:
        from app.models.image import Image

        image = db.get(Image, image_id)
        assert image is not None
        original = absolute_path(image)
    assert original.is_file()

    response = client.delete(f"{API}/images/{image_id}")
    assert response.status_code == 204
    assert client.get(f"{API}/images/{image_id}").status_code == 404
    assert not original.is_file(), "删除必须同时清理磁盘文件"


def test_delete_unknown_image_is_404(client: TestClient) -> None:
    assert client.delete(f"{API}/images/999999").status_code == 404


def test_list_supports_pagination(client: TestClient) -> None:
    _make_image(client)
    _make_image(client)

    page = client.get(f"{API}/images", params={"limit": 1, "offset": 0}).json()
    assert page["limit"] == 1
    assert len(page["items"]) == 1
    assert page["total"] >= 2
