"""负面提示词与 CFG 的真实行为验证。

问题：默认 CFG=1 时，负面提示词理论上不参与采样（CFG 公式里 uncond 项被消掉）。
用同一 seed、同一提示词、只改负面提示词，看产物是否逐字节相同：
- cfg=1.0：相同 → 负面提示词被完全忽略；
- cfg=3.0：不同 → 负面提示词生效。
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import httpx

BASE = "http://127.0.0.1:8000/api/v1"
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data"

PROMPT = "a red poppy flower on a white studio table, soft window light, 50mm photo"
NEGATIVE = "red, crimson, orange"
SEED = 777777


def run(label: str, model: str, cfg: float | None, negative: str, steps: int | None = None) -> dict:
    payload: dict = {
        "prompt": PROMPT,
        "model": model,
        "generation_type": "text_to_image",
        "count": 1,
        "width": 1024,
        "height": 1024,
        "seed": SEED,
    }
    if cfg is not None:
        payload["cfg"] = cfg
    if negative:
        payload["negative_prompt"] = negative
    if steps is not None:
        payload["steps"] = steps

    response = httpx.post(f"{BASE}/generations", json=payload, timeout=60)
    if response.status_code != 201:
        print(f"[{label}] POST {response.status_code} {response.text[:300]}")
        return {}
    generation_id = response.json()["id"]

    started = time.time()
    for _ in range(180):
        time.sleep(2)
        generation = httpx.get(f"{BASE}/generations/{generation_id}", timeout=30).json()
        if generation["status"] in ("completed", "failed"):
            elapsed = time.time() - started
            image = generation["images"][0] if generation["images"] else None
            record = {
                "label": label,
                "gen": generation_id,
                "status": generation["status"],
                "cfg": generation["cfg"],
                "negative": generation["negative_prompt"],
                "seconds": round(elapsed, 1),
                "image": image["id"] if image else None,
            }
            if image:
                detail = httpx.get(f"{BASE}/images/{image['id']}", timeout=30).json()
                path = ROOT / "storage" / detail["file_path"]
                digest = hashlib.sha256(path.read_bytes()).hexdigest()[:16]
                record["sha"] = digest
                copy = OUT / f"neg-{label}.png"
                copy.write_bytes(path.read_bytes())
            print(json.dumps(record, ensure_ascii=False))
            return record
    print(f"[{label}] timeout")
    return {}


runs = [
    run("std-cfg1-negA", "qwen_image_21", 1.0, ""),
    run("std-cfg1-negB", "qwen_image_21", 1.0, NEGATIVE),
    run("std-cfg3-negA", "qwen_image_21", 3.0, ""),
    run("std-cfg3-negB", "qwen_image_21", 3.0, NEGATIVE),
    run("turbo-cfg1-negB", "qwen_image_21_turbo", 1.0, NEGATIVE),
    run("turbo-cfg2.5-negB", "qwen_image_21_turbo", 2.5, NEGATIVE),
]

print("\n=== 结论 ===")
by = {record["label"]: record for record in runs if record}
for pair in (("std-cfg1-negA", "std-cfg1-negB"), ("std-cfg3-negA", "std-cfg3-negB")):
    left, right = by.get(pair[0], {}), by.get(pair[1], {})
    if left.get("sha") and right.get("sha"):
        same = left["sha"] == right["sha"]
        print(f"{pair[0]} vs {pair[1]}: {'完全相同' if same else '不同'} ({left['sha']} / {right['sha']})")
