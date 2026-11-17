"""本地图片编辑器的接口测试：抠底、裁边、参数校验。"""

from __future__ import annotations

import io

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

API = "/api/v1"


def _sprite() -> bytes:
    """白底 + 红色方块“主体”，主体内部再放一个白色小方块，用来区分两种抠底模式。"""
    image = Image.new("RGB", (120, 120), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    draw.rectangle((30, 30, 89, 89), fill=(200, 40, 40))
    draw.rectangle((52, 52, 67, 67), fill=(255, 255, 255))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _png_bytes(content: bytes) -> Image.Image:
    return Image.open(io.BytesIO(content)).convert("RGBA")


def test_analyze_reports_size_and_background(client: TestClient) -> None:
    response = client.post(f"{API}/editor/analyze", files={"image": ("s.png", _sprite(), "image/png")})
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["width"], body["height"]) == (120, 120)
    assert body["background"] == [255, 255, 255]
    assert body["has_alpha"] is False
    assert body["suggested_tolerance"] >= 4


def test_remove_background_edge_keeps_inner_white(client: TestClient) -> None:
    response = client.post(
        f"{API}/editor/remove-background",
        files={"image": ("s.png", _sprite(), "image/png")},
        data={"mode": "edge", "tolerance": 10, "feather": 0},
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-background-color"] == "#ffffff"

    alpha = np.asarray(_png_bytes(response.content))[..., 3]
    assert alpha[0, 0] == 0, "画布角落应该被抠掉"
    assert alpha[60, 40] == 255, "红色主体必须保留"
    assert alpha[60, 60] == 255, "主体内部的白色块不与边缘连通，应该保留"


def test_remove_background_color_mode_removes_all_matching(client: TestClient) -> None:
    response = client.post(
        f"{API}/editor/remove-background",
        files={"image": ("s.png", _sprite(), "image/png")},
        data={"mode": "color", "tolerance": 10, "feather": 0},
    )
    assert response.status_code == 200, response.text
    alpha = np.asarray(_png_bytes(response.content))[..., 3]
    assert alpha[0, 0] == 0
    assert alpha[60, 40] == 255
    assert alpha[60, 60] == 0, "color 模式会把主体内部的同色像素也删掉"


def test_tolerance_is_respected(client: TestClient) -> None:
    response = client.post(
        f"{API}/editor/remove-background",
        files={"image": ("s.png", _sprite(), "image/png")},
        data={"mode": "edge", "tolerance": 0, "feather": 0},
    )
    alpha = np.asarray(_png_bytes(response.content))[..., 3]
    assert alpha[0, 0] == 0
    # 容差 0 时白色与主体边界处不应被误删
    assert alpha[60, 40] == 255


def test_trim_drops_transparent_border(client: TestClient) -> None:
    edge = client.post(
        f"{API}/editor/remove-background",
        files={"image": ("s.png", _sprite(), "image/png")},
        data={"mode": "edge", "tolerance": 10, "feather": 0},
    )
    assert edge.status_code == 200
    trimmed = client.post(
        f"{API}/editor/trim",
        files={"image": ("s.png", edge.content, "image/png")},
        data={"padding": 0},
    )
    assert trimmed.status_code == 200, trimmed.text
    assert trimmed.headers["x-content-box"] == "30,30,90,90"
    body = _png_bytes(trimmed.content)
    assert body.size == (60, 60)


def test_rejects_non_image(client: TestClient) -> None:
    response = client.post(
        f"{API}/editor/remove-background",
        files={"image": ("a.txt", b"not an image", "text/plain")},
    )
    assert response.status_code == 422
    assert "PNG" in response.json()["detail"]


def test_rejects_bad_parameters(client: TestClient) -> None:
    response = client.post(
        f"{API}/editor/remove-background",
        files={"image": ("s.png", _sprite(), "image/png")},
        data={"mode": "magic"},
    )
    assert response.status_code == 422
    assert "edge" in response.json()["detail"]
