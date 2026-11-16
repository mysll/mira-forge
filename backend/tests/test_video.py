"""视频二期（MiniMax H3）的接口与图组装测试。

不碰 ComfyUI：只验证校验规则与「首帧/尾帧到底接到了哪」。
"""

from __future__ import annotations

import pytest

from fastapi.testclient import TestClient
from app.services import workflow_service
from app.services.prompt_builder import build_prompt, load_graph
from app.services.workflow_config import load_workflow_config
from app.workers.generation_worker import _video_length

API = "/api/v1"
TINY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000d4944415478da63f8ffff3f0005fe02fea735c4b70000000049454e44ae426082"
)


def _video_target(workflow_type: str):
    model = workflow_service.get_model("minimax_h3")
    assert model is not None
    target = workflow_service.get_workflow_target(model, workflow_type)
    assert target is not None and target.available
    return target


def _graph(workflow_type: str):
    target = _video_target(workflow_type)
    return load_graph(target.json_path), load_workflow_config(target.config_path)


def _file(name: str = "frame.png") -> dict:
    return {"files": (name, TINY_PNG, "image/png")}


def test_text_to_video_accepts_duration_and_fps(client: TestClient) -> None:
    response = client.post(
        f"{API}/generations",
        json={
            "prompt": "海边的灯塔在暮色里亮起来",
            "model": "minimax_h3",
            "generation_type": "text_to_video",
            "duration_seconds": 4,
            "fps": 24,
            "width": 864,
            "height": 480,
            "count": 1,
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["generation_type"] == "text_to_video"
    assert body["duration_seconds"] == 4
    assert body["fps"] == 24
    assert len(body["tasks"]) == 1


def test_video_rejects_unknown_duration(client: TestClient) -> None:
    response = client.post(
        f"{API}/generations",
        json={
            "prompt": "x",
            "model": "minimax_h3",
            "generation_type": "text_to_video",
            "duration_seconds": 20,
        },
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "1" in detail and "15" in detail and "20" in detail


def test_video_only_one_per_request(client: TestClient) -> None:
    response = client.post(
        f"{API}/generations",
        json={
            "prompt": "x",
            "model": "minimax_h3",
            "generation_type": "text_to_video",
            "count": 2,
        },
    )
    assert response.status_code == 422
    assert "1 条" in response.json()["detail"]


def test_video_size_must_align_to_32(client: TestClient) -> None:
    response = client.post(
        f"{API}/generations",
        json={
            "prompt": "x",
            "model": "minimax_h3",
            "generation_type": "text_to_video",
            "width": 870,
            "height": 480,
        },
    )
    assert response.status_code == 422
    assert "32" in response.json()["detail"]


def test_image_to_video_with_two_frames(client: TestClient) -> None:
    response = client.post(
        f"{API}/generations/image-to-video",
        data={"prompt": "从白天走到夜晚", "model": "minimax_h3", "duration_seconds": "5"},
        files=[("files", ("a.png", TINY_PNG, "image/png")), ("files", ("b.png", TINY_PNG, "image/png"))],
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["generation_type"] == "image_to_video"
    assert len(body["reference_images"]) == 2


def test_image_to_video_without_frames_falls_back_to_text(client: TestClient) -> None:
    """用户约定：两张图都不给就退化成文生视频，而不是报错。"""
    response = client.post(
        f"{API}/generations/image-to-video",
        data={"prompt": "只有文字也要能出片", "model": "minimax_h3"},
    )
    assert response.status_code == 201, response.text
    assert response.json()["generation_type"] == "text_to_video"


def test_image_to_video_rejects_three_frames(client: TestClient) -> None:
    response = client.post(
        f"{API}/generations/image-to-video",
        data={"prompt": "x", "model": "minimax_h3"},
        files=[("files", (f"{i}.png", TINY_PNG, "image/png")) for i in range(3)],
    )
    assert response.status_code == 422
    assert "最多 2 张" in response.json()["detail"]


def test_t2v_graph_binds_length_and_fps() -> None:
    graph, config = _graph("text_to_video")
    prompt = build_prompt(
        graph,
        config,
        {
            "prompt": "a lighthouse",
            "width": 864,
            "height": 480,
            "length": 124,
            "fps": 24.0,
            "seed": 7,
            "filename_prefix": "miraforge/video",
            "poster_prefix": "miraforge/video_poster",
        },
    )
    assert prompt["6"]["inputs"]["prompt"] == "a lighthouse"
    assert prompt["6"]["inputs"]["length"] == 124
    assert prompt["14"]["inputs"]["fps"] == 24.0
    assert prompt["15"]["inputs"]["filename_prefix"] == "miraforge/video"
    assert prompt["17"]["inputs"]["filename_prefix"] == "miraforge/video_poster"
    # 文生视频不该碰到 LoadImage
    assert "20" not in prompt and "21" not in prompt


def test_i2v_graph_attaches_first_and_last_frame() -> None:
    graph, config = _graph("image_to_video")
    prompt = build_prompt(
        graph,
        config,
        {"prompt": "walk", "width": 864, "height": 480, "length": 124, "fps": 24.0},
        frames={"first": "miraforge_frame_1_first.png", "last": "miraforge_frame_1_last.png"},
    )
    assert prompt["20"]["inputs"]["image"] == "miraforge_frame_1_first.png"
    assert prompt["21"]["inputs"]["image"] == "miraforge_frame_1_last.png"
    assert prompt["6"]["inputs"]["first_frame"] == ["20", 0]
    assert prompt["6"]["inputs"]["last_frame"] == ["21", 0]


def test_i2v_graph_drops_last_frame_when_absent() -> None:
    graph, config = _graph("image_to_video")
    prompt = build_prompt(
        graph,
        config,
        {"prompt": "walk", "width": 864, "height": 480, "length": 124, "fps": 24.0},
        frames={"first": "only_first.png"},
    )
    assert prompt["6"]["inputs"]["first_frame"] == ["20", 0]
    # 尾帧没给：输入与节点都要摘掉，否则 ComfyUI 会去找 placeholder.png
    assert "last_frame" not in prompt["6"]["inputs"]
    assert "21" not in prompt


def test_i2v_graph_with_no_frames_is_plain_text() -> None:
    graph, config = _graph("image_to_video")
    prompt = build_prompt(
        graph,
        config,
        {"prompt": "walk", "width": 864, "height": 480, "length": 124, "fps": 24.0},
        frames={},
    )
    assert "first_frame" not in prompt["6"]["inputs"]
    assert "last_frame" not in prompt["6"]["inputs"]
    assert "20" not in prompt and "21" not in prompt


@pytest.mark.parametrize(
    ("seconds", "expected"),
    [(1, 39), (3, 73), (5, 124), (7, 175), (10, 243), (15, 362)],
)
def test_video_length_snaps_to_five_plus_seventeen_k(seconds: int, expected: int) -> None:
    """1–15 秒任意整数都要落到 5 + 17k 上，越界的秒数由接口挡掉。"""
    frames = _video_length(seconds, 24.0)
    assert frames == expected
    assert frames >= 5 and (frames - 5) % 17 == 0


