"use client";

import { useState, type ReactNode } from "react";

import { exportSize, placementFor, rgbToHex, upscaleRatio, MIN_SUBJECT_PCT, MAX_SUBJECT_PCT } from "@/lib/editor";
import type { EditorAnalysis, LocalEditSaved } from "@/lib/api";
import { useEditorStore } from "@/stores/editor";

type Props = {
  analysis: EditorAnalysis | null;
  busy: boolean;
  onRemoveBackground: () => void;
  onResetSubject: () => void;
  onTrim: () => void;
  onFitCanvas: () => void;
  onCenter: () => void;
  onExport: () => void;
  onSave: () => void;
  saving: boolean;
  saved: LocalEditSaved | null;
  onReplace: () => void;
};

const PRESETS = [256, 512, 720, 1024, 2048];
const EXPORT_SCALES = [1, 2, 4];

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

/**
 * 数字输入框：打字期间只更新框里的草稿，失焦或回车才提交。
 *
 * 之前每敲一个字符就写回 store，而 store 会把小于 16 的值提成 16 —— 想输 720，
 * 敲下「7」的瞬间框里就变成 16，再敲「2」拼成 162，永远输不进去。
 */
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
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (Number.isFinite(value) ? String(Math.round(value)) : "0");

  const commit = () => {
    if (draft === null) {
      return;
    }
    const raw = draft.trim();
    setDraft(null);
    if (raw === "") {
      return;
    }
    const next = Number(raw);
    if (Number.isFinite(next)) {
      onChange(next);
    }
  };

  return (
    <input
      type="number"
      className={`${width} rounded-md border border-edge bg-surface2 px-2 py-1 text-right text-[12px] text-ink tabular-nums outline-none focus:border-accent/60`}
      value={shown}
      min={min}
      max={max}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
          return;
        }
        if (event.key === "Escape") {
          setDraft(null);
          event.currentTarget.blur();
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
  onSave,
  saving,
  saved,
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
    denoise,
    exportScale,
    cut,
    subject,
    setCanvas,
    setParams,
    setExportScale,
    reset,
    undo,
    redo,
    past,
    future,
  } = useEditorStore();

  const estimatedColor = rgbToHex(analysis?.background);
  const output = exportSize({ canvasWidth, canvasHeight }, exportScale);
  const upscale = upscaleRatio(
    placementFor({ canvasWidth, canvasHeight, background, subject, heightPct, bottom, offsetX }),
    subject,
  );
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
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            <span>宽</span>
            <NumberBox value={canvasWidth} min={16} max={4096} onChange={(value) => setCanvas(value, canvasHeight)} />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            <span>高</span>
            <NumberBox value={canvasHeight} min={16} max={4096} onChange={(value) => setCanvas(canvasWidth, value)} />
          </label>
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
              onClick={() =>
                setParams(
                  option.key === "color"
                    ? // 「删所有同色」是全局匹配，容差留大容易把主体里的深色也吃掉，这里顺手收一下
                      { mode: option.key, tolerance: Math.min(tolerance, 12) }
                    : { mode: option.key },
                )
              }
            >
              {option.label}
            </button>
          ))}
        </div>
        {mode === "color" && tolerance > 16 ? (
          <p className="text-[10px] leading-relaxed text-warn">
            容差 {tolerance} 对「删所有同色」偏大，主体里的深色部分可能被一起删掉，建议先降到 8–12。
          </p>
        ) : null}
        <Row label="容差" suffix={String(tolerance)}>
          {/* 上限 48：这里量的是「逐通道最大差」（0–255），后端给的建议值只到 48，
              再往上滑基本只会连主体一起啃掉，还会让有用区间挤在滑条前 1/4。 */}
          <Slider value={tolerance} min={0} max={48} onChange={(value) => setParams({ tolerance: value }, { quiet: true })} />
        </Row>
        <Row label="羽化" suffix={`${feather} px`}>
          <Slider value={feather} min={0} max={8} onChange={(value) => setParams({ feather: value }, { quiet: true })} />
        </Row>
        <Row label="去杂点" suffix={`${denoise} 档`}>
          <Slider value={denoise} min={0} max={4} onChange={(value) => setParams({ denoise: value }, { quiet: true })} />
        </Row>
        <p className="text-[10px] leading-relaxed text-muted/60">
          填掉主体内部的小孔、丢掉背景里的小碎块；面积小于 40×档位 平方像素才动，所以大片封闭背景不会被糊上。
        </p>
        {analysis && analysis.enclosed_background_share > 0.002 ? (
          <p className="rounded border border-warn/30 bg-warn/10 px-2 py-1.5 text-[10px] leading-relaxed text-warn">
            这张图主体内部还有约 {(analysis.enclosed_background_share * 100).toFixed(1)}% 的封闭背景（被主体包住的同色块）。
            「只删边缘连通」碰不到它，切到上面的「删所有同色」再点抠除；如果边缘留下浅色描边，把「去杂点」调到 1–2 档，内部的小孔和碎块会一并清掉。
          </p>
        ) : null}
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
        <Row label="倍率">
          <div className="flex gap-1">
            {EXPORT_SCALES.map((scale) => (
              <button
                key={scale}
                type="button"
                className={[
                  "rounded-md border px-2 py-1 text-[11px] tabular-nums transition",
                  exportScale === scale
                    ? "border-accent/60 bg-accent/15 text-accentSoft"
                    : "border-edge text-muted hover:border-accent/40 hover:text-ink",
                ].join(" ")}
                onClick={() => setExportScale(scale)}
                title={scale === 1 ? "按画布尺寸原样导出" : "构图不变，只提高输出像素"}
              >
                {scale}×
              </button>
            ))}
          </div>
        </Row>
        <p className="text-[11px] leading-relaxed text-muted">
          输出 {output.width} × {output.height}
        </p>
        {upscale > 1.02 ? (
          <p className="rounded-md border border-warn/40 bg-warn/10 px-2 py-1.5 text-[11px] leading-relaxed text-warn">
            主体被放大了 {Math.round((upscale - 1) * 100)}%，已超出原图像素——插值放大一定发软。想要更大的成品请用上面的「倍率」，而不是把主体拖大。
          </p>
        ) : null}
        <button type="button" className="btn-primary w-full py-2 text-[12px]" onClick={onExport} disabled={!subject}>
          导出 PNG · {output.width}×{output.height}
        </button>
        <button
          type="button"
          className="btn-ghost w-full py-1.5 text-[11px]"
          onClick={onSave}
          disabled={!subject || saving}
        >
          {saving ? "正在保存…" : `保存到资产 · ${output.width}×${output.height}`}
        </button>
        <p className="text-[10px] leading-relaxed text-muted/70">
          保存会在资产库生成一条「本地编辑」记录，和生成图一样能收藏、下载、删除；原图不受影响。
        </p>
        {saved ? (
          <p className="rounded-md border border-ok/40 bg-ok/10 px-2 py-1.5 text-[11px] leading-relaxed text-ok">
            已保存为批次 #{saved.generation_id} · 图 #{saved.image_id}（{saved.width}×{saved.height}）
          </p>
        ) : null}
        <button type="button" className="btn-ghost w-full py-1.5 text-[11px]" onClick={onReplace}>
          换一张图
        </button>
      </Section>
    </aside>
  );
}
