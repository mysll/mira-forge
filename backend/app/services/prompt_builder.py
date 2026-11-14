"""把 MiraForge 的参数注入 ComfyUI API 图。

图本身是完整可执行的 JSON；本模块只做两件事：按配置改输入、接上参考图。
所有落点都会校验存在性，写错了直接报错而不是悄悄生成一张错的图。
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from app.services.workflow_config import WorkflowConfig, WorkflowConfigError, resolve_workflow_path


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


def build_prompt(
    graph: dict[str, Any],
    config: WorkflowConfig,
    params: dict[str, Any],
    reference_image: str | None = None,
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
        _node(prompt, config.output_node, "输出节点")
        loader = _node(prompt, config.reference_image.loader_node, "参考图节点")
        if reference_image is None:
            raise PromptBuildError("该工作流需要参考图，但本次任务没有提供")
        loader.setdefault("inputs", {})[config.reference_image.loader_input] = reference_image
        encoder = _node(prompt, config.reference_image.encoder_node, "参考图编码节点")
        encoder.setdefault("inputs", {})[config.reference_image.encoder_input] = [
            config.reference_image.loader_node,
            0,
        ]

    return prompt


def output_node_id(config: WorkflowConfig) -> str:
    return config.output_node
