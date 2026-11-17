"""本地图片编辑器的图像处理。

这里**不调用 ComfyUI**：全部是确定性的 CPU 像素运算（numpy + Pillow + scipy），
用来做抠底、裁边这类机械活。生成式编辑仍然走 ComfyUI 的图片编辑接口，
两者在界面上是分开的两个入口。
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

from app.services.image_service import detect_image_extension

MAX_EDITOR_BYTES = 40 * 1024 * 1024
"""编辑器接受的单张图片上限；比生成侧的 20 MB 宽一点，PNG 截图常常更大。"""


class EditorError(ValueError):
    """输入不是可编辑的图片，或者参数不合理。"""


@dataclass(frozen=True)
class RemovalResult:
    png: bytes
    background: tuple[int, int, int]
    removed_ratio: float
    width: int
    height: int


@dataclass(frozen=True)
class TrimResult:
    png: bytes
    box: tuple[int, int, int, int]
    width: int
    height: int


def load_image(content: bytes) -> Image.Image:
    """按魔数确认是 PNG / JPEG / WEBP，再解成 RGBA。"""
    if not content:
        raise EditorError("图片是空的")
    if len(content) > MAX_EDITOR_BYTES:
        raise EditorError(f"图片不能超过 {MAX_EDITOR_BYTES // (1024 * 1024)} MB")
    if detect_image_extension(content) is None:
        raise EditorError("只支持 PNG / JPEG / WEBP 图片")
    try:
        image = Image.open(io.BytesIO(content))
        image.load()
    except Exception as exc:  # Pillow 的异常类型很杂，统一转成 422
        raise EditorError(f"图片解析失败：{exc}") from exc
    return image.convert("RGBA")


def _border_pixels(rgb: np.ndarray, ring: int = 0) -> np.ndarray:
    """取最外一圈（可内缩 ring 像素）的像素，用来估计背景色。"""
    height, width = rgb.shape[:2]
    ring = max(0, min(ring, min(height, width) // 4 - 1))
    rows = [ring, height - 1 - ring]
    cols = [ring, width - 1 - ring]
    parts = [rgb[rows[0], ring : width - ring], rgb[rows[1], ring : width - ring]]
    parts.append(rgb[ring:height - ring, cols[0]])
    parts.append(rgb[ring:height - ring, cols[1]])
    return np.concatenate([part.reshape(-1, 3) for part in parts], axis=0)


def dominant_background(rgb: np.ndarray) -> tuple[int, int, int]:
    """取边框像素的中位数当背景色；中位数比众数稳，能吃掉少量边缘杂色。"""
    sample = _border_pixels(rgb)
    if sample.size == 0:
        return (255, 255, 255)
    median = np.median(sample, axis=0)
    return tuple(int(round(value)) for value in median)  # type: ignore[return-value]


def _color_distance(rgb: np.ndarray, color: tuple[int, int, int], channel: str) -> np.ndarray:
    diff = np.abs(rgb.astype(np.int16) - np.array(color, dtype=np.int16))
    if channel == "max":
        return diff.max(axis=2).astype(np.uint8)
    if channel == "mean":
        return diff.mean(axis=2).astype(np.uint8)
    # 感知近似：绿色权重最高，蓝色最低
    weighted = diff[..., 0] * 0.3 + diff[..., 1] * 0.59 + diff[..., 2] * 0.11
    return np.clip(weighted, 0, 255).astype(np.uint8)


def _edge_connected(mask: np.ndarray) -> np.ndarray:
    """只保留与画布边缘相连的 mask 区域（避免把主体内部的同色像素也删掉）。"""
    if not mask.any():
        return mask
    labels, _ = ndimage.label(mask)
    border = np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]])
    keep = np.unique(border[border > 0])
    return np.isin(labels, keep)


def remove_background(
    image: Image.Image,
    *,
    mode: str = "edge",
    tolerance: int = 22,
    feather: int = 1,
    denoise: int = 0,
    color: tuple[int, int, int] | None = None,
    channel: str = "max",
) -> RemovalResult:
    """把背景抠成透明。

    mode="edge"：只删与边缘连通的背景色区域（推荐，主体内部同色部分会保留）。
    mode="color"：删掉画面上所有接近背景色的像素（纯色图标、贴纸更快）。
    """
    if mode not in ("edge", "color"):
        raise EditorError(f"mode 只能是 edge 或 color，收到 {mode!r}")
    if channel not in ("max", "mean", "luma"):
        raise EditorError(f"channel 只能是 max / mean / luma，收到 {channel!r}")
    if not 0 <= tolerance <= 255:
        raise EditorError("tolerance 需要在 0–255 之间")
    if not 0 <= feather <= 12:
        raise EditorError("feather 需要在 0–12 之间")
    if not 0 <= denoise <= 10:
        raise EditorError("denoise 需要在 0–10 之间")

    rgba = np.asarray(image, dtype=np.uint8)
    rgb = rgba[..., :3]
    background = color if color is not None else dominant_background(rgb)

    distance = _color_distance(rgb, background, channel)
    candidate = distance <= tolerance
    region = _edge_connected(candidate) if mode == "edge" else candidate

    keep = ~region
    if denoise:
        # 去杂点：填掉主体内部的小孔（噪点），丢掉背景里的小碎块；大面积的封闭背景（如腋下）不动
        min_area = max(8, int(denoise) * 40)
        holes = ndimage.label(~keep)[0]
        for index in range(1, int(holes.max()) + 1):
            spot = holes == index
            if spot[0, :].any() or spot[-1, :].any() or spot[:, 0].any() or spot[:, -1].any():
                continue  # 碰到画布边的是外部背景，不填
            if spot.sum() < min_area:
                keep |= spot
        islands = ndimage.label(keep)[0]
        for index in range(1, int(islands.max()) + 1):
            spot = islands == index
            if spot.sum() < min_area:
                keep &= ~spot
    alpha = np.where(keep, 255, 0).astype(np.uint8)
    # 原图本来有透明区域的地方保持透明
    alpha = np.minimum(alpha, rgba[..., 3])

    if feather:
        alpha_image = Image.fromarray(alpha, mode="L").filter(ImageFilter.GaussianBlur(radius=feather))
        alpha = np.asarray(alpha_image, dtype=np.uint8)

    output = np.dstack([rgb, alpha])
    buffer = io.BytesIO()
    Image.fromarray(output, mode="RGBA").save(buffer, format="PNG", optimize=True)
    return RemovalResult(
        png=buffer.getvalue(),
        background=background,
        removed_ratio=float(1.0 - keep.mean()),
        width=image.width,
        height=image.height,
    )


def trim_transparent(image: Image.Image, *, padding: int = 0) -> TrimResult:
    """裁掉透明边，返回新图与 bbox。整张都不透明时原样返回。"""
    if not 0 <= padding <= 512:
        raise EditorError("padding 需要在 0–512 之间")
    alpha = np.asarray(image, dtype=np.uint8)[..., 3]
    rows = np.flatnonzero(alpha.max(axis=1) > 0)
    cols = np.flatnonzero(alpha.max(axis=0) > 0)
    if rows.size == 0 or cols.size == 0:
        # 全透明：没什么可裁的，也不该报错
        box = (0, 0, image.width, image.height)
    else:
        left, right = int(cols[0]), int(cols[-1]) + 1
        top, bottom = int(rows[0]), int(rows[-1]) + 1
        if padding:
            left = max(0, left - padding)
            top = max(0, top - padding)
            right = min(image.width, right + padding)
            bottom = min(image.height, bottom + padding)
        box = (left, top, right, bottom)

    cropped = image.crop(box) if box != (0, 0, image.width, image.height) else image
    buffer = io.BytesIO()
    cropped.save(buffer, format="PNG", optimize=True)
    return TrimResult(png=buffer.getvalue(), box=box, width=cropped.width, height=cropped.height)


def describe(image: Image.Image) -> dict[str, object]:
    """给编辑器启动时用：尺寸、背景色估计、是否已带透明。"""
    rgba = np.asarray(image, dtype=np.uint8)
    rgb = rgba[..., :3]
    alpha = rgba[..., 3]
    background = dominant_background(rgb)
    distance = _color_distance(rgb, background, "max")
    sampled = distance[::4, ::4]
    histogram = np.bincount(sampled.ravel(), minlength=256)[:256]
    total = int(histogram.sum()) or 1
    steps = [4, 8, 16, 24, 32, 48]
    suggestion = steps[-1]
    for step in steps:
        share = float(histogram[: step + 1].sum()) / total
        if share >= 0.6:
            suggestion = step
            break
    candidate = distance <= suggestion
    region = _edge_connected(candidate)
    enclosed = candidate & ~region
    return {
        "width": image.width,
        "height": image.height,
        "background": list(background),
        "has_alpha": bool(alpha.min() < 255),
        "background_share": float(candidate.mean()),
        "suggested_tolerance": suggestion,
        # 主体内部被包住的背景面积：>0 说明「只删边缘连通」会留下色块，要切「删所有同色」
        "enclosed_background_share": float(enclosed.mean()),
    }
