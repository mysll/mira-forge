"""探针：把一份真实的图集 ZIP 通过 /api/v1/assets 存进资产库，并回读校验。

用法：backend/.venv/Scripts/python.exe tools/probe_asset_save.py
"""

from __future__ import annotations

import io
import json
import pathlib
import urllib.request
import uuid
import zipfile

API = "http://127.0.0.1:8000/api/v1"
DATA = pathlib.Path(__file__).resolve().parents[1] / "data"


def build_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for index, name in enumerate(["img27.png", "case-ref1.png"], start=1):
            archive.writestr(f"atlas_{index:02d}.png", (DATA / name).read_bytes())
        archive.writestr("atlas.json", b'{"atlas": {"name": "MiraForgeProbe"}, "pages": []}')
    return buffer.getvalue()


def post_asset(payload: bytes) -> dict:
    boundary = uuid.uuid4().hex
    parts: list[bytes] = []

    def field(name: str, value: str) -> None:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )

    field("name", "序列帧工坊 · 探针图集")
    parts.append(
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
            'filename="sprite_atlas_probe.zip"\r\nContent-Type: application/zip\r\n\r\n'
        ).encode()
        + payload
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())

    request = urllib.request.Request(
        f"{API}/assets",
        data=b"".join(parts),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def main() -> None:
    saved = post_asset(build_zip())
    print("saved:", json.dumps(saved, ensure_ascii=False))

    with urllib.request.urlopen(f"{API}/generations?media=asset&limit=5") as response:
        listing = json.load(response)
    print("asset batches:", listing["total"])
    first = listing["items"][0]
    print("newest:", first["generation_type"], first["prompt"], first["images"][0]["file_path"])

    with urllib.request.urlopen(f"{API}/images/{saved['image_id']}/file") as response:
        print("file:", response.status, response.headers["content-type"], len(response.read()))


if __name__ == "__main__":
    main()
