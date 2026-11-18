"""Z-Image / FLUX.2 Klein 三个新模型的工作流组装测试（不碰 ComfyUI）。"""

from __future__ import annotations

import pytest

from app.services import workflow_service
from app.services.prompt_builder import build_prompt, load_graph
from app.services.workflow_config import load_workflow_config


def _built(model_id: str, params: dict) -> tuple[dict, dict]:
    model = workflow_service.get_model(model_id)
    assert model is not None
    target = workflow_service.get_workflow_target(model, "text_to_image")
    assert target is not None and target.available
    graph = load_graph(target.json_path)
    config = load_workflow_config(target.config_path)
    return model, build_prompt(graph, config, params)


def test_new_models_are_in_the_catalog() -> None:
    models = {item.id: item for item in workflow_service.list_models()}

    for model_id in ("z_image_turbo", "flux2_klein_distilled", "flux2_klein_base"):
        model = models[model_id]
        assert model.available, f"{model_id} 的工作流 JSON 不存在"
        assert model.capabilities.media == "image"
        assert [target.type for target in model.workflows] == ["text_to_image"]

    assert models["z_image_turbo"].capabilities.exposes_negative_prompt is False
    assert models["flux2_klein_distilled"].capabilities.exposes_negative_prompt is False
    # 只有基础版能真的用负面提示词（cfg=5，uncond 分支会参与计算）
    assert models["flux2_klein_base"].capabilities.exposes_negative_prompt is True


def test_z_image_turbo_binds_prompt_size_and_sampler() -> None:
    _model, prompt = _built(
        "z_image_turbo",
        {
            "prompt": "a brass automaton",
            "negative_prompt": "blurry",
            "seed": 42,
            "width": 768,
            "height": 512,
            "sampler": "res_multistep",
            "scheduler": "simple",
            "filename_prefix": "miraforge/test",
        },
    )

    assert prompt["4"]["inputs"]["text"] == "a brass automaton"
    assert prompt["6"]["inputs"]["width"] == 768
    assert prompt["6"]["inputs"]["height"] == 512
    assert prompt["8"]["inputs"]["seed"] == 42
    assert prompt["8"]["inputs"]["sampler_name"] == "res_multistep"
    assert prompt["8"]["inputs"]["scheduler"] == "simple"
    assert prompt["10"]["inputs"]["filename_prefix"] == "miraforge/test"
    # 负向来自 ConditioningZeroOut，传进来的 negative_prompt 没有被写进任何节点
    assert prompt["5"]["class_type"] == "ConditioningZeroOut"
    assert prompt["8"]["inputs"]["negative"] == ["5", 0]


@pytest.mark.parametrize("model_id", ["flux2_klein_distilled", "flux2_klein_base"])
def test_klein_size_reaches_both_scheduler_and_latent(model_id: str) -> None:
    _model, prompt = _built(model_id, {"prompt": "x", "width": 768, "height": 512, "seed": 7})

    # 宽高只写进两个 PrimitiveInt，再由它们同时喂 scheduler 与 latent
    assert prompt["6"]["inputs"]["value"] == 768
    assert prompt["7"]["inputs"]["value"] == 512
    assert prompt["9"]["inputs"]["width"] == ["6", 0]
    assert prompt["9"]["inputs"]["height"] == ["7", 0]
    assert prompt["8"]["inputs"]["width"] == ["6", 0]
    assert prompt["8"]["inputs"]["height"] == ["7", 0]
    assert prompt["11"]["inputs"]["noise_seed"] == 7


def test_klein_base_binds_negative_prompt_to_its_own_encoder() -> None:
    _model, prompt = _built(
        "flux2_klein_base",
        {"prompt": "a red fox", "negative_prompt": "blurry, extra legs", "steps": 12, "cfg": 4.0},
    )

    assert prompt["4"]["inputs"]["text"] == "a red fox"
    assert prompt["5"]["inputs"]["text"] == "blurry, extra legs"
    assert prompt["12"]["inputs"]["positive"] == ["4", 0]
    assert prompt["12"]["inputs"]["negative"] == ["5", 0]
    assert prompt["9"]["inputs"]["steps"] == 12
    assert prompt["12"]["inputs"]["cfg"] == 4.0


def test_klein_distilled_ignores_negative_prompt_and_steps() -> None:
    _model, prompt = _built(
        "flux2_klein_distilled",
        {"prompt": "a red fox", "negative_prompt": "blurry", "steps": 30, "cfg": 6.0},
    )

    # 蒸馏版没有 negative_prompt / steps / cfg 的落点，传了也不该改图
    assert prompt["5"]["class_type"] == "ConditioningZeroOut"
    assert prompt["9"]["inputs"]["steps"] == 4
    assert prompt["12"]["inputs"]["cfg"] == 1.0
