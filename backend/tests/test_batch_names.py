"""批次名：改名、清空、以及产物名「批次名 · 第 N 个」。"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.models.database import SessionLocal
from app.services.image_service import store_image

API = "/api/v1"
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000a49444154789c6300010000050001"
    "0d0a2db40000000049454e44ae426082"
)


def _batch(client: TestClient, count: int = 2) -> dict:
    response = client.post(
        f"{API}/generations",
        json={
            "prompt": "批次名测试",
            "model": "qwen_image_21_turbo",
            "generation_type": "text_to_image",
            "width": 512,
            "height": 512,
            "count": count,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _add_image(generation: dict, slot: int = 0) -> int:
    db = SessionLocal()
    try:
        task = generation["tasks"][slot]
        image = store_image(
            db,
            content=PNG,
            generation_id=generation["id"],
            task_id=task["id"],
            index=0,
            width=1,
            height=1,
        )
        db.commit()
        return image.id
    finally:
        db.close()


def test_rename_sets_the_name_and_labels_the_products(client: TestClient) -> None:
    generation = _batch(client)
    first = _add_image(generation, 0)
    second = _add_image(generation, 1)

    default = client.get(f"{API}/images/{first}").json()
    assert default["label"] == f"批次 #{generation['id']} · 第 1 个"

    renamed = client.patch(f"{API}/generations/{generation['id']}", json={"name": "  跳跃测试  "})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "跳跃测试"

    one = client.get(f"{API}/images/{first}").json()
    two = client.get(f"{API}/images/{second}").json()
    assert one["label"] == "跳跃测试 · 第 1 个"
    assert two["label"] == "跳跃测试 · 第 2 个"

    # 作品流里的批次与产物也要带上新名字
    feed = client.get(f"{API}/generations/{generation['id']}").json()
    assert feed["name"] == "跳跃测试"
    assert feed["images"][0]["label"] == "跳跃测试 · 第 1 个"


def test_empty_name_falls_back_to_the_batch_number(client: TestClient) -> None:
    generation = _batch(client, count=1)
    image_id = _add_image(generation)
    client.patch(f"{API}/generations/{generation['id']}", json={"name": "临时"})

    cleared = client.patch(f"{API}/generations/{generation['id']}", json={"name": "   "})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["name"] is None
    assert client.get(f"{API}/images/{image_id}").json()["label"] == (
        f"批次 #{generation['id']} · 第 1 个"
    )


def test_rename_rejects_unknown_batch_and_too_long_names(client: TestClient) -> None:
    assert client.patch(f"{API}/generations/999999", json={"name": "x"}).status_code == 404

    generation = _batch(client, count=1)
    too_long = client.patch(f"{API}/generations/{generation['id']}", json={"name": "字" * 61})
    assert too_long.status_code == 422


def test_numbering_skips_images_in_the_recycle_bin(client: TestClient) -> None:
    generation = _batch(client)
    first = _add_image(generation, 0)
    second = _add_image(generation, 1)
    assert client.get(f"{API}/images/{second}").json()["label"].endswith("第 2 个")

    assert client.delete(f"{API}/images/{first}").status_code == 204
    assert client.get(f"{API}/images/{second}").json()["label"].endswith("第 1 个")
