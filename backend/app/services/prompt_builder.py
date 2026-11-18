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
    frames: dict[str, str] | None = None,
    mask_image: str | None = None,
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

    if config.frames is not None:
        _attach_frames(prompt, config, frames or {})

    if config.mask is not None:
        _attach_mask(prompt, config, mask_image)
    elif mask_image is not None:
        raise PromptBuildError("该工作流没有配置遮罩落点，收到遮罩却无处可写")

    return prompt


def _attach_mask(
    prompt: dict[str, Any], config: WorkflowConfig, mask_image: str | None
) -> None:
    """遮罩只写进自己的 LoadImage；没给遮罩就报错，绝不悄悄按整图重绘。"""
    binding = config.mask
    assert binding is not None
    if not mask_image:
        raise PromptBuildError("局部编辑需要遮罩，但本次任务没有提供")
    loader = _node(prompt, binding.node, "遮罩节点")
    inputs = loader.setdefault("inputs", {})
    if binding.input not in inputs:
        raise WorkflowConfigError(
            f"遮罩节点 {binding.node} 没有输入 {binding.input}"
            "（可用：" + ", ".join(sorted(inputs)) + "）"
        )
    inputs[binding.input] = mask_image


def _attach_frames(
    prompt: dict[str, Any], config: WorkflowConfig, frames: dict[str, str]
) -> None:
    """视频的首帧 / 尾帧：给了就接上，没给就把那个 LoadImage 摘掉。

    与参考图不同，这里允许两张都不给（纯文生视频），所以不抛"缺少参考图"。
    """
    binding = config.frames
    assert binding is not None
    node = _node(prompt, binding.node, "首尾帧节点")
    inputs = node.setdefault("inputs", {})

    for which in ("first", "last"):
        image = frames.get(which)
        loader_id = binding.loader_for(which)
        input_name = binding.input_for(which)
        if image is None:
            # 没给这一帧：断开并摘掉对应的 LoadImage，免得 ComfyUI 去读占位图
            inputs.pop(input_name, None)
            if loader_id is not None:
                _detach(prompt, loader_id)
            continue
        if loader_id is None:
            raise WorkflowConfigError(f"工作流没有配置{'首' if which == 'first' else '尾'}帧的 LoadImage 节点")
        if input_name not in inputs:
            raise WorkflowConfigError(
                f"首尾帧节点 {binding.node} 没有输入 {input_name}"
                "（可用：" + ", ".join(sorted(inputs)) + "）"
            )
        loader = _node(prompt, loader_id, f"{'首' if which == 'first' else '尾'}帧节点")
        loader.setdefault("inputs", {})["image"] = image
        inputs[input_name] = [loader_id, 0]


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
