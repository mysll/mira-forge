"""局部编辑：遮罩上传、落点与「掩码外不动」的图结构。"""

from __future__ import annotations

import base64

from fastapi.testclient import TestClient

from app.services.prompt_builder import PromptBuildError
from app.services.prompt_builder import build_prompt as _build
from app.services.workflow_config import load_workflow_config
from app.services.workflow_service import get_model, get_workflow_target
from app.workers.generation_worker import _edit_resolution

API = "/api/v1"

TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _edit(client: TestClient, *, mask: bytes | None = None, model: str = "qwen_image_21_turbo"):
    data = {"prompt": "a red scarf", "model": model, "count": 1}
    files = [("images", ("ref.png", TINY_PNG, "image/png"))]
    if mask is not None:
        files.append(("mask", ("mask.png", mask, "image/png")))
    return client.post(f"{API}/generations/edit", data=data, files=files)


def _graph(model_id: str, generation_type: str):
    model = get_model(model_id)
    assert model is not None
    target = get_workflow_target(model, generation_type)
    assert target is not None, f"{model_id} 没有 {generation_type} 工作流"
    config = load_workflow_config(target.config_path)
    return target, config


def test_edit_with_mask_switches_to_inpaint(client: TestClient) -> None:
    response = _edit(client, mask=TINY_PNG)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["generation_type"] == "image_inpaint"
    assert body["has_mask"] is True
    served = client.get(f"{API}/generations/{body['id']}/mask")
    assert served.status_code == 200
    assert served.content == TINY_PNG


def test_edit_without_mask_stays_a_plain_edit(client: TestClient) -> None:
    response = _edit(client)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["generation_type"] == "image_edit"
    assert body["has_mask"] is False
    assert client.get(f"{API}/generations/{body['id']}/mask").status_code == 404


def test_inpaint_mask_lands_in_its_own_loadimage() -> None:
    """遮罩写进节点 8，潜空间来自 VAEEncode + SetLatentNoiseMask 而不是编码器。"""
    target, config = _graph("qwen_image_21", "image_inpaint")
    graph = _load(target.json_path)
    prompt = _build(
        graph,
        config,
        {"prompt": "a red scarf", "resolution": 1024, "seed": 7, "filename_prefix": "t"},
        reference_images=["ref.png", "ref2.png"],
        mask_image="mask.png",
    )
    assert config.mask is not None and config.mask.node == "8"
    assert prompt["8"]["inputs"]["image"] == "mask.png"
    assert prompt["9"]["class_type"] == "ImageToMask"
    assert prompt["9"]["inputs"]["image"] == ["8", 0]
    assert prompt["10"]["class_type"] == "SetLatentNoiseMask"
    assert prompt["10"]["inputs"]["samples"] == ["7", 0]
    assert prompt["10"]["inputs"]["mask"] == ["9", 0]
    assert prompt["7"]["class_type"] == "VAEEncode"
    assert prompt["7"]["inputs"]["pixels"] == ["1", 0]
    assert prompt["11"]["inputs"]["latent_image"] == ["10", 0]
    # 两张参考图仍然进编码器的两个槽位
    assert prompt["6"]["inputs"]["images.image_1"] == ["1", 0]
    assert prompt["6"]["inputs"]["images.image_2"] == ["20", 0]


def test_inpaint_requires_a_mask() -> None:
    target, config = _graph("qwen_image_21", "image_inpaint")
    graph = _load(target.json_path)
    try:
        _build(graph, config, {"prompt": "x"}, reference_images=["ref.png"])
    except PromptBuildError as exc:
        assert "遮罩" in str(exc)
    else:  # pragma: no cover - 没抛就是位置写错了
        raise AssertionError("没有遮罩时应当报错，而不是按整图重绘")


def test_single_reference_detaches_the_second_slot() -> None:
    """只给 1 张图时第 2 个 LoadImage 要被摘掉，否则 ComfyUI 会去读占位图。"""
    target, config = _graph("qwen_image_21", "image_inpaint")
    graph = _load(target.json_path)
    prompt = _build(
        graph, config, {"prompt": "x"}, reference_images=["only.png"], mask_image="mask.png"
    )
    assert "20" not in prompt
    assert "images.image_2" not in prompt["6"]["inputs"]
    assert prompt["8"]["inputs"]["image"] == "mask.png"


def test_turbo_inpaint_uses_the_fixed_sigma_chain() -> None:
    target, config = _graph("qwen_image_21_turbo", "image_inpaint")
    graph = _load(target.json_path)
    prompt = _build(
        graph,
        config,
        {"prompt": "x", "cfg": 2.0, "sampler": "dpmpp_2m", "seed": 3},
        reference_images=["ref.png"],
        mask_image="mask.png",
    )
    assert prompt["14"]["class_type"] == "ManualSigmas"
    assert isinstance(prompt["14"]["inputs"]["sigmas"], str)
    assert prompt["12"]["inputs"]["cfg"] == 2.0
    assert prompt["13"]["inputs"]["sampler_name"] == "dpmpp_2m"
    assert prompt["11"]["inputs"]["noise_seed"] == 3
    assert prompt["15"]["inputs"]["latent_image"] == ["10", 0]
    # 蒸馏版没有 steps 落点，传了也不会写进图
    assert "steps" not in prompt["14"]["inputs"]


def test_inpaint_keeps_the_reference_resolution() -> None:
    """局部编辑的尺寸跟随参考图，width/height 只决定编码分辨率。"""
    assert _edit_resolution(1024, 1024) == 1024
    assert _edit_resolution(0, 0) == 1024


def _load(json_path: str):
    from app.services.prompt_builder import load_graph

    return load_graph(json_path)
