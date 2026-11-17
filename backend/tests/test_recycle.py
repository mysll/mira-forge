"""回收站：软删除、恢复、彻底删除、过期清理。"""

from __future__ import annotations

import base64
from datetime import timedelta

from fastapi.testclient import TestClient
import pytest

from app.core.projects import active_project
from app.models.database import SessionLocal
from app.models.generation import Generation
from app.models.image import Image
from app.models.workflow import utcnow
from app.services.image_service import absolute_path, store_image

API = "/api/v1"
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


@pytest.fixture(autouse=True)
def clean_workspace(client: TestClient) -> None:
    """每个用例从空工作区开始：先清空（进回收站），再把回收站清空。"""
    assert client.post(f"{API}/images/clear").status_code == 200
    assert client.post(f"{API}/recycle-bin/clear").status_code == 200


def _create_generation(client: TestClient, count: int = 2) -> int:
    response = client.post(
        f"{API}/generations",
        json={
            "prompt": "回收站测试",
            "model": "qwen_image_21_turbo",
            "generation_type": "text_to_image",
            "width": 512,
            "height": 512,
            "count": count,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _register_image(generation_id: int, slot: int) -> int:
    with SessionLocal() as db:
        generation = db.get(Generation, generation_id)
        assert generation is not None
        image = store_image(
            db,
            content=TINY_PNG,
            generation_id=generation_id,
            task_id=generation.tasks[slot].id,
            index=0,
            width=1,
            height=1,
        )
        db.commit()
        return image.id


def _make_image(client: TestClient) -> int:
    return _register_image(_create_generation(client, count=1), 0)


def test_restore_puts_the_image_back_in_the_gallery(client: TestClient) -> None:
    image_id = _make_image(client)
    generation_id = client.get(f"{API}/images/{image_id}").json()["generation_id"]

    assert client.delete(f"{API}/images/{image_id}").status_code == 204
    assert client.get(f"{API}/images/{image_id}").status_code == 404

    item = next(item for item in client.get(f"{API}/recycle-bin").json()["items"] if item["id"] == image_id)
    assert item["days_left"] == 30
    assert item["prompt"] == "回收站测试"
    assert item["model_name"] == "qwen_image_21_turbo"
    assert item["generation_type"] == "text_to_image"

    response = client.post(f"{API}/recycle-bin/restore", json={"ids": [image_id]})
    assert response.status_code == 200, response.text
    assert response.json() == {"restored": [image_id], "missing": []}

    restored = client.get(f"{API}/images/{image_id}")
    assert restored.status_code == 200
    assert restored.json()["generation_id"] == generation_id
    # 批次也该重新出现在作品流里
    assert generation_id in [row["id"] for row in client.get(f"{API}/generations").json()["items"]]
    assert client.get(f"{API}/recycle-bin").json()["total"] == 0


def test_restoring_one_image_revives_its_batch(client: TestClient) -> None:
    generation_id = _create_generation(client, count=2)
    first = _register_image(generation_id, 0)
    second = _register_image(generation_id, 1)

    assert client.delete(f"{API}/generations/{generation_id}").status_code == 200
    assert client.get(f"{API}/generations/{generation_id}").status_code == 404

    response = client.post(f"{API}/recycle-bin/restore", json={"ids": [first]})
    assert response.json() == {"restored": [first], "missing": []}

    # 批次回来了，但只回来被恢复的那一张
    batch = client.get(f"{API}/generations/{generation_id}")
    assert batch.status_code == 200, batch.text
    assert [image["id"] for image in batch.json()["images"]] == [first]
    # 另一张还留在回收站
    assert [item["id"] for item in client.get(f"{API}/recycle-bin").json()["items"]] == [second]


def test_delete_forever_removes_the_file(client: TestClient) -> None:
    image_id = _make_image(client)

    with SessionLocal() as db:
        image = db.get(Image, image_id)
        assert image is not None
        path = absolute_path(image)
    assert path.is_file()

    assert client.delete(f"{API}/images/{image_id}").status_code == 204
    assert path.is_file(), "进回收站不该动文件"

    response = client.delete(f"{API}/recycle-bin/{image_id}")
    assert response.status_code == 200, response.text
    assert response.json() == {"deleted": 1}
    assert not path.is_file()
    assert client.get(f"{API}/recycle-bin").json()["total"] == 0
    assert client.post(f"{API}/recycle-bin/restore", json={"ids": [image_id]}).json() == {
        "restored": [],
        "missing": [image_id],
    }


def test_delete_forever_rejects_ids_that_are_not_in_the_bin(client: TestClient) -> None:
    image_id = _make_image(client)
    response = client.delete(f"{API}/recycle-bin/{image_id}")
    assert response.status_code == 404
    assert "回收站" in response.json()["detail"]


def test_clear_bin_wipes_files_and_rows(client: TestClient) -> None:
    first = _make_image(client)
    second = _make_image(client)
    assert client.delete(f"{API}/images/{first}").status_code == 204
    assert client.delete(f"{API}/images/{second}").status_code == 204

    storage = active_project().storage_path
    files = sorted(storage.glob("images/**/*.png"))
    assert len(files) == 2

    response = client.post(f"{API}/recycle-bin/clear")
    assert response.status_code == 200, response.text
    assert response.json() == {"deleted": 2}
    assert not any(path.is_file() for path in files)
    assert client.get(f"{API}/recycle-bin").json()["total"] == 0


def test_expired_items_are_purged_on_read(client: TestClient) -> None:
    expired = _make_image(client)
    fresh = _make_image(client)
    assert client.delete(f"{API}/images/{expired}").status_code == 204
    assert client.delete(f"{API}/images/{fresh}").status_code == 204

    with SessionLocal() as db:
        image = db.get(Image, expired)
        assert image is not None
        path = absolute_path(image)
        image.deleted_at = utcnow() - timedelta(days=31)
        db.commit()

    page = client.get(f"{API}/recycle-bin").json()
    assert [item["id"] for item in page["items"]] == [fresh]
    assert not path.is_file(), "过期条目访问回收站时应当被彻底清掉"

    with SessionLocal() as db:
        assert db.get(Image, expired) is None


def test_restore_unknown_ids_are_reported_missing(client: TestClient) -> None:
    response = client.post(f"{API}/recycle-bin/restore", json={"ids": [999999]})
    assert response.status_code == 200
    assert response.json() == {"restored": [], "missing": [999999]}


def test_restore_ignores_images_that_were_never_deleted(client: TestClient) -> None:
    image_id = _make_image(client)
    response = client.post(f"{API}/recycle-bin/restore", json={"ids": [image_id]})
    assert response.json() == {"restored": [], "missing": [image_id]}
    assert client.get(f"{API}/images/{image_id}").status_code == 200
