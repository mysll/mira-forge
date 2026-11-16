"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import CountMenu from "@/components/CountMenu";
import Popover from "@/components/Popover";
import {
  createEditGeneration,
  createGeneration,
  createImageToImageGeneration,
  imageAsFile,
} from "@/lib/api";
import { IMAGE_RATIOS, IMAGE_TIERS, megapixels } from "@/lib/size";
import { useComposerStore } from "@/stores/composer";
import { MAX_GENERATION_REFS, useGenerationRefStore } from "@/stores/generationRefs";
import { useReferenceStore } from "@/stores/reference";
import type { GenerationCreatePayload, ModelInfo } from "@/types/api";

type Props = {
  models: ModelInfo[];
  onToast: (message: string) => void;
};

const COUNT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];

function PillIcon({ children }: { children: React.ReactNode }) {
  return <span className="text-muted">{children}</span>;
}

export default function Composer({ models, onToast }: Props) {
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const genFileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const mode = useComposerStore((state) => state.mode);
  const prompts = useComposerStore((state) => state.prompts);
  const setPrompt = useComposerStore((state) => state.setPrompt);
  const setMode = useComposerStore((state) => state.setMode);
  const modelId = useComposerStore((state) => state.modelId);
  const setModelId = useComposerStore((state) => state.setModelId);
  const ratioKey = useComposerStore((state) => state.ratioKey);
  const tierKey = useComposerStore((state) => state.tierKey);
  const width = useComposerStore((state) => state.width);
  const height = useComposerStore((state) => state.height);
  const setRatio = useComposerStore((state) => state.setRatio);
  const setTier = useComposerStore((state) => state.setTier);
  const setCustomSize = useComposerStore((state) => state.setCustomSize);
  const count = useComposerStore((state) => state.count);
  const setCount = useComposerStore((state) => state.setCount);
  const seedMode = useComposerStore((state) => state.seedMode);
  const setSeedMode = useComposerStore((state) => state.setSeedMode);
  const seed = useComposerStore((state) => state.seed);
  const setSeed = useComposerStore((state) => state.setSeed);
  const negative = useComposerStore((state) => state.negative);
  const setNegative = useComposerStore((state) => state.setNegative);
  const steps = useComposerStore((state) => state.steps);
  const setSteps = useComposerStore((state) => state.setSteps);
  const cfg = useComposerStore((state) => state.cfg);
  const setCfg = useComposerStore((state) => state.setCfg);
  const sampler = useComposerStore((state) => state.sampler);
  const setSampler = useComposerStore((state) => state.setSampler);
  const advancedOpen = useComposerStore((state) => state.advancedOpen);
  const setAdvancedOpen = useComposerStore((state) => state.setAdvancedOpen);

  const reference = useReferenceStore();
  const genRefs = useGenerationRefStore();
  const prompt = prompts[mode];

  const activeModel = useMemo(() => {
    return (
      models.find((item) => item.id === modelId) ??
      models.find((item) => item.is_default) ??
      models[0] ??
      null
    );
  }, [models, modelId]);

  const capabilities = activeModel?.capabilities;

  // 输入框自动增高（超过 200px 后内部滚动）
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) {
      return;
    }
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [prompt, mode]);

  // 从作品流点「继续编辑」时自动切模式
  useEffect(() => {
    if (reference.autoEdit && mode !== "image_edit") {
      setMode("image_edit");
      reference.consumeAutoEdit();
    }
  }, [reference, mode, setMode]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["generations"] });
  };

  const submit = useMutation({
    // 把提交瞬间的提示词与模式带进来，成功后只清掉"还是同一句"的输入，
    // 避免用户已经敲下一条提示时被清空
    mutationFn: async (variables: { text: string; mode: typeof mode }) => {
      if (!activeModel) {
        throw new Error("还没有可用模型");
      }
      const base: GenerationCreatePayload = {
        prompt: variables.text.trim(),
        model: activeModel.id,
        generation_type: variables.mode,
        count,
        width,
        height,
      };

      if (capabilities?.exposes_steps && steps.trim()) {
        base.steps = Number(steps);
      }
      if (capabilities?.exposes_cfg && cfg.trim()) {
        base.cfg = Number(cfg);
      }
      if (capabilities?.exposes_sampler && sampler) {
        base.sampler = sampler;
      }
      if (capabilities?.exposes_negative_prompt && negative.trim()) {
        base.negative_prompt = negative.trim();
      }
      if (seedMode === "fixed" && seed.trim()) {
        base.seed = Number(seed);
      }

      // 三个类型共用的表单字段；参考图由各分支自己 append
      const buildForm = () => {
        const form = new FormData();
        form.set("prompt", base.prompt);
        form.set("model", base.model);
        form.set("count", String(count));
        form.set("width", String(width));
        form.set("height", String(height));
        if (base.steps !== undefined) form.set("steps", String(base.steps));
        if (base.cfg !== undefined) form.set("cfg", String(base.cfg));
        if (base.sampler) form.set("sampler", base.sampler);
        if (base.negative_prompt) form.set("negative_prompt", base.negative_prompt);
        if (base.seed !== undefined && base.seed !== null) form.set("seed", String(base.seed));
        return form;
      };

      if (variables.mode === "text_to_image") {
        // 没放参考图就是纯文生图；放了就变成图生图（参考图只影响构图，尺寸照样生效）
        if (genRefs.items.length === 0) {
          return createGeneration(base);
        }
        const form = buildForm();
        genRefs.items.forEach((item) => form.append("images", item.file));
        return createImageToImageGeneration(form);
      }

      const source = reference.source;
      if (!source) {
        throw new Error("图片编辑需要 1 张参考图");
      }
      const file = source.kind === "file" ? source.file : await imageAsFile(source.id);
      const form = buildForm();
      form.set("images", file);
      return createEditGeneration(form);
    },
    onSuccess: (created, variables) => {
      // 提交成功即清空输入框（同模式下、且没被改写成别的句子）
      if (mode === variables.mode && prompts[variables.mode] === variables.text) {
        setPrompt("");
      }
      onToast(created.generation_type === "image_to_image" ? "已提交，参考图已生效" : "已提交，正在排队生成");
      if (created.generation_type === "image_to_image") {
        genRefs.clear();
      }
      invalidate();
    },
    onError: (error: Error) => {
      onToast(error.message || "提交失败");
    },
    onSettled: () => {
      setTimeout(invalidate, 1200);
    },
  });

  const canSubmit =
    prompt.trim().length > 0 &&
    !!activeModel &&
    (mode === "text_to_image" || !!reference.source) &&
    !submit.isPending;

  const handleFiles = (files: FileList | File[] | null | undefined) => {
    const accepted = Array.from(files ?? []).filter((file) => {
      if (!file.type.startsWith("image/")) {
        onToast("只能选 PNG / JPEG / WEBP 图片");
        return false;
      }
      if (file.size > 20 * 1024 * 1024) {
        onToast("单张参考图不能超过 20 MB");
        return false;
      }
      return true;
    });
    if (accepted.length === 0) {
      return;
    }
    if (mode === "image_edit") {
      reference.setFile(accepted[0]);
      return;
    }
    // 图片生成模式下参考图是可选的：有图走参考引导，无图就是普通文生图
    const added = genRefs.addFiles(accepted);
    if (added < accepted.length) {
      onToast(`最多 ${MAX_GENERATION_REFS} 张参考图，多出的没有加入`);
    }
  };

  const sizeLabel =
    ratioKey === "custom" ? `自定义 · ${width}×${height}` : `${ratioKey} · ${tierKey || "1K"}`;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-4 pb-4">
      {/* 渐隐遮罩：让作品流在创作框下方自然淡出，而不是被一条硬边切成上下两块 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 -top-32 bg-gradient-to-t from-bg via-bg via-70% to-transparent" />

      <div
        className={[
          "pointer-events-auto relative mx-auto flex max-w-[1180px] flex-col gap-2.5 rounded-xl2 border bg-surface/92 p-3 shadow-pop backdrop-blur-2xl transition",
          dragOver ? "border-accent/70 ring-2 ring-accent/20" : "border-edge/80",
        ].join(" ")}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          handleFiles(event.dataTransfer.files);
        }}
      >
        {/* 模式切换 */}
        <div className="flex items-center gap-1">
          {(
            [
              { key: "text_to_image", label: "图片生成" },
              { key: "image_edit", label: "图片编辑" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setMode(tab.key)}
              className={[
                "rounded-lg px-2.5 py-1 text-xs transition",
                mode === tab.key
                  ? "bg-accent/15 text-accentSoft"
                  : "text-muted hover:bg-surface2 hover:text-ink",
              ].join(" ")}
            >
              {tab.label}
            </button>
          ))}
          <Link
            href="/video"
            className="rounded-lg px-2.5 py-1 text-xs text-muted transition hover:bg-surface2 hover:text-ink"
            title="视频在独立的工作台里"
          >
            视频
          </Link>
          <span className="ml-auto text-[11px] text-muted/60">
            {activeModel ? `${activeModel.label}` : "模型加载中"}
          </span>
        </div>

        {/* 输入区 + 参考图 */}
        <div className="flex items-start gap-2">
          {mode === "image_edit" ? (
            <div className="shrink-0">
              {reference.previewUrl ? (
                <div className="group relative h-[52px] w-[52px] overflow-hidden rounded-lg border border-edge">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={reference.previewUrl} alt="参考图" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => reference.clear()}
                    title="移除参考图"
                    className="absolute inset-0 flex items-center justify-center bg-black/55 text-white opacity-0 transition group-hover:opacity-100"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
                      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex h-[52px] w-[52px] flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-edge text-muted transition hover:border-accent/50 hover:text-accentSoft"
                  title="点击或拖入图片"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                  <span className="text-[10px]">参考图</span>
                </button>
              )}
            </div>
          ) : (
            <div className="flex shrink-0 items-center gap-1.5">
              {genRefs.items.map((item) => (
                <div
                  key={item.key}
                  className="group relative h-[52px] w-[52px] overflow-hidden rounded-lg border border-edge"
                  title={item.name}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.previewUrl} alt={item.name} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => genRefs.remove(item.key)}
                    title="移除这张参考图"
                    className="absolute inset-0 flex items-center justify-center bg-black/55 text-white opacity-0 transition group-hover:opacity-100"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
                      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              ))}
              {genRefs.items.length < MAX_GENERATION_REFS ? (
                <button
                  type="button"
                  onClick={() => genFileRef.current?.click()}
                  title="可选：加 1–2 张参考图，只参考构图，出图尺寸仍按右下角设置"
                  className="flex h-[52px] w-[52px] flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-edge text-muted transition hover:border-accent/50 hover:text-accentSoft"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                  <span className="text-[10px]">参考图?</span>
                </button>
              ) : null}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSubmit) {
                submit.mutate({ text: prompt, mode });
              }
            }}
            rows={1}
            placeholder={
              mode === "image_edit"
                ? "描述要改成什么样，例如 same scene but at night, moonlight"
                : genRefs.items.length > 0
                  ? "描述想让它变成什么样，例如 same teapot, now on a stone table in an autumn garden"
                  : "输入你想要的画面，中文描述也可以，英文通常更稳"
            }
            className="scroll-thin min-h-[52px] flex-1 resize-none bg-transparent px-1 py-2 text-sm leading-relaxed text-ink outline-none placeholder:text-muted/60"
          />
        </div>

        {/* 高级设置（默认折叠） */}
        {advancedOpen ? (
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
                        seedMode === option.key ? "bg-accent/20 text-accentSoft" : "text-muted hover:text-ink",
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
                  placeholder="不希望出现的元素，例如 blurry, watermark, text"
                  className="field h-7 px-2 py-0 text-[11px]"
                />
              </label>
            ) : null}
          </div>
        ) : null}

        {/* 参数栏 + 生成 */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Popover label={<span>{activeModel?.label ?? "模型"}</span>} title="选择模型" width={250} active={!!modelId}>
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

          <Popover
            label={
              <span className="flex items-center gap-1">
                <PillIcon>
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" aria-hidden>
                    <rect x="4" y="4" width="16" height="16" rx="3" stroke="currentColor" strokeWidth="1.6" />
                    <path d="M4 14h16M14 4v16" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                </PillIcon>
                {sizeLabel}
              </span>
            }
            title="比例与分辨率"
            width={330}
          >
            {(close) => (
              <div className="flex flex-col gap-2.5">
                <div>
                  <p className="mb-1.5 text-[10px] text-muted">比例</p>
                  <div className="grid grid-cols-6 gap-1">
                    <button
                      type="button"
                      onClick={() => setCustomSize(width, height)}
                      title="自定义宽高"
                      className={`flex h-11 flex-col items-center justify-center gap-1 rounded-md border text-[10px] transition ${
                        ratioKey === "custom"
                          ? "border-accent/60 bg-accent/15 text-accentSoft"
                          : "border-edge/70 text-muted hover:border-edge hover:text-ink"
                      }`}
                    >
                      <span
                        className={`block rounded-[2px] border border-dashed ${
                          ratioKey === "custom" ? "border-accentSoft/70" : "border-muted/40"
                        }`}
                        style={{ width: 16, height: 12 }}
                      />
                      自定义
                    </button>
                    {IMAGE_RATIOS.map((ratio) => {
                      const wide = ratio.w >= ratio.h;
                      return (
                        <button
                          key={ratio.key}
                          type="button"
                          onClick={() => setRatio(ratio.key)}
                          title={ratio.label}
                          className={`flex h-11 flex-col items-center justify-center gap-1 rounded-md border text-[10px] transition ${
                            ratioKey === ratio.key
                              ? "border-accent/60 bg-accent/15 text-accentSoft"
                              : "border-edge/70 text-muted hover:border-edge hover:text-ink"
                          }`}
                        >
                          <span
                            className={`block rounded-[2px] border ${
                              ratioKey === ratio.key ? "border-accentSoft/70" : "border-muted/40"
                            }`}
                            style={
                              wide
                                ? { width: 18, height: Math.max(6, Math.round((18 * ratio.h) / ratio.w)) }
                                : { width: Math.max(6, Math.round((18 * ratio.w) / ratio.h)), height: 18 }
                            }
                          />
                          {ratio.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <p className="mb-1.5 text-[10px] text-muted">分辨率</p>
                  <div className="grid grid-cols-4 gap-1">
                    {IMAGE_TIERS.map((tier) => (
                      <button
                        key={tier.key}
                        type="button"
                        onClick={() => setTier(tier.key)}
                        className={`whitespace-nowrap rounded-md border py-1.5 text-[11px] transition ${
                          tierKey === tier.key
                            ? "border-accent/60 bg-accent/15 text-accentSoft"
                            : "border-edge/70 text-muted hover:border-edge hover:text-ink"
                        }`}
                      >
                        {tier.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between border-t border-edge/70 pt-2 text-[10px] text-muted">
                  <span>
                    {width} × {height} · {megapixels(width, height)}
                  </span>
                  <button
                    type="button"
                    onClick={close}
                    className="rounded px-1.5 py-0.5 text-accentSoft hover:bg-white/5"
                  >
                    完成
                  </button>
                </div>

                {ratioKey === "custom" ? (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-1">
                      <input
                        value={width}
                        onChange={(event) => setCustomSize(Number(event.target.value) || 0, height)}
                        inputMode="numeric"
                        aria-label="宽度"
                        className="field h-7 flex-1 px-2 py-0 text-[11px]"
                      />
                      <span className="text-muted">×</span>
                      <input
                        value={height}
                        onChange={(event) => setCustomSize(width, Number(event.target.value) || 0)}
                        inputMode="numeric"
                        aria-label="高度"
                        className="field h-7 flex-1 px-2 py-0 text-[11px]"
                      />
                    </div>
                    <p className="text-[10px] leading-tight text-muted/70">
                      宽高会自动对齐到 16 的倍数，长边上限 2560
                    </p>
                  </div>
                ) : null}
              </div>
            )}
          </Popover>

          <Popover
            label={<span>数量 {count}</span>}
            title={`每批生成张数（最多 8 张，各自独立 seed、串行执行）`}
            width={80}
          >
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

          <button
            type="button"
            onClick={() => setAdvancedOpen(!advancedOpen)}
            className={[
              "pill",
              advancedOpen ? "border-accent/50 bg-accent/12 text-accentSoft" : "",
            ].join(" ")}
            title="高级设置"
          >
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" aria-hidden>
              <path d="M5 7h14M8 12h8M11 17h2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            高级
          </button>

          <span className="ml-auto text-[11px] text-muted/60">
            {mode === "image_edit"
              ? "输出比例跟随参考图"
              : genRefs.items.length > 0
                ? `参考图 ${genRefs.items.length} 张 · ${width}×${height}`
                : `${width}×${height}`}
          </span>

          <button
            type="button"
            onClick={() => submit.mutate({ text: prompt, mode })}
            disabled={!canSubmit}
            className="btn-primary ml-2 min-w-[104px]"
          >
            {submit.isPending ? (
              <>
                <span className="h-3 w-3 animate-spin rounded-full border border-white/70 border-t-transparent" />
                提交中
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
                  <path d="m5 12 5 5 9-10" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {mode === "image_edit" ? `编辑出图 ${count} 张` : `生成 ${count} 张`}
              </>
            )}
          </button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(event) => {
            handleFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <input
          ref={genFileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="hidden"
          onChange={(event) => {
            handleFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

