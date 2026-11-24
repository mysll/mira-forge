"use client";

import { useEffect, useRef, useState } from "react";

import type { ElementRead } from "@/types/api";

export type ElementAdvanced = {
  negative: string;
  seed: string;
  steps: string;
  cfg: string;
  sampler: string;
};

export const DEFAULT_ADVANCED: ElementAdvanced = {
  negative: "",
  seed: "",
  steps: "",
  cfg: "2",
  sampler: "",
};

const SAMPLERS = ["", "euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "heun"];

type Props = {
  element: ElementRead;
  /** 参考图（场景底图）的地址，用来显示左上角那张缩略图 */
  sourceUrl?: string | null;
  prompt: string;
  onPromptChange: (value: string) => void;
  onCommit: (prompt: string) => void;
  count: number;
  onCountChange: (value: number) => void;
  advanced: ElementAdvanced;
  onAdvancedChange: (patch: Partial<ElementAdvanced>) => void;
  onExtract: () => void;
  pending: boolean;
  onOpenMask: () => void;
  onClearMask: () => void;
  onCollapsedChange?: (collapsed: boolean) => void;
};

const KIND_LABEL: Record<string, string> = {
  terrain: "地形",
  structure: "结构",
  prop: "道具",
  decor: "装饰",
};

/**
 * 元素页底部的输入框：和分层工作台同一套版式。
 *
 * 只负责「这一件的提示词 + 张数 + 高级参数 + 出图」，参考图固定是场景底图；
 * 默认收起，只留一行，避免挡住上面的出图网格。
 */
export default function ElementComposer({
  element,
  sourceUrl,
  prompt,
  onPromptChange,
  onCommit,
  count,
  onCountChange,
  advanced,
  onAdvancedChange,
  onExtract,
  pending,
  onOpenMask,
  onClearMask,
  onCollapsedChange,
}: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    onCollapsedChange?.(collapsed);
  }, [collapsed, onCollapsedChange]);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 260)}px`;
  }, [prompt, collapsed, element.id]);

  const busy = pending || element.status === "queued" || element.status === "running";

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-4 pb-4">
      <div className="pointer-events-auto mx-auto w-full max-w-[1180px] rounded-xl2 border border-edge/80 bg-surface/92 p-3 shadow-pop backdrop-blur-2xl">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
            {KIND_LABEL[element.kind] ?? element.kind}
          </span>
          <span className="max-w-[280px] truncate text-[13px] font-medium text-text">
            {element.name}
          </span>
          <span className="text-[11px] text-muted/60">{element.key}</span>
          {element.has_mask ? (
            <span className="rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
              已画遮罩
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={onOpenMask}
              title="在底图上圈出这一件，出图会按圈出来的范围裁参考图"
              className="rounded-md border border-edge px-2 py-1 text-[11px] text-muted transition hover:border-accent/50 hover:text-text"
            >
              {element.has_mask ? "改遮罩" : "画遮罩"}
            </button>
            {element.has_mask ? (
              <button
                type="button"
                onClick={onClearMask}
                className="rounded-md border border-edge px-2 py-1 text-[11px] text-muted transition hover:border-rose-400/50 hover:text-rose-200"
              >
                清除
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setCollapsed((value) => !value)}
              aria-label={collapsed ? "展开输入框" : "收起输入框"}
              title={collapsed ? "展开输入框" : "收起输入框"}
              className="rounded-md border border-edge px-2 py-1 text-[11px] text-muted transition hover:border-accent/50 hover:text-text"
            >
              <svg
                viewBox="0 0 20 20"
                className={`h-3.5 w-3.5 transition-transform ${collapsed ? "rotate-180" : ""}`}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="m5 8 5 5 5-5" />
              </svg>
            </button>
          </div>
        </div>

        {collapsed ? (
          <div className="mt-2 flex items-center gap-2">
            <span className="truncate text-[11px] text-muted/60">
              {prompt.slice(0, 60) || "还没写提示词"}
            </span>
            <button
              type="button"
              onClick={onExtract}
              disabled={pending}
              className="ml-auto shrink-0 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-black transition hover:brightness-110 disabled:opacity-60"
            >
              {busy ? "提取中…" : `${element.status === "ready" ? "重新提取" : "提取"} ${count} 张`}
            </button>
          </div>
        ) : (
          <>
            <div className="mt-2 flex items-start gap-2">
              <div className="relative shrink-0 overflow-hidden rounded-md border border-edge">
                {sourceUrl ? (
                  <img
                    src={sourceUrl}
                    alt=""
                    className="h-[52px] w-[52px] object-cover"
                  />
                ) : (
                  <div className="flex h-[52px] w-[52px] items-center justify-center bg-surface2/60 text-[10px] text-muted/60">
                    底图
                  </div>
                )}
                <span className="absolute inset-x-0 bottom-0 bg-black/60 py-0.5 text-center text-[9px] text-white/80">
                  参考
                </span>
              </div>
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(event) => onPromptChange(event.target.value)}
                onBlur={() => onCommit(prompt)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    onExtract();
                  }
                }}
                placeholder="描述这件东西长什么样，提取时按这段描述重画"
                className="scroll-thin min-h-[92px] w-full resize-none rounded-lg border border-edge bg-surface2/60 px-2.5 py-2 text-[12px] leading-relaxed text-text outline-none focus:border-accent/50"
              />
            </div>

            {advancedOpen ? (
              <div className="mt-2 rounded-lg border border-edge/70 bg-surface2/40 p-2">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <label className="flex flex-col gap-1 text-[11px] text-muted">
                    种子
                    <input
                      value={advanced.seed}
                      onChange={(event) => onAdvancedChange({ seed: event.target.value })}
                      placeholder="留空随机"
                      inputMode="numeric"
                      className="rounded-md border border-edge bg-surface px-2 py-1 text-[11px] text-text outline-none focus:border-accent/50"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-muted">
                    步数
                    <input
                      value={advanced.steps}
                      onChange={(event) => onAdvancedChange({ steps: event.target.value })}
                      placeholder="默认"
                      inputMode="numeric"
                      className="rounded-md border border-edge bg-surface px-2 py-1 text-[11px] text-text outline-none focus:border-accent/50"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-muted">
                    CFG
                    <input
                      value={advanced.cfg}
                      onChange={(event) => onAdvancedChange({ cfg: event.target.value })}
                      placeholder="默认"
                      inputMode="decimal"
                      className="rounded-md border border-edge bg-surface px-2 py-1 text-[11px] text-text outline-none focus:border-accent/50"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-muted">
                    采样器
                    <select
                      value={advanced.sampler}
                      onChange={(event) => onAdvancedChange({ sampler: event.target.value })}
                      className="rounded-md border border-edge bg-surface px-2 py-1 text-[11px] text-text outline-none focus:border-accent/50"
                    >
                      {SAMPLERS.map((value) => (
                        <option key={value || "default"} value={value}>
                          {value || "默认"}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="mt-2 flex flex-col gap-1 text-[11px] text-muted">
                  负面提示词
                  <textarea
                    value={advanced.negative}
                    onChange={(event) => onAdvancedChange({ negative: event.target.value })}
                    rows={2}
                    placeholder="不想出现的东西（棋盘格、白底、光晕、文字…）"
                    className="scroll-thin w-full resize-y rounded-md border border-edge bg-surface px-2 py-1 text-[11px] leading-relaxed text-text outline-none focus:border-accent/50"
                  />
                </label>
              </div>
            ) : null}

            <div className="mt-2 flex items-center gap-2">
              <label className="text-[11px] text-muted">
                张数
                <select
                  value={count}
                  onChange={(event) => onCountChange(Number(event.target.value))}
                  className="ml-1 rounded-md border border-edge bg-surface2 px-1 py-0.5 text-[11px] text-text outline-none"
                >
                  {[1, 2, 3, 4].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <span className="text-[11px] text-muted/50">
                {element.has_mask ? "按遮罩范围出图" : "输出比例跟随底图"}
              </span>
              <button
                type="button"
                onClick={() => setAdvancedOpen((value) => !value)}
                className={`ml-2 rounded-md border px-2 py-1 text-[11px] transition ${
                  advancedOpen
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-edge text-muted hover:border-accent/40 hover:text-text"
                }`}
              >
                高级
              </button>
              <button
                type="button"
                onClick={onExtract}
                disabled={pending}
                className="ml-auto rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-black transition hover:brightness-110 disabled:opacity-60"
              >
                {busy ? "提取中…" : `${element.status === "ready" ? "重新提取" : "提取"} ${count} 张`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
