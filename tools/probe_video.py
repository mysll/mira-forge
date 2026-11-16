"""探针：用 MiniMax H3（fl2va + turbo LoRA）跑一次真实的文生视频，测量耗时与显存。

只做一次，产物留在 ComfyUI 的 output 里；不写 MiraForge 的库。
用法：.\\backend\\.venv\\Scripts\\python.exe tools\\probe_video.py [--length 124] [--steps 6] [--width 864] [--height 480]
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.request

BASE = "http://127.0.0.1:8188"


def post(path: str, payload: dict) -> dict:
    request = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        raw = response.read()
    return json.loads(raw) if raw else {}


def get(path: str) -> dict:
    with urllib.request.urlopen(BASE + path, timeout=60) as response:
        raw = response.read()
    return json.loads(raw) if raw else {}


def build_graph(*, prompt: str, width: int, height: int, length: int, steps: int, seed: int, prefix: str) -> dict:
    """节点表与官方模板 video_minimax_h3_i2v.json 的子图一致，只是把 switch 直接烧成「turbo 分支」。"""
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
        "2": {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {"model": ["1", 0], "lora_name": "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors", "strength_model": 1.0},
        },
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_int8_convrot.safetensors"}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "6": {
            "class_type": "MiniMaxH3ImageToVideo",
            "inputs": {"clip": ["3", 0], "vae": ["4", 0], "prompt": prompt, "width": width, "height": height, "length": length},
        },
        "7": {"class_type": "BasicGuider", "inputs": {"model": ["2", 0], "conditioning": ["6", 0]}},
        "8": {"class_type": "BasicScheduler", "inputs": {"model": ["2", 0], "scheduler": "simple", "steps": steps, "denoise": 1.0}},
        "9": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "10": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "11": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["10", 0], "guider": ["7", 0], "sampler": ["9", 0], "sigmas": ["8", 0], "latent_image": ["6", 1]}},
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["4", 0]}},
        "13": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["11", 0], "vae": ["5", 0]}},
        "14": {"class_type": "CreateVideo", "inputs": {"images": ["12", 0], "fps": 24.0, "audio": ["13", 0]}},
        "15": {"class_type": "SaveVideo", "inputs": {"video": ["14", 0], "filename_prefix": prefix, "format": "auto", "codec": "auto"}},
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--length", type=int, default=124)
    parser.add_argument("--steps", type=int, default=6)
    parser.add_argument("--width", type=int, default=864)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--seed", type=int, default=20261116)
    parser.add_argument("--prompt", default="A slow dolly-in on a glass teapot steaming on a rainy windowsill, warm backlight, shallow depth of field, 35mm film.")
    parser.add_argument("--prefix", default="miraforge/probe_video")
    args = parser.parse_args()

    print("卸载当前模型以腾出显存…", flush=True)
    post("/free", {"unload_models": True, "free_memory": True})
    time.sleep(3)
    stats = get("/system_stats")
    device = stats["devices"][0]
    print(f"起跑前 vram_free={device['vram_free'] / 1024**3:.2f}GB ram_free={stats['system']['ram_free'] / 1024**3:.2f}GB", flush=True)

    graph = build_graph(
        prompt=args.prompt,
        width=args.width,
        height=args.height,
        length=args.length,
        steps=args.steps,
        seed=args.seed,
        prefix=args.prefix,
    )
    started = time.time()
    queued = post("/prompt", {"prompt": graph, "client_id": "miraforge-probe-video"})
    prompt_id = queued["prompt_id"]
    print(f"已提交 prompt_id={prompt_id} ({args.width}x{args.height}, {args.length} 帧, {args.steps} 步)", flush=True)

    peak_used = 0
    while True:
        elapsed = time.time() - started
        history = get(f"/history/{prompt_id}")
        entry = history.get(prompt_id)
        if entry and entry.get("status", {}).get("completed"):
            status = entry["status"]
            print(f"完成：{elapsed:.1f}s status={status.get('status_str')}", flush=True)
            for node_id, output in entry.get("outputs", {}).items():
                print(f"  输出节点 {node_id}: {json.dumps(output, ensure_ascii=False)[:400]}", flush=True)
            break
        if elapsed > 1800:
            print("超时 30 分钟，放弃", flush=True)
            break
        if entry and entry.get("status", {}).get("status_str") == "error":
            print(f"失败：{json.dumps(entry['status'], ensure_ascii=False)[:800]}", flush=True)
            break
        device = get("/system_stats")["devices"][0]
        used = (device["vram_total"] - device["vram_free"]) / 1024**3
        peak_used = max(peak_used, used)
        if int(elapsed) % 15 == 0:
            print(f"  {elapsed:5.0f}s vram_used={used:.2f}GB", flush=True)
        time.sleep(3)
    print(f"峰值显存占用约 {peak_used:.2f}GB", flush=True)


if __name__ == "__main__":
    main()
