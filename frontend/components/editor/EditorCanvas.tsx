"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { drawScene, exportSize, placementFor } from "@/lib/editor";
import { useEditorStore } from "@/stores/editor";

/** 透明区域的棋盘格：用 CSS 渐变画，不额外加请求。 */
const CHECKER =
  "repeating-conic-gradient(#1b1f27 0% 25%, #141821 0% 50%) 50% / 24px 24px";

export default function EditorCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; bottom: number; offsetX: number } | null>(null);

  const subject = useEditorStore((state) => state.subject);
  const canvasWidth = useEditorStore((state) => state.canvasWidth);
  const canvasHeight = useEditorStore((state) => state.canvasHeight);
  const background = useEditorStore((state) => state.background);
  const heightPct = useEditorStore((state) => state.heightPct);
  const bottom = useEditorStore((state) => state.bottom);
  const offsetX = useEditorStore((state) => state.offsetX);
  const exportScale = useEditorStore((state) => state.exportScale);
  const setParams = useEditorStore((state) => state.setParams);

  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const [dragging, setDragging] = useState(false);

  /** 画布尺寸变了就重新算一次「适应窗口」的比例，保证刚打开时整张都在视野里。
   *  小画布（256×256 这类）会被放大到接近窗口，否则在大屏上只有指甲盖大小。 */
  const recomputeFit = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    const padding = 96;
    const availableWidth = Math.max(80, stage.clientWidth - padding);
    const availableHeight = Math.max(80, stage.clientHeight - padding);
    const raw = Math.min(availableWidth / canvasWidth, availableHeight / canvasHeight);
    setZoom(Math.max(0.05, Math.min(raw, 8)));
  }, [canvasWidth, canvasHeight]);

  useEffect(() => {
    if (fit) {
      recomputeFit();
    }
  }, [fit, recomputeFit]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !fit) {
      return;
    }
    const observer = new ResizeObserver(() => recomputeFit());
    observer.observe(stage);
    return () => observer.disconnect();
  }, [fit, recomputeFit]);

  /** 预览的像素密度：把画布按「当前缩放 × 屏幕像素比」重绘，
   *  这样放大查看时是在用原图的细节重画，而不是把 256px 的成品放大成糊块。
   *  导出仍按画布（× 倍率）出真尺寸，状态条里写明两者数值。 */
  const renderScale = Math.max(1, Math.min(4, zoom * (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1)));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const targetWidth = Math.round(canvasWidth * renderScale);
    const targetHeight = Math.round(canvasHeight * renderScale);
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    drawScene(
      ctx,
      {
        canvasWidth,
        canvasHeight,
        background,
        subject,
        heightPct,
        bottom,
        offsetX,
      },
      renderScale,
    );
  }, [background, bottom, canvasHeight, canvasWidth, heightPct, offsetX, renderScale, subject]);

  /** 拖拽 = 改「底部留白」与「水平偏移」，单位是画布像素而不是屏幕像素。 */
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!subject) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, bottom, offsetX };
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragRef.current;
    if (!start) {
      return;
    }
    const dx = (event.clientX - start.x) / zoom;
    const dy = (event.clientY - start.y) / zoom;
    setParams({ offsetX: start.offsetX + dx, bottom: start.bottom - dy }, { quiet: true });
  };

  const endDrag = () => {
    if (!dragRef.current) {
      return;
    }
    dragRef.current = null;
    setDragging(false);
    // 拖完再记一次历史，避免拖拽过程把撤销栈塞满
    const state = useEditorStore.getState();
    state.setParams({ offsetX: state.offsetX, bottom: state.bottom });
  };

  const output = exportSize({ canvasWidth, canvasHeight }, exportScale);
  const placement = placementFor({
    canvasWidth,
    canvasHeight,
    background,
    subject,
    heightPct,
    bottom,
    offsetX,
  });

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-edge/60 px-4 py-1.5 text-[11px] text-muted">
        <span className="rounded bg-surface2 px-1.5 py-0.5 text-ink">
          {Math.round(canvasWidth)} × {Math.round(canvasHeight)}
        </span>
        <span className="rounded border border-edge px-1.5 py-0.5 tabular-nums" title="导出文件的实际像素">
          导出 {output.width} × {output.height}
        </span>
        {placement ? (
          <span className="truncate">
            主体 {Math.round(placement.width)} × {Math.round(placement.height)} · 底边留白 {Math.round(bottom)} px
            {Math.round(offsetX) !== 0 ? ` · 水平 ${Math.round(offsetX)} px` : " · 水平居中"}
          </span>
        ) : (
          <span>还没有主体</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="rounded-md border border-edge px-2 py-0.5 hover:border-accent/50 hover:text-ink"
            onClick={() => {
              setFit(true);
              recomputeFit();
            }}
            title="缩放到适应窗口"
          >
            适应
          </button>
          <button
            type="button"
            className="rounded-md border border-edge px-2 py-0.5 hover:border-accent/50 hover:text-ink"
            onClick={() => {
              setFit(false);
              setZoom(1);
            }}
            title="按实际像素显示"
          >
            100%
          </button>
          <span className="w-10 text-right tabular-nums">{Math.round(zoom * 100)}%</span>
        </div>
      </div>

      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-auto">
        <div className="flex min-h-full items-center justify-center p-8">
          <div
            className="relative shadow-[0_20px_60px_rgba(0,0,0,0.45)] ring-1 ring-edge"
            style={{
              width: canvasWidth * zoom,
              height: canvasHeight * zoom,
              background: CHECKER,
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <canvas
              ref={canvasRef}
              className={dragging ? "cursor-grabbing" : subject ? "cursor-grab" : "cursor-default"}
              style={{ width: "100%", height: "100%", display: "block" }}
            />
          </div>
        </div>
      </div>

      <p className="border-t border-edge/60 px-4 py-1.5 text-[11px] text-muted/70">
        拖动画面可以调整主体位置；缩放在右侧「主体」里按高度百分比调节，宽度按原比例自动算，不会变形。放大查看时预览按原图细节重绘，导出像素看顶部「导出」。
      </p>
    </div>
  );
}
