"""工作流图组装与状态聚合的单元测试（不碰 ComfyUI）。"""

from __future__ import annotations

import pytest

from app.models.generation import GenerationStatus
from app.models.task import TaskStatus
from app.services import workflow_service
from app.services.generation_service import aggregate_generation_status
from app.services.prompt_builder import PromptBuildError, build_prompt, load_graph
from app.services.workflow_config import WorkflowConfig, load_workflow_config


def _target(model_id: str, workflow_type: str):
    model = workflow_service.get_model(model_id)
    assert model is not None
    target = workflow_service.get_workflow_target(model, workflow_type)
    assert target is not None and target.available, f"{model_id}/{workflow_type} 工作流 JSON 缺失"
    return model, target


def test_turbo_t2i_binds_params_without_steps() -> None:
    model, target = _target("qwen_image_21_turbo", "text_to_image")
    graph = load_graph(target.json_path)
    config = load_workflow_config(target.config_path)

    prompt = build_prompt(
        graph,
        config,
        {
            "prompt": "a brass automaton",
            "negative_prompt": "blurry",
            "seed": 42,
            "width": 768,
            "height": 512,
            "steps": 8,
            "cfg": 1.0,
            "filename_prefix": "miraforge/test",
        },
    )

    assert prompt["5"]["inputs"]["prompt"] == "a brass automaton"
    assert prompt["5"]["inputs"]["negative_prompt"] == "blurry"
    assert prompt["6"]["inputs"]["width"] == 768
    assert prompt["6"]["inputs"]["height"] == 512
    assert prompt["7"]["inputs"]["noise_seed"] == 42
    assert prompt["13"]["inputs"]["filename_prefix"] == "miraforge/test"
    # turbo 的步数由 sigma 表决定，图里不应该有 steps 输入
    assert "steps" not in prompt["10"]["inputs"]
    assert isinstance(prompt["10"]["inputs"]["sigmas"], str)


def test_standard_t2i_binds_ksampler_params() -> None:
    _model, target = _target("qwen_image_21", "text_to_image")
    graph = load_graph(target.json_path)
    config = load_workflow_config(target.config_path)

    prompt = build_prompt(
        graph,
        config,
        {"prompt": "x", "seed": 7, "steps": 25, "cfg": 1.0, "sampler": "euler", "scheduler": "simple"},
    )

    assert prompt["7"]["inputs"]["seed"] == 7
    assert prompt["7"]["inputs"]["steps"] == 25
    assert prompt["7"]["inputs"]["sampler_name"] == "euler"
    # 文生图里编码器没有参考图输入
    assert "images.image_1" not in prompt["5"]["inputs"]


def test_edit_requires_reference_image() -> None:
    _model, target = _target("qwen_image_21", "image_edit")
    graph = load_graph(target.json_path)
    config = load_workflow_config(target.config_path)

    with pytest.raises(PromptBuildError, match="需要参考图"):
        build_prompt(graph, config, {"prompt": "x"})


def test_edit_wires_reference_image_into_encoder() -> None:
    _model, target = _target("qwen_image_21", "image_edit")
    graph = load_graph(target.json_path)
    config = load_workflow_config(target.config_path)

    prompt = build_prompt(graph, config, {"prompt": "make it night"}, reference_image="ref.png")

    assert prompt["1"]["inputs"]["image"] == "ref.png"
    assert prompt["6"]["inputs"]["images.image_1"] == ["1", 0]
    # 编辑的潜空间来自编码器第三输出
    assert prompt["7"]["inputs"]["latent_image"] == ["6", 2]


def test_unknown_binding_is_reported() -> None:
    graph = load_graph("workflows/qwen_image_21_turbo_t2i.json")
    broken = WorkflowConfig.model_validate(
        {"output_node": "13", "bindings": {"steps": {"node": "7", "input": "steps"}}}
    )

    with pytest.raises(Exception, match="落点|不存在"):
        build_prompt(graph, broken, {"steps": 8})


def test_build_prompt_does_not_mutate_source_graph() -> None:
    _model, target = _target("qwen_image_21_turbo", "text_to_image")
    graph = load_graph(target.json_path)
    original = graph["5"]["inputs"]["prompt"]
    config = load_workflow_config(target.config_path)

    build_prompt(graph, config, {"prompt": "changed"})

    assert graph["5"]["inputs"]["prompt"] == original


@pytest.mark.parametrize(
    ("statuses", "expected"),
    [
        ([TaskStatus.PENDING, TaskStatus.PENDING], GenerationStatus.PENDING),
        ([TaskStatus.QUEUED, TaskStatus.PENDING], GenerationStatus.QUEUED),
        ([TaskStatus.RUNNING, TaskStatus.PENDING], GenerationStatus.RUNNING),
        ([TaskStatus.COMPLETED, TaskStatus.RUNNING], GenerationStatus.RUNNING),
        ([TaskStatus.COMPLETED, TaskStatus.COMPLETED], GenerationStatus.COMPLETED),
        # 部分成功仍算 completed：已有的图不该因为另一半被取消/失败而作废
        ([TaskStatus.COMPLETED, TaskStatus.FAILED], GenerationStatus.COMPLETED),
        ([TaskStatus.COMPLETED, TaskStatus.CANCELLED], GenerationStatus.COMPLETED),
        ([TaskStatus.FAILED, TaskStatus.FAILED], GenerationStatus.FAILED),
        ([TaskStatus.FAILED, TaskStatus.CANCELLED], GenerationStatus.FAILED),
        ([TaskStatus.CANCELLED, TaskStatus.CANCELLED], GenerationStatus.CANCELLED),
    ],
)
def test_aggregate_generation_status(statuses: list[str], expected: str) -> None:
    assert aggregate_generation_status(statuses) == expected
