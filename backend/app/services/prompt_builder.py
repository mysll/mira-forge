"""把 MiraForge 的参数注入 ComfyUI API 图。

图本身是完整可执行的 JSON；本模块只做两件事：按配置改输入、接上参考图。
所有落点都会校验存在性，写错了直接报错而不是悄悄生成一张错的图。
"""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Sequence
from typing import Any

from app.services.workflow_config import WorkflowConfig, WorkflowConfigError, resolve_workflow_path

# 编码器的 AUTOGROW 输入名以序号结尾（images.image_1 → images.image_2 …）
_INDEX_SUFFIX = re.compile(r"^(?P<prefix>.*?)(?P<index>\d+)$")


class PromptBuildError(ValueError):
    pass


def load_graph(relative: str) -> dict[str, Any]:
    path = resolve_workflow_path(relative)
    if not path.is_file():
        raise PromptBuildError(f"工作流 JSON 不存在：{relative}")
    try:
        graph = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PromptBuildError(f"工作流 JSON 不是合法 JSON：{relative}（{exc}）") from exc
    if not isinstance(graph, dict) or not graph:
        raise PromptBuildError(f"工作流 JSON 不是节点字典：{relative}")
    return graph


def _node(graph: dict[str, Any], node_id: str, where: str) -> dict[str, Any]:
    node = graph.get(node_id)
    if not isinstance(node, dict) or "class_type" not in node:
        raise PromptBuildError(f"{where} 指向的节点 {node_id} 不存在")
    return node


def _indexed_key(base: str, offset: int) -> str:
    """images.image_1 加 offset 得到 images.image_2；没有序号就不支持多图。"""
    if offset == 0:
        return base
    match = _INDEX_SUFFIX.match(base)
    if match is None:
        raise WorkflowConfigError(
            f"参考图输入名 {base} 没有序号，无法接入第 {offset + 1} 张参考图"
        )
    return f"{match.group('prefix')}{int(match.group('index')) + offset}"


def _detach(graph: dict[str, Any], node_id: str) -> None:
    """移除没用到的参考图节点，并断开别人对它的引用。"""
    graph.pop(node_id, None)
    for node in graph.values():
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for name, value in list(inputs.items()):
            if isinstance(value, list) and len(value) == 2 and value[0] == node_id:
                inputs.pop(name, None)


def build_prompt(
    graph: dict[str, Any],
    config: WorkflowConfig,
    params: dict[str, Any],
    reference_images: Sequence[str] | None = None,
) -> dict[str, Any]:
    """返回可直接 POST /prompt 的图（不改动传入的 graph）。"""
    prompt = copy.deepcopy(graph)

    for name, binding in config.bindings.items():
        if name not in params:
            continue
        value = params[name]
        if value is None:
            continue
        node = _node(prompt, binding.node, f"参数 {name}")
        inputs = node.setdefault("inputs", {})
        if binding.input not in inputs:
            raise WorkflowConfigError(
                f"参数 {name} 的落点 {binding.node}.{binding.input} 在工作中不存在"
                "（该类节点的输入为：" + ", ".join(sorted(inputs)) + "）"
            )
        inputs[binding.input] = value

    if config.reference_image is not None:
        _attach_references(prompt, config, list(reference_images or []))

    return prompt


def _attach_references(
    prompt: dict[str, Any], config: WorkflowConfig, images: list[str]
) -> None:
    binding = config.reference_image
    assert binding is not None
    slots = binding.slots()
    if not slots:
        raise WorkflowConfigError("参考图配置没有声明 LoadImage 节点")

    if not images:
        raise PromptBuildError("该工作流需要参考图，但本次任务没有提供")
    if len(images) > len(slots):
        raise PromptBuildError(
            f"该工作流最多支持 {len(slots)} 张参考图，收到 {len(images)} 张"
        )

    encoder = _node(prompt, binding.encoder_node, "参考图编码节点")
    encoder_inputs = encoder.setdefault("inputs", {})

    for offset, slot in enumerate(slots):
        key = _indexed_key(binding.encoder_input, offset)
        if offset >= len(images):
            # 没有第 n 张图：键和节点都摘掉，免得 ComfyUI 去找不存在的文件
            encoder_inputs.pop(key, None)
            _detach(prompt, slot.node)
            continue
        if key not in encoder_inputs:
            raise WorkflowConfigError(
                f"参考图编码节点 {binding.encoder_node} 没有输入 {key}"
                "（可用：" + ", ".join(sorted(encoder_inputs)) + "）"
            )
        loader = _node(prompt, slot.node, f"第 {offset + 1} 张参考图的节点")
        loader.setdefault("inputs", {})[slot.input] = images[offset]
        encoder_inputs[key] = [slot.node, 0]


def output_node_id(config: WorkflowConfig) -> str:
    return config.output_node
