"""从 ComfyUI 的产物重建工作区（图片 + 提示词 + 参数）。

背景：2026-11-16 我验证「清空工作区」时误把真实工作区清掉了。ComfyUI 的输出目录里
每张图都带着完整的 API 图元数据（`prompt` 文本块），文件名又是 `g{generation}_t{task}`，
所以生成记录、提示词、seed、步数、CFG、模型、尺寸都能原样还原。

用法（先停掉后端，避免和运行中的连接抢锁）：
    .\\.venv\\Scripts\\python.exe tools\\restore_workspace.py [--source <ComfyUI 输出目录>] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import shutil
import struct
import sys
from datetime import UTC, datetime
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND))

from app.core.projects import active_project  # noqa: E402
from app.models.database import session_for  # noqa: E402
from app.models.generation import Generation  # noqa: E402
from app.models.image import Image  # noqa: E402
from app.models.task import GenerationTask  # noqa: E402
from app.models.workflow import Workflow  # noqa: E402
from app.services.image_service import ensure_thumbnail  # noqa: E402

DEFAULT_SOURCE = Path(r"D:\AI\ComfyUI_Portable\ComfyUI\output\miraforge")
# ComfyUI 的 SaveImage 会在前缀后接 `_00001_`，所以文件名形如 g15_t38_00001_.png
FILENAME = __import__("re").compile(r"^g(?P<generation>\d+)_t(?P<task>\d+)_(?P<index>\d+)_\.png$")


def png_size(data: bytes) -> tuple[int, int]:
    return struct.unpack(">II", data[16:24])


def png_prompt(data: bytes) -> dict | None:
    offset = 8
    while offset < len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        kind = data[offset + 4 : offset + 8].decode("latin-1")
        body = data[offset + 8 : offset + 8 + length]
        if kind in ("tEXt", "iTXt"):
            key, _, rest = body.partition(b"\x00")
            if key.decode("latin-1") == "prompt":
                try:
                    return json.loads(rest.decode("utf-8", "replace"))
                except json.JSONDecodeError:
                    return None
        offset += 12 + length
    return None


def node_of(graph: dict, class_type: str) -> dict | None:
    for node in graph.values():
        if node.get("class_type") == class_type:
            return node
    return None


def describe(graph: dict, size: tuple[int, int]) -> dict:
    """从 API 图里提炼出我们数据库需要的字段。"""
    encoder = node_of(graph, "TextEncodeQwenImage21") or {}
    prompt = str(encoder.get("inputs", {}).get("prompt", "")).strip()
    negative = str(encoder.get("inputs", {}).get("negative_prompt", "")).strip() or None

    unet = str(node_of(graph, "UNETLoader").get("inputs", {}).get("unet_name", "")) if node_of(graph, "UNETLoader") else ""
    model = "qwen_image_21_turbo" if "turbo" in unet else "qwen_image_21"

    sampler = node_of(graph, "KSampler")
    guider = node_of(graph, "CFGGuider")
    seed_node = node_of(graph, "RandomNoise")
    sampler_select = node_of(graph, "KSamplerSelect")

    seed = None
    if sampler:
        seed = sampler.get("inputs", {}).get("seed")
    if seed is None and seed_node:
        seed = seed_node.get("inputs", {}).get("noise_seed")

    steps = sampler.get("inputs", {}).get("steps") if sampler else None
    cfg = None
    if sampler:
        cfg = sampler.get("inputs", {}).get("cfg")
    elif guider:
        cfg = guider.get("inputs", {}).get("cfg")
    sampler_name = None
    if sampler:
        sampler_name = sampler.get("inputs", {}).get("sampler_name")
    elif sampler_select:
        sampler_name = sampler_select.get("inputs", {}).get("sampler_name")

    latent = node_of(graph, "EmptyLatentImage")
    if latent:
        width = int(latent["inputs"].get("width") or size[0])
        height = int(latent["inputs"].get("height") or size[1])
    else:
        width, height = size

    has_reference = node_of(graph, "LoadImage") is not None
    if not has_reference:
        generation_type = "text_to_image"
    else:
        # 编辑：潜空间来自编码器第 3 个输出；图生图：潜空间来自 EmptyLatentImage
        generation_type = "image_to_image" if latent else "image_edit"

    return {
        "prompt": prompt,
        "negative": negative,
        "model": model,
        "seed": int(seed) if seed is not None else None,
        "steps": int(steps) if steps is not None else None,
        "cfg": float(cfg) if cfg is not None else None,
        "sampler": str(sampler_name) if sampler_name else None,
        "width": width,
        "height": height,
        "generation_type": generation_type,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=str(DEFAULT_SOURCE))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    source = Path(args.source)
    if not source.is_dir():
        print(f"找不到 ComfyUI 输出目录：{source}")
        return 1

    # 同一个任务可能有多个产出（00001_ / 00002_），只取第一个，和当时入库的行为一致
    files: dict[tuple[int, int], Path] = {}
    for path in sorted(source.glob("*.png")):
        match = FILENAME.match(path.name)
        if not match:
            continue
        key = (int(match["generation"]), int(match["task"]))
        files.setdefault(key, path)

    if not files:
        print("没有找到符合 g{id}_t{id}_{index}.png 的产物")
        return 1

    project = active_project()
    session = session_for(project)
    workflows = {(row.name, row.type): row.id for row in session.query(Workflow).all()}
    labels = {"qwen_image_21": "Qwen Image 2.1", "qwen_image_21_turbo": "Qwen Image 2.1 Turbo"}

    restored_generations = 0
    restored_images = 0
    skipped = 0

    by_generation: dict[int, list[tuple[int, Path]]] = {}
    for (generation_id, task_id), path in files.items():
        by_generation.setdefault(generation_id, []).append((task_id, path))

    for generation_id in sorted(by_generation):
        entries = sorted(by_generation[generation_id])
        first_path = entries[0][1]
        first_data = first_path.read_bytes()
        graph = png_prompt(first_data)
        if not graph:
            print(f"跳过 g{generation_id}：图片里没有 prompt 元数据")
            skipped += len(entries)
            continue
        info = describe(graph, png_size(first_data))

        if session.get(Generation, generation_id) is not None:
            print(f"跳过 g{generation_id}：数据库里已经有这个批次")
            skipped += len(entries)
            continue

        completed_at = datetime.fromtimestamp(first_path.stat().st_mtime, UTC).replace(tzinfo=None)
        generation = Generation(
            id=generation_id,
            prompt=info["prompt"],
            negative_prompt=info["negative"],
            workflow_id=workflows.get((labels[info["model"]], info["generation_type"])),
            generation_type=info["generation_type"],
            model_name=info["model"],
            width=info["width"],
            height=info["height"],
            requested_count=len(entries),
            status="completed",
            steps=info["steps"],
            cfg=info["cfg"],
            sampler=info["sampler"],
            created_at=completed_at,
            completed_at=completed_at,
        )
        session.add(generation)
        session.flush()
        restored_generations += 1

        for task_id, path in entries:
            data = path.read_bytes()
            graph_for_task = png_prompt(data) or graph
            task_info = describe(graph_for_task, png_size(data))
            task = GenerationTask(
                id=task_id,
                generation_id=generation_id,
                seed=task_info["seed"],
                status="completed",
                progress=100,
                started_at=completed_at,
                completed_at=completed_at,
            )
            session.add(task)
            session.flush()

            relative = Path(f"images/{generation_id}/{task_id}_0.png")
            target = project.storage_path / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                shutil.copyfile(path, target)

            image = Image(
                task_id=task_id,
                generation_id=generation_id,
                file_path=relative.as_posix(),
                width=task_info["width"],
                height=task_info["height"],
                file_size=len(data),
                created_at=completed_at,
            )
            session.add(image)
            session.flush()
            ensure_thumbnail(session, image)
            restored_images += 1

    if args.dry_run:
        session.rollback()
    else:
        session.commit()
    session.close()

    print(f"项目：{project.name}（{project.path}）")
    print(f"恢复批次 {restored_generations} 个、图片 {restored_images} 张、跳过 {skipped} 张")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
