"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type MaskEditorResult = {
  /** 灰度 PNG：白色 = 要重绘 */
  file: File;
  /** 叠在源图上的红色预览（槽位缩略图用） */
  overlayUrl: string;
  /** 灰度遮罩本身（再次编辑时载入） */
  maskUrl: string;
  width: number;
  height: number;
};

type Props = {
  open: boolean;
  /** 被遮罩的源图（第 1 张参考图） */
  imageUrl: string;
  /** 已有遮罩时载入，用来微调 */
  initialMaskUrl?: string | null;
  onClose: () => void;
  onApply: (result: MaskEditorResult) => void;
};

/**
 * 悬浮遮罩编辑器。
 *
 * 画布按图片原始尺寸建（遮罩与图 1:1，后端直接当掩码用），CSS 只做缩放，
 * 所以涂抹的坐标始终换算回原图像素。笔刷是径向渐变的印章，边缘自带羽化——
 * 硬边遮罩在 ComfyUI 里会留下一圈明显的接缝。
 *
 * 导出两个东西：灰度 PNG（真正提交的遮罩）和红色叠图（给人看的缩略图）。
 */
export default function MaskEditor({
  open,
  imageUrl,
  initialMaskUrl,
  onClose,
  onApply,
}: Props) {
  const imageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const drawingRef = useRef<{ active: boolean; last: { x: number; y: number } | null }>({
    active: false,
    last: null,
  });
  const brushRef = useRef<HTMLCanvasElement | null>(null);

  const [size, setSize] = useState(48);
  const [tool, setTool] = useState<"brush" | "erase">("brush");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  // 笔刷印章：中心不透明、边缘径向淡出
  const buildBrush = useCallback((diameter: number) => {
    const radius = Math.max(1, diameter / 2);
    const sprite = document.createElement("canvas");
    sprite.width = Math.ceil(radius * 2);
    sprite.height = Math.ceil(radius * 2);
    const context = sprite.getContext("2d");
    if (!context) {
      return null;
    }
    const gradient = context.createRadialGradient(radius, radius, radius * 0.35, radius, radius, radius);
    gradient.addColorStop(0, "rgba(255, 80, 80, 1)");
    gradient.addColorStop(0.65, "rgba(255, 80, 80, 0.85)");
    gradient.addColorStop(1, "rgba(255, 80, 80, 0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, sprite.width, sprite.height);
    return sprite;
  }, []);

  useEffect(() => {
    brushRef.current = buildBrush(size);
  }, [size, buildBrush]);

  // 打开时载入源图与已有遮罩
  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setReady(false);
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (cancelled) {
        return;
      }
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      sizeRef.current = { width, height };
      const imageCanvas = imageCanvasRef.current;
      const maskCanvas = maskCanvasRef.current;
      if (!imageCanvas || !maskCanvas) {
        return;
      }
      for (const canvas of [imageCanvas, maskCanvas]) {
        canvas.width = width;
        canvas.height = height;
      }
      const imageContext = imageCanvas.getContext("2d");
      imageContext?.clearRect(0, 0, width, height);
      imageContext?.drawImage(image, 0, 0);
      const maskContext = maskCanvas.getContext("2d");
      maskContext?.clearRect(0, 0, width, height);

      if (!initialMaskUrl) {
        setReady(true);
        return;
      }
      const mask = new Image();
      mask.onload = () => {
        if (cancelled) {
          return;
        }
        const context = maskCanvas.getContext("2d");
        if (context) {
          // 灰度遮罩 → 红色笔迹：亮度当透明度，方便在原图上直接看
          context.save();
          context.globalCompositeOperation = "source-over";
          context.fillStyle = "rgba(255, 80, 80, 1)";
          context.fillRect(0, 0, width, height);
          context.globalCompositeOperation = "destination-in";
          context.drawImage(mask, 0, 0, width, height);
          context.restore();
        }
        setReady(true);
      };
      mask.onerror = () => setReady(true);
      mask.src = initialMaskUrl;
    };
    image.onerror = () => setReady(false);
    image.src = imageUrl;
    return () => {
      cancelled = true;
    };
  }, [open, imageUrl, initialMaskUrl]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onClose]);

  const pointToImage = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = maskCanvasRef.current;
    if (!canvas) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    const { width, height } = sizeRef.current;
    return {
      x: ((event.clientX - rect.left) / rect.width) * width,
      y: ((event.clientY - rect.top) / rect.height) * height,
    };
  };

  const stamp = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const canvas = maskCanvasRef.current;
    const context = canvas?.getContext("2d");
    const brush = brushRef.current;
    if (!canvas || !context || !brush) {
      return;
    }
    const radius = brush.width / 2;
    context.save();
    context.globalCompositeOperation = tool === "erase" ? "destination-out" : "source-over";
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const step = Math.max(1, brush.width * 0.18);
    const count = Math.max(1, Math.ceil(distance / step));
    for (let index = 1; index <= count; index += 1) {
      const x = from.x + ((to.x - from.x) * index) / count;
      const y = from.y + ((to.y - from.y) * index) / count;
      context.drawImage(brush, x - radius, y - radius);
    }
    context.restore();
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointToImage(event);
    if (!point) {
      return;
    }
    drawingRef.current = { active: true, last: point };
    stamp(point, point);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = drawingRef.current;
    if (!state.active || !state.last) {
      return;
    }
    const point = pointToImage(event);
    if (!point) {
      return;
    }
    stamp(state.last, point);
    state.last = point;
  };

  const endStroke = () => {
    drawingRef.current = { active: false, last: null };
  };

  const clearMask = () => {
    const canvas = maskCanvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
  };

  const apply = async () => {
    const maskCanvas = maskCanvasRef.current;
    const imageCanvas = imageCanvasRef.current;
    if (!maskCanvas || !imageCanvas) {
      return;
    }
    const { width, height } = sizeRef.current;
    setBusy(true);
    try {
      // 灰度遮罩：黑色底 + 红色笔迹，红通道就是覆盖度
      const gray = document.createElement("canvas");
      gray.width = width;
      gray.height = height;
      const grayContext = gray.getContext("2d");
      if (!grayContext) {
        return;
      }
      grayContext.fillStyle = "#000";
      grayContext.fillRect(0, 0, width, height);
      grayContext.drawImage(maskCanvas, 0, 0);
      const pixels = grayContext.getImageData(0, 0, width, height);
      for (let offset = 0; offset < pixels.data.length; offset += 4) {
        const value = pixels.data[offset];
        pixels.data[offset] = value;
        pixels.data[offset + 1] = value;
        pixels.data[offset + 2] = value;
        pixels.data[offset + 3] = 255;
      }
      grayContext.putImageData(pixels, 0, 0);

      const drawn = pixels.data.some((value, index) => index % 4 === 0 && value > 8);
      if (!drawn) {
        setBusy(false);
        return;
      }

      const maskBlob = await new Promise<Blob | null>((resolve) =>
        gray.toBlob((result) => resolve(result), "image/png"),
      );
      if (!maskBlob) {
        return;
      }

      // 预览图：原图 + 红色半透明遮罩
      const overlay = document.createElement("canvas");
      overlay.width = width;
      overlay.height = height;
      const overlayContext = overlay.getContext("2d");
      if (!overlayContext) {
        return;
      }
      overlayContext.drawImage(imageCanvas, 0, 0);
      overlayContext.globalAlpha = 0.55;
      overlayContext.drawImage(gray, 0, 0);
      overlayContext.globalAlpha = 1;
      const overlayBlob = await new Promise<Blob | null>((resolve) =>
        overlay.toBlob((result) => resolve(result), "image/png"),
      );
      if (!overlayBlob) {
        return;
      }

      onApply({
        file: new File([maskBlob], `mask-${Date.now()}.png`, { type: "image/png" }),
        overlayUrl: URL.createObjectURL(overlayBlob),
        maskUrl: URL.createObjectURL(maskBlob),
        width,
        height,
      });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onClose();
        }
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-[860px] flex-col rounded-xl2 border border-edge bg-surface shadow-pop">
        <div className="flex items-center justify-between gap-3 border-b border-edge px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-ink">遮罩编辑器</h2>
            <p className="mt-0.5 text-[11px] text-muted">
              涂抹要重绘的地方（红色），其余像素保持原样；只有第一张参考图会被遮罩。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex overflow-hidden rounded-lg border border-edge">
              {(
                [
                  { key: "brush", label: "画笔" },
                  { key: "erase", label: "橡皮" },
                ] as const
              ).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setTool(item.key)}
                  className={[
                    "px-2.5 py-1 text-[11px] transition",
                    tool === item.key
                      ? "bg-accent/20 text-accentSoft"
                      : "text-muted hover:bg-surface2 hover:text-ink",
                  ].join(" ")}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-[11px] text-muted">
              笔刷
              <input
                type="range"
                min={8}
                max={200}
                step={2}
                value={size}
                onChange={(event) => setSize(Number(event.target.value))}
                className="w-24 accent-[rgb(var(--accent))]"
                aria-label="笔刷大小"
              />
              <span className="w-8 tabular-nums text-ink/70">{size}</span>
            </label>
            <button
              type="button"
              onClick={clearMask}
              className="h-8 rounded-lg border border-edge bg-surface2 px-2.5 text-[11px] text-ink/90 transition hover:border-accent/40"
            >
              清空
            </button>
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[#0b0d10] p-3">
          <div
            className="relative inline-block touch-none select-none rounded-lg border border-edge/70"
            style={{ cursor: tool === "erase" ? "cell" : "crosshair" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <canvas ref={imageCanvasRef} className="block max-h-[62vh] w-auto max-w-full" />
            <canvas
              ref={maskCanvasRef}
              className="absolute inset-0 block h-full w-full"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endStroke}
              onPointerLeave={endStroke}
              onPointerCancel={endStroke}
              data-mask-canvas
            />
            {!ready ? (
              <span className="absolute inset-0 flex items-center justify-center text-xs text-white/60">
                载入图片中…
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-edge px-4 py-3">
          <p className="text-[11px] text-muted/80">
            提示：笔刷边缘自带羽化，接缝会比硬边遮罩自然得多。
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="h-9 rounded-lg border border-edge bg-surface2 px-3 text-xs text-ink/90 transition hover:border-accent/40 disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void apply()}
              disabled={busy || !ready}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-white transition hover:bg-accent/90 disabled:opacity-60"
            >
              {busy ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border border-white/40 border-t-white" />
              ) : null}
              应用遮罩
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
