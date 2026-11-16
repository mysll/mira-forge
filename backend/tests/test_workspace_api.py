"""工作台重构的接口增补：生成参数落库、批次筛选、图片收藏。"""

from __future__ import annotations

import base64

from fastapi.testclient import TestClient

from app.models.database import SessionLocal
from app.services.image_service import store_image

API = "/api/v1"

TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _create(client: TestClient, prompt: str, **extra) -> dict:
    payload = {"prompt": prompt, "model": "qwen_image_21", "count": 1, **extra}
    response = client.post(f"{API}/generations", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _add_image(client: TestClient, generation: dict) -> int:
    with SessionLocal() as db:
        image = store_image(
            db,
            content=TINY_PNG,
            generation_id=generation["id"],
            task_id=generation["tasks"][0]["id"],
            index=0,
            width=1,
            height=1,
        )
        db.commit()
        return image.id


def test_generation_params_are_persisted(client: TestClient) -> None:
    body = _create(
        client,
        "brass automaton",
        negative_prompt="blurry, watermark",
        seed=12345,
        steps=12,
        cfg=4.5,
        sampler="heun",
        count=3,
    )

    assert body["negative_prompt"] == "blurry, watermark"
    assert body["steps"] == 12
    assert body["cfg"] == 4.5
    assert body["sampler"] == "heun"
    # 固定 seed 时同一批按 base+i 递增，保证可复现且不重复
    assert [task["seed"] for task in body["tasks"]] == [12345, 12346, 12347]


def test_random_seed_ignored_when_not_given(client: TestClient) -> None:
    body = _create(client, "random seed", count=2)
    seeds = [task["seed"] for task in body["tasks"]]
    assert len(set(seeds)) == 2
    assert all(seed != 0 for seed in seeds)


def test_list_includes_images_and_progress(client: TestClient) -> None:
    generation = _create(client, "with image")
    image_id = _add_image(client, generation)

    body = client.get(f"{API}/generations", params={"limit": 5}).json()
    item = next(entry for entry in body["items"] if entry["id"] == generation["id"])
    assert [image["id"] for image in item["images"]] == [image_id]
    assert item["images"][0]["is_favorite"] is False
    assert item["progress"] == 0


def test_search_filter(client: TestClient) -> None:
    _create(client, "copper fox in an alley")
    _create(client, "ceramic owl on a shelf")

    body = client.get(f"{API}/generations", params={"q": "copper fox"}).json()
    prompts = [item["prompt"] for item in body["items"]]
    assert prompts and all("copper fox" in prompt for prompt in prompts)

    empty = client.get(f"{API}/generations", params={"q": "no-such-prompt-here"}).json()
    assert empty["items"] == [] and empty["total"] == 0


def test_model_filter(client: TestClient) -> None:
    _create(client, "standard model", model="qwen_image_21")
    _create(client, "turbo model", model="qwen_image_21_turbo")

    body = client.get(
        f"{API}/generations", params={"model": "qwen_image_21_turbo"}
    ).json()
    models = {item["model_name"] for item in body["items"]}
    assert models == {"qwen_image_21_turbo"}


def test_favorite_toggle_and_filter(client: TestClient) -> None:
    generation = _create(client, "favorite me")
    image_id = _add_image(client, generation)

    marked = client.post(f"{API}/images/{image_id}/favorite", json={"favorite": True})
    assert marked.status_code == 200
    assert marked.json()["is_favorite"] is True

    favorites = client.get(f"{API}/generations", params={"favorite": True}).json()
    assert generation["id"] in [item["id"] for item in favorites["items"]]

    unmarked = client.post(f"{API}/images/{image_id}/favorite", json={"favorite": False})
    assert unmarked.json()["is_favorite"] is False
    after = client.get(f"{API}/generations", params={"favorite": True}).json()
    assert generation["id"] not in [item["id"] for item in after["items"]]


def test_favorite_unknown_image_is_404(client: TestClient) -> None:
    response = client.post(f"{API}/images/999999/favorite", json={"favorite": True})
    assert response.status_code == 404


def test_date_filter_rejects_bad_input(client: TestClient) -> None:
    response = client.get(f"{API}/generations", params={"date_from": "not-a-date"})
    assert response.status_code == 422


def test_date_filter_excludes_old_rows(client: TestClient) -> None:
    _create(client, "old one")
    future = "2999-01-01T00:00:00Z"
    assert client.get(f"{API}/generations", params={"date_from": future}).json()["items"] == []
    past = "2000-01-01T00:00:00Z"
    assert client.get(f"{API}/generations", params={"date_to": past}).json()["items"] == []
