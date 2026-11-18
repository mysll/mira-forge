"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** 缩放范围：10% – 400%，滑块按整数百分比走 */
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 4;
const clampZoom = (value: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));

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
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const [size, setSize] = useState(48);
  const [tool, setTool] = useState<"brush" | "erase">("brush");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [brushShape, setBrushShape] = useState<"soft" | "square">("soft");
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [loadSeq, setLoadSeq] = useState(0);
  const [panning, setPanning] = useState(false);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const spaceRef = useRef(false);
  const panRef = useRef({ active: false, x: 0, y: 0, left: 0, top: 0 });
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // 笔刷印章：圆笔刷中心不透明、边缘径向淡出；方笔刷是硬边（刷直边、矩形块用）
  const buildBrush = useCallback((diameter: number, shape: "soft" | "square") => {
    const side = Math.max(2, Math.round(diameter));
    const sprite = document.createElement("canvas");
    sprite.width = side;
    sprite.height = side;
    const context = sprite.getContext("2d");
    if (!context) {
      return null;
    }
    if (shape === "square") {
      context.fillStyle = "rgba(255, 80, 80, 1)";
      context.fillRect(0, 0, side, side);
      return sprite;
    }
    const radius = side / 2;
    const gradient = context.createRadialGradient(radius, radius, radius * 0.35, radius, radius, radius);
    gradient.addColorStop(0, "rgba(255, 80, 80, 1)");
    gradient.addColorStop(0.65, "rgba(255, 80, 80, 0.85)");
    gradient.addColorStop(1, "rgba(255, 80, 80, 0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, side, side);
    return sprite;
  }, []);

  useEffect(() => {
    brushRef.current = buildBrush(size, brushShape);
  }, [size, brushShape, buildBrush]);

  /** 滚轮/滑块缩放：给了鼠标坐标就以光标为锚点，放大时视线不跑 */
  const zoomTo = useCallback((next: number, clientX?: number, clientY?: number) => {
    const node = scrollerRef.current;
    const target = clampZoom(next);
    const current = zoomRef.current;
    if (!node || clientX === undefined || clientY === undefined) {
      setZoom(target);
      return;
    }
    const rect = node.getBoundingClientRect();
    const offsetX = clientX - rect.left + node.scrollLeft;
    const offsetY = clientY - rect.top + node.scrollTop;
    const ratio = target / current;
    setZoom(target);
    requestAnimationFrame(() => {
      node.scrollLeft = Math.max(0, offsetX * ratio - (clientX - rect.left));
      node.scrollTop = Math.max(0, offsetY * ratio - (clientY - rect.top));
    });
  }, []);

  // 空格按住 = 抓手模式（和绘图软件一致）
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") {
        return;
      }
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return;
      }
      spaceRef.current = true;
      setSpaceHeld(true);
      if (tag !== "BUTTON" && tag !== "A") {
        event.preventDefault();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") {
        return;
      }
      spaceRef.current = false;
      setSpaceHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [open]);

  // 跟随鼠标的笔刷轮廓：大小 = 笔刷直径 × 缩放，形状跟着笔刷走
  useEffect(() => {
    if (!open) {
      return;
    }
    const node = scrollerRef.current;
    const cursor = cursorRef.current;
    if (!node || !cursor) {
      return;
    }
    const move = (event: PointerEvent) => {
      const rect = node.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
        cursor.style.opacity = "0";
        return;
      }
      const side = Math.max(4, Math.round(size * zoomRef.current));
      cursor.style.width = `${side}px`;
      cursor.style.height = `${side}px`;
      cursor.style.left = `${event.clientX - rect.left + node.scrollLeft - side / 2}px`;
      cursor.style.top = `${event.clientY - rect.top + node.scrollTop - side / 2}px`;
      cursor.style.opacity = "1";
    };
    const leave = () => {
      cursor.style.opacity = "0";
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerleave", leave);
    return () => {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerleave", leave);
    };
  }, [open, size]);

  /** 滑块缩放：以可视区中心为锚点，免得一拉就跳到左上角 */
  const zoomFromSlider = useCallback(
    (value: number) => {
      const node = scrollerRef.current;
      if (!node) {
        setZoom(clampZoom(value));
        return;
      }
      const rect = node.getBoundingClientRect();
      zoomTo(value, rect.left + rect.width / 2, rect.top + rect.height / 2);
    },
    [zoomTo],
  );

  /** 让整张图落进可视区（不超过 100%，小图不放大） */
  const fitToView = useCallback(() => {
    const node = scrollerRef.current;
    const { width, height } = sizeRef.current;
    if (!node || !width || !height) {
      return;
    }
    const boxWidth = Math.max(160, node.clientWidth - 24);
    const boxHeight = Math.max(160, node.clientHeight - 24);
    setZoom(clampZoom(Math.min(boxWidth / width, boxHeight / height, 1)));
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const node = scrollerRef.current;
    if (!node) {
      return;
    }
    // React 的 onWheel 是被动监听，preventDefault 无效，只能自己挂一个非被动的
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) {
        return;
      }
      event.preventDefault();
      zoomTo(zoomRef.current * (event.deltaY < 0 ? 1.12 : 1 / 1.12), event.clientX, event.clientY);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [open, zoomTo]);

  // 每次打开或换图都回到「适应窗口」：effect 在布局提交后跑，这时才量得到可视区宽度
  useEffect(() => {
    if (!open || !loadSeq) {
      return;
    }
    fitToView();
  }, [open, loadSeq, fitToView]);

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
      setNatural({ width, height });
      setLoadSeq((value) => value + 1);
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
  }, [open, imageUrl, initialMaskUrl, fitToView]);

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
    const scroller = scrollerRef.current;
    if ((spaceRef.current || event.button === 1) && scroller) {
      panRef.current = {
        active: true,
        x: event.clientX,
        y: event.clientY,
        left: scroller.scrollLeft,
        top: scroller.scrollTop,
      };
      setPanning(true);
      return;
    }
    const point = pointToImage(event);
    if (!point) {
      return;
    }
    drawingRef.current = { active: true, last: point };
    stamp(point, point);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (panRef.current.active) {
      const scroller = scrollerRef.current;
      if (!scroller) {
        return;
      }
      scroller.scrollLeft = panRef.current.left - (event.clientX - panRef.current.x);
      scroller.scrollTop = panRef.current.top - (event.clientY - panRef.current.y);
      return;
    }
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
    panRef.current.active = false;
    setPanning(false);
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

  if (!open || typeof document === "undefined") {
    return null;
  }

  // 挂到 body 上：创作框等祖先带 backdrop-filter / transform，会成为 fixed 的包含块，
  // 直接渲染在组件树里会让整层跟着祖先一起偏移。
  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto bg-black/75 p-4 backdrop-blur-sm"
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
            <div className="flex overflow-hidden rounded-lg border border-edge">
              {(
                [
                  { key: "soft", label: "圆" },
                  { key: "square", label: "方" },
                ] as const
              ).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setBrushShape(item.key)}
                  className={[
                    "px-2.5 py-1 text-[11px] transition",
                    brushShape === item.key
                      ? "bg-accent/20 text-accentSoft"
                      : "text-muted hover:bg-surface2 hover:text-ink",
                  ].join(" ")}
                  data-mask-shape={item.key}
                  title={item.key === "soft" ? "圆笔刷：边缘羽化，接缝自然" : "方笔刷：硬边，适合直边与矩形块"}
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

        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge bg-surface2/40 px-4 py-2">
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span>缩放</span>
            <input
              type="range"
              min={10}
              max={400}
              step={5}
              value={Math.round(zoom * 100)}
              onChange={(event) => zoomFromSlider(Number(event.target.value) / 100)}
              className="w-32 accent-[rgb(var(--accent))]"
              aria-label="缩放比例"
              data-mask-zoom
            />
            <span className="w-10 tabular-nums text-ink/70">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              onClick={fitToView}
              className="rounded border border-edge bg-surface2 px-1.5 py-0.5 text-[11px] text-ink/85 transition hover:border-accent/40"
              data-mask-fit
            >
              适应窗口
            </button>
          </div>
          <span className="text-[11px] text-muted/60">滚轮缩放 · 按住空格拖动平移画布</span>
        </div>

        <div
          ref={scrollerRef}
          className="relative flex min-h-0 flex-1 overflow-auto bg-[#0b0d10] p-3"
          style={{ height: "62vh" }}
        >
          <div
            className="relative m-auto block shrink-0 touch-none select-none rounded-lg border border-edge/70"
            style={{
              width: natural.width ? Math.round(natural.width * zoom) : undefined,
              height: natural.height ? Math.round(natural.height * zoom) : undefined,
              cursor: panning ? "grabbing" : spaceHeld ? "grab" : "none",
            }}
          >
            <canvas ref={imageCanvasRef} className="block h-full w-full" />
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
          <div
            ref={cursorRef}
            data-mask-cursor
            className="pointer-events-none absolute left-0 top-0 z-20 border border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.55)]"
            style={{ opacity: 0, borderRadius: brushShape === "square" ? 2 : 9999 }}
          />
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-edge px-4 py-3">
          <p className="text-[11px] text-muted/80">
            提示：圆笔刷边缘羽化，接缝更自然；方笔刷是硬边，适合规整的矩形区域。
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
    </div>,
    document.body,
  );
}
