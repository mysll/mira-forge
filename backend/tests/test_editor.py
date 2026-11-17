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

def _donut() -> bytes:
    """白底 + 红色圆环：圆环内部被包住的白块就是「封闭背景」。"""
    image = Image.new("RGB", (160, 160), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    draw.ellipse((30, 30, 129, 129), fill=(200, 40, 40))
    draw.ellipse((60, 60, 99, 99), fill=(255, 255, 255))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_analyze_reports_enclosed_background(client: TestClient) -> None:
    response = client.post(f"{API}/editor/analyze", files={"image": ("d.png", _donut(), "image/png")})
    assert response.status_code == 200, response.text
    body = response.json()
    # 圆环内部那圈白色不是边缘连通，会被算成封闭背景
    assert body["enclosed_background_share"] > 0.02, body


def test_color_mode_clears_enclosed_background(client: TestClient) -> None:
    response = client.post(
        f"{API}/editor/remove-background",
        files={"image": ("d.png", _donut(), "image/png")},
        data={"mode": "color", "tolerance": 4, "feather": 0},
    )
    assert response.status_code == 200, response.text
    alpha = np.array(_png_bytes(response.content))[..., 3]
    assert alpha[80, 80] == 0  # 圆环中心原本是背景色，现在也透明了


def test_denoise_fills_small_holes_but_keeps_big_ones(client: TestClient) -> None:
    """小孔被填上，大块封闭背景（圆环中心）保留为透明。"""
    image = Image.new("RGB", (160, 160), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    draw.ellipse((30, 30, 129, 129), fill=(200, 40, 40))
    draw.ellipse((60, 60, 99, 99), fill=(255, 255, 255))  # 大孔：封闭背景
    draw.rectangle((48, 48, 52, 52), fill=(255, 255, 255))  # 小孔：噪点
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    payload = buffer.getvalue()

    plain = client.post(
        f"{API}/editor/remove-background",
        files={"image": ("d.png", payload, "image/png")},
        data={"mode": "color", "tolerance": 4, "feather": 0, "denoise": 0},
    )
    cleaned = client.post(
        f"{API}/editor/remove-background",
        files={"image": ("d.png", payload, "image/png")},
        data={"mode": "color", "tolerance": 4, "feather": 0, "denoise": 1},
    )
    assert plain.status_code == 200 and cleaned.status_code == 200
    before = np.array(_png_bytes(plain.content))[..., 3]
    after = np.array(_png_bytes(cleaned.content))[..., 3]
    assert before[50, 50] == 0  # 小孔原本是透明的
    assert after[50, 50] == 255  # 去杂点后填上了
    assert after[80, 80] == 0  # 大孔（封闭背景）仍然是透明的


def test_save_edited_image_lands_in_assets(client: TestClient) -> None:
    saved = client.post(
        f"{API}/editor/save",
        files={"image": ("edited.png", _sprite(), "image/png")},
        data={"prompt": "本地编辑 · 测试"},
    )
    assert saved.status_code == 201, saved.text
    body = saved.json()
    assert body["width"] == 120 and body["height"] == 120
    assert body["file_size"] > 0

    generation = client.get(f"{API}/generations/{body['generation_id']}")
    assert generation.status_code == 200
    payload = generation.json()
    assert payload["generation_type"] == "local_edit"
    assert payload["status"] == "completed"
    assert payload["prompt"] == "本地编辑 · 测试"
    assert len(payload["images"]) == 1

    # 出现在图片列表与「图片」筛选里，能被资产页看到
    listed = client.get(f"{API}/images", params={"generation_id": body["generation_id"]})
    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    images = client.get(f"{API}/generations", params={"media": "image", "q": "本地编辑"})
    assert images.status_code == 200
    assert images.json()["total"] == 1

    served = client.get(f"{API}/images/{body['image_id']}/file")
    assert served.status_code == 200
    assert served.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_save_edited_image_links_back_to_source(client: TestClient) -> None:
    created = client.post(
        f"{API}/generations",
        json={"prompt": "a teacup", "model": "qwen_image_21_turbo", "count": 1},
    )
    assert created.status_code == 201, created.text
    generation_id = created.json()["id"]

    # 直接落一张图当「原图」，模拟资产里已有的作品
    from app.models.database import session_for
    from app.core.projects import active_project
    from app.services.image_service import store_image
    from app.models.image import Image
    from app.models.task import GenerationTask
    from sqlalchemy import select

    session = session_for(active_project())
    try:
        task = session.scalar(
            select(GenerationTask).where(GenerationTask.generation_id == generation_id)
        )
        assert task is not None
        source = store_image(
            session,
            content=_sprite(),
            generation_id=generation_id,
            task_id=task.id,
            index=0,
        )
        session.commit()
        source_id = source.id
    finally:
        session.close()

    saved = client.post(
        f"{API}/editor/save",
        files={"image": ("edited.png", _sprite(), "image/png")},
        data={"source_image_id": str(source_id)},
    )
    assert saved.status_code == 201, saved.text
    detail = client.get(f"{API}/generations/{saved.json()['generation_id']}").json()
    assert detail["prompt"] == f"本地编辑 · 来自图 #{source_id}"
    assert detail["reference_images"], detail
