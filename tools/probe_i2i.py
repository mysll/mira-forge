"""图生图真实出图验证：1 张参考图、2 张参考图各跑一次。"""

from __future__ import annotations

import json
import time
from pathlib import Path

import httpx

BASE = "http://127.0.0.1:8000/api/v1"
ROOT = Path(__file__).resolve().parents[1]

REF_A = ROOT / "storage/images/22/52_0.png"
REF_B = ROOT / "storage/images/21/48_0.png"


def run(label: str, refs: list[Path], prompt: str) -> None:
    files = [("images", (f"ref{i}.png", p.read_bytes(), "image/png")) for i, p in enumerate(refs)]
    data = {
        "prompt": prompt,
        "model": "qwen_image_21_turbo",
        "count": "1",
        "width": "1024",
        "height": "1024",
    }
    response = httpx.post(f"{BASE}/generations/image-to-image", data=data, files=files, timeout=60)
    print(f"[{label}] POST {response.status_code}")
    if response.status_code != 201:
        print(response.text[:600])
        return
    body = response.json()
    generation_id = body["id"]
    print(
        f"[{label}] gen={generation_id} type={body['generation_type']} "
        f"size={body['width']}x{body['height']} refs={body['reference_images']}"
    )
    started = time.time()
    for _ in range(150):
        time.sleep(2)
        generation = httpx.get(f"{BASE}/generations/{generation_id}", timeout=30).json()
        if generation["status"] in ("completed", "failed"):
            elapsed = time.time() - started
            print(f"[{label}] {generation['status']} in {elapsed:.1f}s")
            for task in generation["tasks"]:
                print("   ", task["id"], task["status"], task["progress"], task["error_message"])
            print("    images:", [(i["id"], i["width"], i["height"], i["file_size"]) for i in generation["images"]])
            return
    print(f"[{label}] timeout")


print(json.dumps({"ref_a": REF_A.name, "ref_b": REF_B.name}))
run("1-ref", [REF_A], "the same scene, but in autumn with orange maple leaves and warm evening light")
run(
    "2-ref",
    [REF_A, REF_B],
    "blend the composition of both reference images into one quiet courtyard scene",
)
