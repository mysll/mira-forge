"""抽帧台：导出的帧集整包存成一条「帧集」资产。"""

from __future__ import annotations

import base64
import io
import zipfile

from fastapi.testclient import TestClient

from app.models.database import SessionLocal
from app.models.image import Image

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


def test_frame_set_does_not_show_the_source_video_as_a_reference(client: TestClient) -> None:
    """从资产里的视频抽帧时，来源视频只存 original_image_id，不该出现在「参考图」里。"""
    db = SessionLocal()
    source = Image(file_path="videos/source.mp4", media_type="video", width=736, height=736, file_size=1)
    db.add(source)
    db.commit()
    db.refresh(source)
    source_id = source.id
    db.close()

    status, payload = _save(client, source_video_id=source_id)
    assert status == 201, payload
    generation = client.get(f"{API}/generations/{payload['generation_id']}").json()
    assert generation["reference_images"] == []

    db = SessionLocal()
    saved = db.get(Image, payload["image_id"])
    assert saved is not None
    assert saved.original_image_id == source_id
    db.close()


def test_frame_set_can_be_overwritten_in_place(client: TestClient) -> None:
    status, created = _save(client, name="跳跃 3 帧")
    assert status == 201, created

    response = client.put(
        f"{API}/frames/{created['image_id']}",
        data={"name": "跳跃 5 帧", "count": "5", "width": "736", "height": "736", "fps": "24"},
        files={
            "bundle": ("frames.zip", _bundle(5), "application/zip"),
            "cover": ("cover.png", TINY_PNG, "image/png"),
        },
    )
    assert response.status_code == 200, response.text
    replaced = response.json()
    assert replaced["image_id"] == created["image_id"]
    assert replaced["generation_id"] == created["generation_id"]
    assert replaced["frame_count"] == 5

    # 资产库里仍然只有这一条，内容换成了新的那一包
    items = [
        item
        for item in client.get(f"{API}/images?limit=100&media=frameset").json()["items"]
        if item["id"] == created["image_id"]
    ]
    assert len(items) == 1
    assert items[0]["frame_count"] == 5

    with zipfile.ZipFile(io.BytesIO(client.get(f"{API}/images/{created['image_id']}/file").content)) as archive:
        assert len([name for name in archive.namelist() if name.startswith("frames/")]) == 5


def test_overwrite_rejects_unknown_or_non_frameset(client: TestClient) -> None:
    status, created = _save(client)
    assert status == 201, created

    missing = client.put(
        f"{API}/frames/999999",
        data={"name": "不存在", "count": "1", "width": "8", "height": "8"},
        files={"bundle": ("frames.zip", _bundle(1), "application/zip"), "cover": ("cover.png", TINY_PNG, "image/png")},
    )
    assert missing.status_code == 404
    assert "帧集" in missing.json()["detail"]

    # 一条普通图片不能被当成帧集覆盖
    db = SessionLocal()
    plain = Image(file_path="images/none.png", media_type="image", width=8, height=8, file_size=1)
    db.add(plain)
    db.commit()
    plain_id = plain.id
    db.close()
    wrong = client.put(
        f"{API}/frames/{plain_id}",
        data={"name": "不是帧集", "count": "1", "width": "8", "height": "8"},
        files={"bundle": ("frames.zip", _bundle(1), "application/zip"), "cover": ("cover.png", TINY_PNG, "image/png")},
    )
    assert wrong.status_code == 404
