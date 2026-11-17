"""复现用户那次「换衣服」：同 pipeline、同 prompt、同两张参考图，再做一次改写的对照。"""

from __future__ import annotations

import copy
import json
import time
from pathlib import Path

import httpx

COMFY = "http://127.0.0.1:8188"
ROOT = Path(__file__).resolve().parents[1]
GRAPH = json.loads((ROOT / "backend/workflows/qwen_image_21_turbo_i2i.json").read_text(encoding="utf-8"))
REF_CHAR = ROOT / "data/case-ref1.png"
REF_CLOTHES = ROOT / "data/case-ref2.png"
OUT = ROOT / "data"

PROMPT_USER = "将右视图的角色衣服替换成第二张图的衣服"
PROMPT_FIXED = "把第一张图里角色的服装换成第二张图的服装样式，保持角色的脸、发型、姿势、背景和构图完全不变"


def upload(client: httpx.Client, path: Path) -> str:
    response = client.post(
        f"{COMFY}/upload/image",
        files={"image": (path.name, path.read_bytes(), "image/png")},
        data={"type": "input", "overwrite": "true"},
    )
    response.raise_for_status()
    body = response.json()
    return body["name"] if not body.get("subfolder") else f"{body['subfolder']}/{body['name']}"


def run(client: httpx.Client, label: str, graph: dict) -> None:
    started = time.time()
    response = client.post(f"{COMFY}/prompt", json={"prompt": graph, "client_id": f"probe-{label}"})
    if response.status_code != 200:
        print(f"[{label}] rejected {response.status_code}: {response.text[:400]}")
        return
    prompt_id = response.json()["prompt_id"]
    for _ in range(180):
        time.sleep(1)
        entry = client.get(f"{COMFY}/history/{prompt_id}").json().get(prompt_id)
        if entry and entry.get("status", {}).get("completed"):
            elapsed = time.time() - started
            for item in entry["outputs"]["13"]["images"]:
                params = {"filename": item["filename"], "type": "output", "subfolder": item.get("subfolder", "")}
                data = client.get(f"{COMFY}/view", params=params).content
                target = OUT / f"clothes-{label}.png"
                target.write_bytes(data)
                print(f"[{label}] {elapsed:.1f}s -> {target.name} {len(data)} bytes")
            return
    print(f"[{label}] timeout")


client = httpx.Client(trust_env=False, timeout=120)
char_name = upload(client, REF_CHAR)
clothes_name = upload(client, REF_CLOTHES)
print(json.dumps({"char": char_name, "clothes": clothes_name}, ensure_ascii=False))

for label, prompt in (("e-user-prompt", PROMPT_USER), ("f-fixed-prompt", PROMPT_FIXED)):
    graph = copy.deepcopy(GRAPH)
    graph["20"] = {"class_type": "LoadImage", "inputs": {"image": char_name}}
    graph["21"] = {"class_type": "LoadImage", "inputs": {"image": clothes_name}}
    inputs = graph["5"]["inputs"]
    inputs["prompt"] = prompt
    inputs["images.image_1"] = ["20", 0]
    inputs["images.image_2"] = ["21", 0]
    inputs["resolution"] = 1024
    graph["6"]["inputs"]["width"] = 1024
    graph["6"]["inputs"]["height"] = 1024
    graph["7"]["inputs"]["noise_seed"] = 20261116
    run(client, label, graph)

client.close()
