"""Smoke-test the local editor endpoints against a real image.

Usage: python tools/check_editor.py [image path]
"""

from __future__ import annotations

import io
import json
import sys
import urllib.request

BASE = "http://127.0.0.1:8000/api/v1"
BOUNDARY = "----miraforge"


def form(fields: dict[str, str], files: dict[str, tuple[str, bytes, str]]) -> bytes:
    out = io.BytesIO()
    for key, value in fields.items():
        out.write(
            f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
        )
    for key, (name, data, ctype) in files.items():
        out.write(
            f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="{key}"; filename="{name}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n".encode()
        )
        out.write(data)
        out.write(b"\r\n")
    out.write(f"--{BOUNDARY}--\r\n".encode())
    return out.getvalue()


def post(path: str, fields=None, files=None):
    body = form(fields or {}, files or {})
    request = urllib.request.Request(
        BASE + path,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={BOUNDARY}"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.status, response.headers, response.read()


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else r"D:\AI\MiraForge\data\case-ref1.png"
    content = open(path, "rb").read()
    name = path.rsplit("\\", 1)[-1]

    with urllib.request.urlopen(BASE + "/health", timeout=10) as response:
        print("health", response.status)

    status, _, body = post("/editor/analyze", {}, {"image": (name, content, "image/png")})
    info = json.loads(body)
    print("analyze", status, info)

    status, headers, cut = post(
        "/editor/remove-background",
        {"mode": "edge", "tolerance": str(info.get("suggested_tolerance", 16)), "feather": "1"},
        {"image": (name, content, "image/png")},
    )
    print(
        "remove-background",
        status,
        "ratio", headers.get("X-Removed-Ratio"),
        "bg", headers.get("X-Background-Color"),
        "bytes", len(cut),
    )
    open(r"D:\AI\MiraForge\data\editor-check-cut.png", "wb").write(cut)

    status, headers, trimmed = post("/editor/trim", {"padding": "0"}, {"image": ("cut.png", cut, "image/png")})
    print("trim", status, "box", headers.get("X-Content-Box"), "bytes", len(trimmed))
    open(r"D:\AI\MiraForge\data\editor-check-trim.png", "wb").write(trimmed)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
