"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import CountMenu from "@/components/CountMenu";
import Popover from "@/components/Popover";
import { imageThumbnailUrl } from "@/lib/api";
import type { ImageBrief, LayerRead, ModelInfo } from "@/types/api";

type Values = {
  count: number;
  negative: string;
  model: string;
  seed: string;
  steps: string;
  cfg: string;
  sampler: string;
};

type Props = {
  layer: LayerRead;
  /** 分层源图：固定，不能换（这一层永远拿它当结构参考） */
  source: ImageBrief | null;
  /** 支持 image_edit 的模型 */
  models: ModelInfo[];
  /** 方案里记的模型名，找不到时当兜底展示 */
  fallbackModel: string;
  /** 提示词由外面存（切页签时不会丢未保存的改动） */
  prompt: string;
  onPromptChange: (value: string) => void;
  onCommit: (values: { prompt: string; negative: string }) => void;
  /** 分析中：页签还在生成，出图按钮先禁掉 */
  busy: boolean;
  pending: boolean;
  onRender: (values: Values) => void;
  /** 收起 / 展开时告诉页面，好把信息流的底部留白让出来 */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** 画 / 改这一层的遮罩（只在遮罩里重绘，图上其余部分保持原样） */
  onMask?: () => void;
  /** 变化时强制展开（工作台里点「继续编辑」要把提示词露出来） */
  expandToken?: number;
};

const COUNT_OPTIONS = [1, 2, 3, 4];
/** 分层出图默认 CFG：Qwen 编辑模型 2.0 比 1.0 更听提示词，又不至于过饱和 */
const DEFAULT_CFG = "2";

/**
 * 分层工作台底部的输入框。
 *
 * 布局与「图片编辑」的 Composer 一致（模型 / 数量 / 高级 / 生成），差别只有两处：
 * 1. 参考图是固定的分层源图，不给换、不给删；
 * 2. 提示词、负面词、模型都按这一层预先填好，默认就展开高级设置。
 */
export default function LayerComposer({
  layer,
  source,
  models,
  fallbackModel,
  prompt,
  onPromptChange,
  onCommit,
  busy,
  pending,
  onRender,
  onCollapsedChange,
  onMask,
  expandToken,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 默认收起：只留标题 + 参数栏，别把下面的信息流挡住
  const [collapsed, setCollapsed] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(true);

  useEffect(() => {
    if (expandToken) {
      setCollapsed(false);
    }
  }, [expandToken]);
  const [count, setCount] = useState(1);
  const [negative, setNegative] = useState("");
  const [modelId, setModelId] = useState("");
  const [seedMode, setSeedMode] = useState<"random" | "fixed">("random");
  const [seed, setSeed] = useState("");
  const [steps, setSteps] = useState("");
  const [cfg, setCfg] = useState(DEFAULT_CFG);
  const [sampler, setSampler] = useState("");

  // 换层就把这一层的默认值铺回来（层卡里的提示词是「已填好」的那一版）
  useEffect(() => {
    setNegative(layer.negative_prompt ?? "");
    setSteps("");
    setCfg(DEFAULT_CFG);
    setSampler("");
    setSeed("");
    setSeedMode("random");
    setModelId((current) => (models.some((model) => model.id === current) ? current : ""));
  }, [layer.id, layer.negative_prompt, models]);

  const activeModel = useMemo(() => {
    return (
      models.find((model) => model.id === modelId) ??
      models.find((model) => model.id === fallbackModel || model.label === fallbackModel) ??
      models.find((model) => model.is_default) ??
      models[0] ??
      null
    );
  }, [models, modelId, fallbackModel]);

  const capabilities = activeModel?.capabilities;

  // 输入框随内容长高，超过 200px 内部滚动（和 Composer 同一档手感）
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) {
      return;
    }
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [prompt, layer.id, collapsed]);

  // 收起/展开要通知页面，好让信息流底部留白跟着变
  useEffect(() => {
    onCollapsedChange?.(collapsed);
  }, [collapsed, onCollapsedChange]);

  const canSubmit = prompt.trim().length > 0 && !busy && !pending;

  const submit = () => {
    if (!canSubmit) {
      return;
    }
    onRender({
      count,
      negative,
      model: activeModel?.id ?? "",
      seed: seedMode === "fixed" ? seed : "",
      steps,
      cfg,
      sampler,
    });
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-4 pb-4">
      <div className="pointer-events-auto relative mx-auto flex max-w-[1180px] flex-col gap-2.5 rounded-xl2 border border-edge/80 bg-surface/92 p-3 shadow-pop backdrop-blur-2xl">
        {/* 标题行：这一层的名字就是输入框标题 */}
        <div className="flex items-center gap-1">
          <span className="rounded-md bg-accent/15 px-2 py-1 font-mono text-[10px] text-accentSoft">
            L{layer.ord}
          </span>
          <span className="truncate px-1 text-xs text-ink" title={layer.name}>
            {layer.name}
          </span>
          <span className="rounded-md px-2 py-1 text-[10px] text-muted">场景分层 · 编辑</span>
          {onMask ? (
            <button
              type="button"
              onClick={onMask}
              className={[
                "ml-1 flex items-center gap-1 rounded-md px-2 py-1 text-[10px] transition",
                layer.has_mask
                  ? "bg-accent/12 text-accentSoft hover:bg-accent/20"
                  : "text-muted hover:bg-surface2 hover:text-ink",
              ].join(" ")}
              title={
                layer.has_mask
                  ? "这一层已经画了遮罩：生成时只在遮罩里重绘，其余保持原样"
                  : "画一块遮罩，生成时只在这块区域重绘"
              }
            >
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" aria-hidden>
                <path
                  d="M4 17.5V20h2.5L18 8.5 15.5 6 4 17.5Z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
              </svg>
              {layer.has_mask ? "改遮罩" : "画遮罩"}
              {layer.has_mask ? (
                <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
              ) : null}
            </button>
          ) : null}
          <span className="ml-auto truncate text-[11px] text-muted/60">
            {activeModel ? activeModel.label : fallbackModel || "模型加载中"}
          </span>
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="ml-2 flex h-6 w-6 items-center justify-center rounded-md text-muted transition hover:bg-surface2 hover:text-ink"
            title={collapsed ? "展开输入框" : "收起输入框"}
            aria-label={collapsed ? "展开输入框" : "收起输入框"}
            aria-expanded={!collapsed}
          >
            <svg
              viewBox="0 0 24 24"
              className={["h-3.5 w-3.5 transition-transform", collapsed ? "" : "rotate-180"].join(" ")}
              fill="none"
              aria-hidden
            >
              <path d="m6 15 6-6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* 输入区 + 固定参考图：收起时整块隐藏 */}
        {collapsed ? null : (
          <div className="flex items-start gap-2">
          <div className="flex shrink-0 flex-col items-center gap-1" data-slot>
            <div
              className="relative h-[52px] w-[52px] overflow-hidden rounded-lg border border-edge"
              title={source ? "这一层用这张场景图做参考" : "场景原图"}
            >
              {source ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageThumbnailUrl(source)}
                    alt={`源图 ${source.id}`}
                    className="h-full w-full object-cover"
                  />
                  <span className="absolute inset-x-0 bottom-0 bg-black/55 py-[1px] text-center text-[9px] leading-none text-white/80">
                    原图
                  </span>
                </>
              ) : null}
            </div>
            <div className="flex h-[14px] items-center whitespace-nowrap text-[9px] leading-none text-muted/70">
              结构
            </div>
          </div>

          <textarea
            ref={textareaRef}
            value={prompt}
            rows={1}
            maxLength={8000}
            placeholder="这一层要保留什么、删掉什么、被挡的部分补到哪里（已按层填好，可以直接改）"
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            onBlur={() => onCommit({ prompt, negative })}
            className="scroll-thin min-h-[52px] flex-1 resize-none bg-transparent px-1 py-2 text-sm leading-relaxed text-ink outline-none placeholder:text-muted/60"
          />
          </div>
        )}

        {/* 高级设置：展开状态下可见（默认展开，收起时整块隐藏） */}
        {!collapsed && advancedOpen ? (
          <div className="grid grid-cols-1 gap-2 rounded-lg border border-edge/70 bg-surface2/50 p-2.5 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1">
              <span className="label">Seed</span>
              <div className="flex items-center gap-1">
                <div className="flex rounded-md border border-edge bg-surface p-0.5">
                  {(
                    [
                      { key: "random", label: "随机" },
                      { key: "fixed", label: "固定" },
                    ] as const
                  ).map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => {
                        setSeedMode(option.key);
                        if (option.key === "random") setSeed("");
                      }}
                      className={[
                        "rounded px-2 py-0.5 text-[11px] transition",
                        seedMode === option.key
                          ? "bg-accent/20 text-accentSoft"
                          : "text-muted hover:text-ink",
                      ].join(" ")}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <input
                  value={seed}
                  onChange={(event) => {
                    setSeed(event.target.value.replace(/[^\d]/g, ""));
                    setSeedMode("fixed");
                  }}
                  placeholder="固定 seed"
                  inputMode="numeric"
                  className="field h-7 flex-1 px-2 py-0 text-[11px]"
                  disabled={seedMode !== "fixed"}
                />
              </div>
            </label>

            {capabilities?.exposes_steps ? (
              <label className="flex flex-col gap-1">
                <span className="label">步数</span>
                <input
                  value={steps}
                  onChange={(event) => setSteps(event.target.value.replace(/[^\d]/g, ""))}
                  placeholder={String(activeModel?.defaults.steps ?? 25)}
                  inputMode="numeric"
                  className="field h-7 px-2 py-0 text-[11px]"
                />
              </label>
            ) : null}

            {capabilities?.exposes_cfg ? (
              <label className="flex flex-col gap-1">
                <span className="label">CFG</span>
                <input
                  value={cfg}
                  onChange={(event) => setCfg(event.target.value.replace(/[^\d.]/g, ""))}
                  placeholder={String(activeModel?.defaults.cfg ?? 1)}
                  inputMode="decimal"
                  className="field h-7 px-2 py-0 text-[11px]"
                />
              </label>
            ) : null}

            {capabilities?.exposes_sampler ? (
              <label className="flex flex-col gap-1">
                <span className="label">采样器</span>
                <select
                  value={sampler}
                  onChange={(event) => setSampler(event.target.value)}
                  className="field h-7 px-2 py-0 text-[11px]"
                >
                  <option value="">默认（{String(activeModel?.defaults.sampler ?? "euler")}）</option>
                  {(capabilities.sampler_options ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {capabilities?.exposes_negative_prompt ? (
              <label className="col-span-1 flex flex-col gap-1 sm:col-span-2 lg:col-span-4">
                <span className="label">负面提示词</span>
                <input
                  value={negative}
                  onChange={(event) => setNegative(event.target.value)}
                  onBlur={() => onCommit({ prompt, negative })}
                  placeholder="不希望出现的元素，例如 悬空、棋盘格、白底、缺角"
                  className="field h-7 px-2 py-0 text-[11px]"
                />
              </label>
            ) : null}
          </div>
        ) : null}

        {/* 参数栏 + 生成 */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Popover
            label={<span>{activeModel?.label ?? "模型"}</span>}
            title="选择模型"
            width={250}
            active={Boolean(modelId)}
          >
            {(close) => (
              <div className="flex flex-col">
                {models.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => {
                      setModelId(model.id);
                      close();
                    }}
                    className={[
                      "flex flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left transition",
                      activeModel?.id === model.id ? "bg-accent/12" : "hover:bg-surface2",
                    ].join(" ")}
                  >
                    <span className="text-xs text-ink">{model.label}</span>
                    <span className="text-[10px] text-muted">{model.description || model.id}</span>
                  </button>
                ))}
              </div>
            )}
          </Popover>

          <span
            className="pill cursor-default"
            title="尺寸跟随原图"
          >
            {source ? `${source.width}×${source.height}` : "跟随源图"}
          </span>

          <Popover label={<span>数量 {count}</span>} title="这一层一次出几张" width={80}>
            {(close) => (
              <CountMenu
                options={COUNT_OPTIONS}
                value={count}
                unit="张"
                onSelect={(option) => {
                  setCount(option);
                  close();
                }}
              />
            )}
          </Popover>

          {collapsed ? null : (
            <button
              type="button"
              onClick={() => setAdvancedOpen((open) => !open)}
              className={["pill", advancedOpen ? "border-accent/50 bg-accent/12 text-accentSoft" : ""].join(
                " ",
              )}
              title="高级设置"
            >
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" aria-hidden>
                <path d="M5 7h14M8 12h8M11 17h2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              高级
            </button>
          )}

          <span className="ml-auto text-[11px] text-muted/60">
            {collapsed ? "点右上角箭头展开输入框" : "输出比例跟随源图"}
          </span>

          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="btn-primary ml-2 min-w-[124px]"
          >
            {pending ? (
              <>
                <span className="h-3 w-3 animate-spin rounded-full border border-white/70 border-t-transparent" />
                提交中
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
                  <path
                    d="m5 12 5 5 9-10"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                生成本层 {count} 张
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
