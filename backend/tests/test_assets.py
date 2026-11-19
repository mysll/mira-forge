"""素材（asset）：工坊导出的图集 PNG / JSON / ZIP 存进资产库。"""

from __future__ import annotations

import base64
import io
import zipfile

from fastapi.testclient import TestClient

API = "/api/v1"

TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _zip_with_png() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("atlas_01.png", TINY_PNG)
        archive.writestr("atlas.json", b'{"atlas":{}}')
    return buffer.getvalue()


def _save(client: TestClient, filename: str, content: bytes, **form) -> tuple[int, dict]:
    data = {"name": form.pop("name", "测试图集")}
    data.update({key: str(value) for key, value in form.items()})
    response = client.post(
        f"{API}/assets",
        files={"file": (filename, content, "application/octet-stream")},
        data=data,
    )
    return response.status_code, response.json()


def test_save_png_asset_lands_under_assets(client: TestClient) -> None:
    status, payload = _save(client, "atlas_01.png", TINY_PNG)
    assert status == 201, payload
    assert payload["media_type"] == "asset"
    assert payload["file_size"] == len(TINY_PNG)
    assert payload["width"] == 1 and payload["height"] == 1

    detail = client.get(f"{API}/images/{payload['image_id']}").json()
    assert detail["file_path"].startswith("assets/")
    assert detail["media_type"] == "asset"

    file = client.get(f"{API}/images/{payload['image_id']}/file")
    assert file.status_code == 200
    assert file.headers["content-type"].startswith("image/png")


def test_asset_shows_up_under_media_asset_only(client: TestClient) -> None:
    before = client.get(f"{API}/generations", params={"media": "asset"}).json()["total"]
    status, payload = _save(client, "atlas_02.png", TINY_PNG)
    assert status == 201

    assets = client.get(f"{API}/generations", params={"media": "asset"}).json()
    assert assets["total"] == before + 1
    assert assets["items"][0]["generation_type"] == "local_asset"
    assert assets["items"][0]["images"][0]["media_type"] == "asset"

    for media in ("image", "video"):
        rows = client.get(f"{API}/generations", params={"media": media, "limit": 100}).json()
        assert all(item["generation_type"] != "local_asset" for item in rows["items"])

    unknown = client.get(f"{API}/generations", params={"media": "3d"})
    assert unknown.status_code == 422


def test_zip_asset_uses_first_png_as_thumbnail(client: TestClient) -> None:
    status, payload = _save(client, "atlas.zip", _zip_with_png())
    assert status == 201, payload
    assert payload["width"] == 1 and payload["height"] == 1

    file = client.get(f"{API}/images/{payload['image_id']}/file")
    assert file.headers["content-type"] == "application/zip"

    thumbnail = client.get(f"{API}/images/{payload['image_id']}/thumbnail")
    assert thumbnail.status_code == 200
    assert thumbnail.headers["content-type"].startswith("image/jpeg")


def test_json_asset_is_stored_without_preview(client: TestClient) -> None:
    status, payload = _save(client, "atlas.json", b'{"atlas":{"name":"demo"},"pages":[]}')
    assert status == 201, payload
    assert payload["width"] == 0 and payload["height"] == 0

    file = client.get(f"{API}/images/{payload['image_id']}/file")
    assert file.headers["content-type"] == "application/json"


def test_asset_rejects_unknown_extension(client: TestClient) -> None:
    status, payload = _save(client, "notes.txt", b"hello")
    assert status == 422
    assert "PNG" in payload["detail"]


def test_asset_rejects_empty_file(client: TestClient) -> None:
    status, payload = _save(client, "atlas.png", b"")
    assert status == 422
    assert "空" in payload["detail"]


def test_replace_asset_keeps_one_entry_with_new_content(client: TestClient) -> None:
    status, created = _save(client, "atlas_old.zip", _zip_with_png())
    assert status == 201, created
    before = client.get(f"{API}/generations", params={"media": "asset"}).json()["total"]
    old_image_id = created["image_id"]

    response = client.put(
        f"{API}/assets/{old_image_id}",
        files={"file": ("atlas_new.zip", _zip_with_png(), "application/octet-stream")},
        data={"name": "覆盖后的图集"},
    )
    assert response.status_code == 200, response.json()
    replaced = response.json()
    assert replaced["replaced"] is True
    assert replaced["image_id"] == old_image_id
    assert replaced["generation_id"] == created["generation_id"]

    # 资产库里还是那一条，批次没变、没多出来
    after = client.get(f"{API}/generations", params={"media": "asset"}).json()
    assert after["total"] == before

    # 同一个产物 id，但内容已经换新（ZIP 的 content-type 不会变成图片）
    file = client.get(f"{API}/images/{old_image_id}/file")
    assert file.status_code == 200
    assert file.headers["content-type"] == "application/zip"


def test_replace_asset_rejects_unknown_or_non_asset(client: TestClient) -> None:
    response = client.put(
        f"{API}/assets/999999",
        files={"file": ("atlas.zip", _zip_with_png(), "application/octet-stream")},
        data={"name": "x"},
    )
    assert response.status_code == 404
    assert "素材" in response.json()["detail"]


def test_asset_keeps_the_atlas_name_as_the_batch_name(client: TestClient) -> None:
    """工坊导出时填的图集名要盖过文件名：卡片左上角显示的就是它。"""
    status, payload = _save(client, "atlas_77.png", TINY_PNG, name="角色战斗图集")
    assert status == 201, payload

    generation = client.get(f"{API}/generations/{payload['generation_id']}").json()
    assert generation["name"] == "角色战斗图集"
    assert generation["images"][0]["label"] == "角色战斗图集 · 第 1 个"


def test_overwriting_an_asset_updates_its_name(client: TestClient) -> None:
    status, payload = _save(client, "atlas_78.png", TINY_PNG, name="旧图集名")
    assert status == 201

    response = client.put(
        f"{API}/assets/{payload['image_id']}",
        files={"file": ("atlas_78.png", TINY_PNG, "application/octet-stream")},
        data={"name": "新图集名"},
    )
    assert response.status_code == 200, response.json()

    generation = client.get(f"{API}/generations/{payload['generation_id']}").json()
    assert generation["name"] == "新图集名"
