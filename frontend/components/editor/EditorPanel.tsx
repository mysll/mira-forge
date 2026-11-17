"use client";

import type { ReactNode } from "react";

import { rgbToHex, MIN_SUBJECT_PCT, MAX_SUBJECT_PCT } from "@/lib/editor";
import { useEditorStore } from "@/stores/editor";

type Props = {
  analysis: { background: number[]; suggested_tolerance: number } | null;
  busy: boolean;
  onRemoveBackground: () => void;
  onResetSubject: () => void;
  onTrim: () => void;
  onFitCanvas: () => void;
  onCenter: () => void;
  onExport: () => void;
  onReplace: () => void;
};

const PRESETS = [256, 512, 1024, 2048];

function Section({ id, title, children, hint }: { id?: string; title: string; children: ReactNode; hint?: string }) {
  return (
    <section id={id} className="border-b border-edge/60 px-4 py-3.5">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[12px] font-medium text-ink">{title}</h3>
        {hint ? <span className="text-[10px] text-muted/70">{hint}</span> : null}
      </div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </section>
  );
}

function Row({ label, children, suffix }: { label: string; children: ReactNode; suffix?: string }) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-muted">
      <span className="w-16 shrink-0">{label}</span>
      <span className="flex flex-1 items-center gap-1.5">
        {children}
        {suffix ? <span className="text-[10px] text-muted/60">{suffix}</span> : null}
      </span>
    </label>
  );
}

function NumberBox({
  value,
  onChange,
  min,
  max,
  width = "w-full",
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  width?: string;
}) {
  return (
    <input
      type="number"
      className={`${width} rounded-md border border-edge bg-surface2 px-2 py-1 text-right text-[12px] text-ink tabular-nums outline-none focus:border-accent/60`}
      value={Number.isFinite(value) ? Math.round(value) : 0}
      min={min}
      max={max}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) {
          onChange(next);
        }
      }}
    />
  );
}

function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <input
      type="range"
      className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-edge accent-[#7c5cff]"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  );
}

export default function EditorPanel({
  analysis,
  busy,
  onRemoveBackground,
  onResetSubject,
  onTrim,
  onFitCanvas,
  onCenter,
  onExport,
  onReplace,
}: Props) {
  const {
    canvasWidth,
    canvasHeight,
    heightPct,
    bottom,
    offsetX,
    background,
    mode,
    tolerance,
    feather,
    cut,
    subject,
    setCanvas,
    setParams,
    reset,
    undo,
    redo,
    past,
    future,
  } = useEditorStore();

  const estimatedColor = rgbToHex(analysis?.background);
  const square = canvasWidth === canvasHeight;

  return (
    <aside className="scroll-thin flex w-[304px] shrink-0 flex-col overflow-y-auto border-l border-edge/70 bg-surface/70">
      <div className="flex items-center gap-1 border-b border-edge/60 px-3 py-2">
        <button
          type="button"
          className="icon-btn"
          title="撤销 (Ctrl+Z)"
          disabled={past.length === 0}
          onClick={undo}
        >
          ↶
        </button>
        <button
          type="button"
          className="icon-btn"
          title="重做 (Ctrl+Shift+Z)"
          disabled={future.length === 0}
          onClick={redo}
        >
          ↷
        </button>
        <button type="button" className="ml-auto text-[11px] text-muted hover:text-ink" onClick={reset}>
          重置参数
        </button>
      </div>

      <Section id="editor-canvas" title="画布" hint={`${canvasWidth} × ${canvasHeight}`}>
        <div className="grid grid-cols-2 gap-2">
          <Row label="宽">
            <NumberBox value={canvasWidth} min={16} max={4096} onChange={(value) => setCanvas(value, canvasHeight)} />
          </Row>
          <Row label="高">
            <NumberBox value={canvasHeight} min={16} max={4096} onChange={(value) => setCanvas(canvasWidth, value)} />
          </Row>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((size) => (
            <button
              key={size}
              type="button"
              className={[
                "rounded-md border px-2 py-1 text-[11px] tabular-nums transition",
                square && canvasWidth === size
                  ? "border-accent/60 bg-accent/15 text-accentSoft"
                  : "border-edge text-muted hover:border-accent/40 hover:text-ink",
              ].join(" ")}
              onClick={() => setCanvas(size, size)}
            >
              {size}²
            </button>
          ))}
          <button
            type="button"
            className="rounded-md border border-edge px-2 py-1 text-[11px] text-muted transition hover:border-accent/40 hover:text-ink"
            onClick={onFitCanvas}
            title="把画布改成和主体一样大（只缩不放）"
          >
            贴合主体
          </button>
        </div>
        <Row label="底色">
          <select
            className="w-full rounded-md border border-edge bg-surface2 px-2 py-1 text-[12px] text-ink outline-none focus:border-accent/60"
            value={background === "transparent" ? "transparent" : "solid"}
            onChange={(event) =>
              setParams({ background: event.target.value === "transparent" ? "transparent" : estimatedColor })
            }
          >
            <option value="transparent">透明</option>
            <option value="solid">纯色</option>
          </select>
          {background !== "transparent" ? (
            <input
              type="color"
              className="h-7 w-9 cursor-pointer rounded border border-edge bg-surface2"
              value={background}
              onChange={(event) => setParams({ background: event.target.value })}
              title="画布底色"
            />
          ) : null}
        </Row>
        {analysis ? (
          <button
            type="button"
            className="self-start text-[11px] text-muted underline decoration-edge hover:text-ink"
            onClick={() => setParams({ background: estimatedColor })}
          >
            用图片自身的背景色 {estimatedColor}
          </button>
        ) : null}
      </Section>

      <Section id="editor-subject" title="主体" hint={subject ? "等比缩放" : "先导入图片"}>
        <Row label="高度" suffix="%">
          <Slider
            value={heightPct}
            min={MIN_SUBJECT_PCT}
            max={MAX_SUBJECT_PCT}
            onChange={(value) => setParams({ heightPct: value }, { quiet: true })}
          />
          <NumberBox value={heightPct} min={MIN_SUBJECT_PCT} max={MAX_SUBJECT_PCT} onChange={(value) => setParams({ heightPct: value })} width="w-14" />
        </Row>
        <Row label="底部留白" suffix="px">
          <Slider value={bottom} min={0} max={canvasHeight} onChange={(value) => setParams({ bottom: value }, { quiet: true })} />
          <NumberBox value={bottom} min={-canvasHeight} max={canvasHeight * 2} onChange={(value) => setParams({ bottom: value })} width="w-14" />
        </Row>
        <Row label="水平偏移" suffix="px">
          <Slider
            value={offsetX}
            min={-canvasWidth / 2}
            max={canvasWidth / 2}
            onChange={(value) => setParams({ offsetX: value }, { quiet: true })}
          />
          <NumberBox value={offsetX} min={-canvasWidth * 2} max={canvasWidth * 2} onChange={(value) => setParams({ offsetX: value })} width="w-14" />
        </Row>
        <div className="flex gap-1.5">
          <button type="button" className="btn-ghost flex-1 px-2 py-1 text-[11px]" onClick={onCenter}>
            水平居中
          </button>
          <button
            type="button"
            className="btn-ghost flex-1 px-2 py-1 text-[11px]"
            onClick={() => setParams({ bottom: 0, offsetX: 0 })}
            title="主体底边贴住画布底边并水平居中"
          >
            贴底居中
          </button>
        </div>
      </Section>

      <Section id="editor-cut" title="抠背景" hint={cut ? "已抠除" : "纯色背景效果最好"}>
        <div className="flex rounded-md border border-edge p-0.5">
          {(
            [
              { key: "edge", label: "只删边缘连通" },
              { key: "color", label: "删所有同色" },
            ] as const
          ).map((option) => (
            <button
              key={option.key}
              type="button"
              className={[
                "flex-1 rounded px-2 py-1 text-[11px] transition",
                mode === option.key ? "bg-accent/20 text-accentSoft" : "text-muted hover:text-ink",
              ].join(" ")}
              onClick={() => setParams({ mode: option.key })}
            >
              {option.label}
            </button>
          ))}
        </div>
        <Row label="容差" suffix={String(tolerance)}>
          <Slider value={tolerance} min={0} max={120} onChange={(value) => setParams({ tolerance: value }, { quiet: true })} />
        </Row>
        <Row label="羽化" suffix={`${feather} px`}>
          <Slider value={feather} min={0} max={8} onChange={(value) => setParams({ feather: value }, { quiet: true })} />
        </Row>
        {analysis ? (
          <p className="text-[10px] leading-relaxed text-muted/70">
            估计背景色 {estimatedColor}，建议容差 {analysis.suggested_tolerance}。
            <button
              type="button"
              className="ml-1 underline decoration-edge hover:text-ink"
              onClick={() => setParams({ tolerance: analysis.suggested_tolerance })}
            >
              采用
            </button>
          </p>
        ) : null}
        <div className="flex gap-1.5">
          <button type="button" className="btn-primary flex-1 px-2 py-1 text-[11px]" disabled={busy} onClick={onRemoveBackground}>
            {busy ? "处理中…" : cut ? "重新抠除" : "抠除背景"}
          </button>
          <button type="button" className="btn-ghost px-2 py-1 text-[11px]" disabled={busy || !cut} onClick={onResetSubject}>
            还原
          </button>
        </div>
        <button type="button" className="btn-ghost px-2 py-1 text-[11px]" disabled={busy || !cut} onClick={onTrim}>
          裁掉透明边
        </button>
      </Section>

      <Section id="editor-export" title="导出" hint="PNG 保留透明">
        <button type="button" className="btn-primary w-full py-2 text-[12px]" onClick={onExport} disabled={!subject}>
          导出 PNG · {canvasWidth}×{canvasHeight}
        </button>
        <button type="button" className="btn-ghost w-full py-1.5 text-[11px]" onClick={onReplace}>
          换一张图
        </button>
      </Section>
    </aside>
  );
}
