"""验证「图片编辑支持 2 张参考图」端到端：临时项目里跑，跑完删项目。"""

from __future__ import annotations

import json
import time
from pathlib import Path

import httpx

BASE = "http://127.0.0.1:8000/api/v1"
ROOT = Path(__file__).resolve().parents[1]
CHAR = ROOT / "data/case-ref1.png"
CLOTHES = ROOT / "data/case-ref2.png"
OUT = ROOT / "data"

PROMPT = "把第一张图里角色的服装换成第二张图的服装样式，保持脸部、发型、姿势、背景和构图完全不变"


def files() -> list[tuple[str, tuple[str, bytes, str]]]:
    return [
        ("images", ("char.png", CHAR.read_bytes(), "image/png")),
        ("images", ("clothes.png", CLOTHES.read_bytes(), "image/png")),
    ]


client = httpx.Client(base_url=BASE, timeout=120, trust_env=False)

created = client.post("/projects", json={"name": "双图编辑验证", "activate": True})
created.raise_for_status()
project = created.json()
print(json.dumps({"project": project["id"], "active": project["is_active"]}, ensure_ascii=False))

try:
    data = {
        "prompt": PROMPT,
        "model": "qwen_image_21_turbo",
        "count": "1",
        "width": "1024",
        "height": "1024",
    }
    response = client.post("/generations/edit", data=data, files=files())
    print("POST /generations/edit", response.status_code)
    if response.status_code != 201:
        print(response.text[:600])
        raise SystemExit(1)
    body = response.json()
    print(
        json.dumps(
            {
                "generation": body["id"],
                "type": body["generation_type"],
                "refs": body["reference_images"],
                "size": [body["width"], body["height"]],
            },
            ensure_ascii=False,
        )
    )

    started = time.time()
    for _ in range(120):
        time.sleep(2)
        detail = client.get(f"/generations/{body['id']}").json()
        if detail["status"] in ("completed", "failed"):
            print(f"{detail['status']} in {time.time() - started:.1f}s")
            for task in detail["tasks"]:
                print("  task", task["id"], task["status"], task["error_message"])
            for image in detail["images"]:
                data_bytes = client.get(f"/images/{image['id']}/file").content
                target = OUT / f"edit2-{image['id']}.png"
                target.write_bytes(data_bytes)
                print("  image", image["id"], image["width"], image["height"], len(data_bytes), "->", target.name)
            break
    else:
        print("timeout")
finally:
    deleted = client.delete(f"/projects/{project['id']}")
    print("cleanup", deleted.status_code, deleted.json().get("active"))
    client.close()
