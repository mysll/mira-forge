"""抽帧台：导出的帧集整包存成一条「帧集」资产。"""

from __future__ import annotations

import base64
import io
import zipfile

from fastapi.testclient import TestClient

API = "/api/v1"

TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _bundle(frames: int = 3) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for index in range(1, frames + 1):
            archive.writestr(f"frames/{index:04d}.png", TINY_PNG)
        archive.writestr("frames.json", b'{"fps":24,"frames":[]}')
    return buffer.getvalue()


def _save(client: TestClient, *, bundle: bytes | None = None, **form) -> tuple[int, dict]:
    data = {
        "name": "走路 8 帧",
        "count": "3",
        "width": "736",
        "height": "736",
        "fps": "24",
    }
    for key, value in form.items():
        data[key] = str(value)
    response = client.post(
        f"{API}/frames",
        data=data,
        files={
            "bundle": ("frames.zip", bundle if bundle is not None else _bundle(), "application/zip"),
            "cover": ("cover.png", TINY_PNG, "image/png"),
        },
    )
    return response.status_code, response.json()


def test_frame_set_lands_as_a_frameset_asset(client: TestClient) -> None:
    status, payload = _save(client)
    assert status == 201, payload
    assert payload["name"] == "走路 8 帧"
    assert payload["frame_count"] == 3
    assert payload["width"] == 736

    image = client.get(f"{API}/images/{payload['image_id']}").json()
    assert image["media_type"] == "frameset"
    assert image["frame_count"] == 3
    assert image["fps"] == 24
    assert image["file_path"].endswith(".zip")
    assert image["file_path"].startswith("frames/")

    generation = client.get(f"{API}/generations/{payload['generation_id']}").json()
    assert generation["generation_type"] == "local_frameset"
    assert generation["model_name"] == "framelab"
    assert generation["status"] == "completed"


def test_frame_set_is_downloadable_and_has_a_cover_thumbnail(client: TestClient) -> None:
    _, payload = _save(client)

    thumb = client.get(f"{API}/images/{payload['image_id']}/thumbnail")
    assert thumb.status_code == 200
    assert thumb.headers["content-type"] == "image/jpeg"

    bundle = client.get(f"{API}/images/{payload['image_id']}/file")
    assert bundle.status_code == 200
    assert bundle.headers["content-type"] == "application/zip"
    assert bundle.content.startswith(b"PK\x03\x04")


def test_frame_set_shows_up_under_the_asset_filter(client: TestClient) -> None:
    _, payload = _save(client)
    response = client.get(f"{API}/generations", params={"media": "asset", "limit": 60})
    assert response.status_code == 200
    ids = [item["id"] for item in response.json()["items"]]
    assert payload["generation_id"] in ids


def test_frame_set_rejects_a_non_zip_bundle(client: TestClient) -> None:
    status, payload = _save(client, bundle=b"not a zip at all")
    assert status == 400, payload
    assert "ZIP" in payload["detail"]


def test_frame_set_rejects_a_zero_count(client: TestClient) -> None:
    status, payload = _save(client, count=0)
    assert status == 400, payload
    assert "帧数" in payload["detail"]


def test_frame_set_rejects_an_empty_name(client: TestClient) -> None:
    status, payload = _save(client, name="   ")
    assert status == 400, payload
    assert "名字" in payload["detail"]
