"""验证「换衣服」走编辑链路（latent 取编码器输出）是否可行。

对照三种做法：
  B 编辑 1 张（图1 + 文字描述服装）
  C 编辑 2 张（图1 结构 + 图2 服装）
  D 编辑 2 张，但 latent 用空 latent（等价于现在的参考图生成，用于确认差异来自潜空间）
"""

from __future__ import annotations

import copy
import json
import time
from pathlib import Path

import httpx

COMFY = "http://127.0.0.1:8188"
ROOT = Path(__file__).resolve().parents[1]
GRAPH = json.loads((ROOT / "backend/workflows/qwen_image_21_turbo_edit.json").read_text(encoding="utf-8"))
REF_CHAR = ROOT / "data/case-ref1.png"
REF_CLOTHES = ROOT / "data/case-ref2.png"
OUT = ROOT / "data"

PROMPT_TEXT = "把角色的服装换成深色皮甲配紫色披风，保持脸部、发型、姿势、背景和构图完全不变"
PROMPT_TWO = "把第一张图里角色的服装换成第二张图的服装样式，保持角色的脸、发型、姿势、背景和构图完全不变"


def upload(client: httpx.Client, path: Path) -> str:
    response = client.post(
        f"{COMFY}/upload/image",
        files={"image": (path.name, path.read_bytes(), "image/png")},
        data={"type": "input", "overwrite": "true"},
    )
    response.raise_for_status()
    body = response.json()
    return body["name"] if not body.get("subfolder") else f"{body['subfolder']}/{body['name']}"


def run(client: httpx.Client, label: str, graph: dict, seed: int) -> None:
    started = time.time()
    response = client.post(f"{COMFY}/prompt", json={"prompt": graph, "client_id": f"probe-{label}"})
    if response.status_code != 200:
        print(f"[{label}] rejected {response.status_code}: {response.text[:400]}")
        return
    prompt_id = response.json()["prompt_id"]
    for _ in range(180):
        time.sleep(1)
        history = client.get(f"{COMFY}/history/{prompt_id}").json()
        entry = history.get(prompt_id)
        if entry and entry.get("status", {}).get("completed"):
            elapsed = time.time() - started
            images = entry["outputs"]["13"]["images"]
            for item in images:
                params = {"filename": item["filename"], "type": "output", "subfolder": item.get("subfolder", "")}
                data = client.get(f"{COMFY}/view", params=params).content
                target = OUT / f"clothes-{label}.png"
                target.write_bytes(data)
                print(f"[{label}] {elapsed:.1f}s -> {target.name} {len(data)} bytes seed={seed}")
            return
    print(f"[{label}] timeout")


def node(graph: dict, node_id: str) -> dict:
    for key, value in graph.items():
        if key == node_id:
            return value
    raise KeyError(node_id)


client = httpx.Client(trust_env=False, timeout=120)
char_name = upload(client, REF_CHAR)
clothes_name = upload(client, REF_CLOTHES)
print(json.dumps({"char": char_name, "clothes": clothes_name}, ensure_ascii=False))

# B：1 张参考图 + 文字描述服装
graph_b = copy.deepcopy(GRAPH)
node(graph_b, "1")["inputs"]["image"] = char_name
node(graph_b, "6")["inputs"]["prompt"] = PROMPT_TEXT
node(graph_b, "7")["inputs"]["noise_seed"] = 5150
run(client, "b-edit-text", graph_b, 5150)

# C：2 张参考图（图1 结构 + 图2 服装），latent 仍取编码器输出
graph_c = copy.deepcopy(GRAPH)
graph_c["20"] = {"class_type": "LoadImage", "inputs": {"image": clothes_name}}
node(graph_c, "1")["inputs"]["image"] = char_name
inputs_c = node(graph_c, "6")["inputs"]
inputs_c["prompt"] = PROMPT_TWO
inputs_c["images.image_2"] = ["20", 0]
node(graph_c, "7")["inputs"]["noise_seed"] = 5150
run(client, "c-edit-two", graph_c, 5150)

# D：同 C，但把 latent 换成空 latent（模拟「参考图生成」的潜空间）
graph_d = copy.deepcopy(graph_c)
graph_d["30"] = {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}}
node(graph_d, "11")["inputs"]["latent_image"] = ["30", 0]
node(graph_d, "7")["inputs"]["noise_seed"] = 5150
run(client, "d-empty-latent", graph_d, 5150)

client.close()
