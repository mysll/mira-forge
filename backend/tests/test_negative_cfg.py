"""负面提示词与 CFG 的关系。

ComfyUI 在 cfg≈1 时会走 cfg1 优化，直接跳过 uncond 分支（comfy/samplers.py:610），
负面提示词因此完全不参与采样。默认 CFG=1 的两个模型都会让人误以为负面提示词失效，
所以「有负面提示词但没显式给 CFG」时要按模型的 negative_prompt_cfg 自动提上去。
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def _create(client: TestClient, **overrides) -> dict:
    payload = {
        "prompt": "a red poppy on a white table",
        "model": "qwen_image_21",
        "generation_type": "text_to_image",
        "count": 1,
    }
    payload.update(overrides)
    response = client.post("/api/v1/generations", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def test_negative_prompt_raises_cfg_without_explicit_value(client: TestClient) -> None:
    created = _create(client, negative_prompt="red, crimson, orange")

    # 标准模型的建议值是 3.0，落库的 cfg 必须是实际生效值
    assert created["cfg"] == 3.0
    assert created["negative_prompt"] == "red, crimson, orange"


def test_explicit_cfg_wins_even_when_it_is_one(client: TestClient) -> None:
    created = _create(client, negative_prompt="red, crimson", cfg=1.0)

    # 显式给 1.0 说明用户知道自己在做什么，不偷偷改
    assert created["cfg"] == 1.0


def test_without_negative_prompt_cfg_stays_at_model_default(client: TestClient) -> None:
    created = _create(client)

    assert created["cfg"] == 1.0


def test_turbo_uses_its_own_negative_cfg(client: TestClient) -> None:
    created = _create(client, model="qwen_image_21_turbo", negative_prompt="blurry, watermark")

    # 蒸馏模型的 CFG 弹性差，建议值比标准模型低
    assert created["cfg"] == 2.0


def test_models_expose_negative_prompt_cfg(client: TestClient) -> None:
    models = {item["id"]: item for item in client.get("/api/v1/models").json()["items"]}

    assert models["qwen_image_21"]["negative_prompt_cfg"] == 3.0
    assert models["qwen_image_21_turbo"]["negative_prompt_cfg"] == 2.0
