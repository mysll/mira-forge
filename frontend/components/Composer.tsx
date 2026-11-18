"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import CountMenu from "@/components/CountMenu";
import ImagePicker from "@/components/ImagePicker";
import MaskEditor from "@/components/MaskEditor";
import Popover from "@/components/Popover";
import SlotMenu from "@/components/SlotMenu";
import {
  createEditGeneration,
  createGeneration,
  createImageToImageGeneration,
  imageAsFile,
  imageFileUrl,
} from "@/lib/api";
import { IMAGE_RATIOS, IMAGE_TIERS, megapixels } from "@/lib/size";
import { useComposerStore } from "@/stores/composer";
import { MAX_GENERATION_REFS, useGenerationRefStore } from "@/stores/generationRefs";
import { MAX_EDIT_REFS, useReferenceStore } from "@/stores/reference";
import type { GenerationCreatePayload, ImageBrief, ModelInfo } from "@/types/api";

type Props = {
  models: ModelInfo[];
  onToast: (message: string) => void;
};

const COUNT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];

/** 图片编辑的图片槽：index 0 定结构，index 1 是可选参考。 */
type SlotTarget = { kind: "edit"; index: number } | { kind: "gen" };

function PillIcon({ children }: { children: React.ReactNode }) {
  return <span className="text-muted">{children}</span>;
}

export default function Composer({ models, onToast }: Props) {
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const genFileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [slotMenu, setSlotMenu] = useState<SlotTarget | null>(null);
  const [picking, setPicking] = useState<SlotTarget | null>(null);
  const [maskEditing, setMaskEditing] = useState(false);
  /** 上一次第 1 张参考图的 key：换了图就把遮罩丢掉（遮罩是对着这张图画出来的）。 */
  const maskSourceKey = useRef<string | null>(null);
  /** 本次「从本机上传」要落到哪个槽：点空槽时记下来，选完文件再消费。 */
  const pendingSlot = useRef<number | undefined>(undefined);

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
  const mask = useComposerStore((state) => state.mask);
  const setMask = useComposerStore((state) => state.setMask);
  const clearMask = useComposerStore((state) => state.clearMask);
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

  // 遮罩是对着第 1 张参考图画的：换图就作废，别把旧遮罩套到新图上
  const firstRefKey = reference.items[0]?.key ?? null;
  useEffect(() => {
    if (maskSourceKey.current !== null && maskSourceKey.current !== firstRefKey) {
      clearMask();
    }
    maskSourceKey.current = firstRefKey;
  }, [firstRefKey, clearMask]);

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

      const items = reference.items;
      if (items.length === 0) {
        throw new Error("图片编辑需要 1 张参考图");
      }
      // 顺序即语义：第 1 张定结构，第 2 张是服装 / 材质参考
      const form = buildForm();
      for (const item of items) {
        const file =
          item.source.kind === "file" ? item.source.file : await imageAsFile(item.source.id);
        form.append("images", file);
      }
      // 有遮罩就带上去：后端据此换成局部编辑（只重绘遮罩里的地方）
      if (mask) {
        form.append("mask", mask.file);
      }
      return createEditGeneration(form);
    },
    onSuccess: (created, variables) => {
      // 提交成功即清空输入框（同模式下、且没被改写成别的句子）
      if (mode === variables.mode && prompts[variables.mode] === variables.text) {
        setPrompt("");
      }
      // 参考图是一次性输入：这一单已经把它们发出去了，留着只会让下一单重复带图
      reference.clear();
      genRefs.clear();
      clearMask();
      setSlotMenu(null);
      setPicking(null);
      onToast(created.generation_type === "image_to_image" ? "已提交，参考图已生效" : "已提交，正在排队生成");
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
    (mode === "text_to_image" || reference.items.length > 0) &&
    !submit.isPending;

  // 点开小菜单后，点别处/Esc 收起
  useEffect(() => {
    if (!slotMenu) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("[data-slot]")) {
        setSlotMenu(null);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSlotMenu(null);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [slotMenu]);

  // 资产库里选一张：编辑模式放进当前空槽，生成模式追加进参考图列表
  const pickAsset = async (image: ImageBrief) => {
    const target = picking;
    setPicking(null);
    if (target?.kind === "edit") {
      reference.putImage({ id: image.id, url: imageFileUrl(image) }, target.index);
      return;
    }
    try {
      const file = await imageAsFile(image.id);
      const added = genRefs.addFiles([file]);
      if (added === 0) {
        onToast(`最多 ${MAX_GENERATION_REFS} 张参考图，多出的没有加入`);
      }
    } catch {
      onToast("读取这张图失败，请重试");
    }
  };

  const handleFiles = (files: FileList | File[] | null | undefined, into?: number) => {
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
      const placed = reference.putFiles(accepted, into);
      if (placed < accepted.length) {
        onToast(`图片编辑最多 ${MAX_EDIT_REFS} 张：第 1 张定结构，第 2 张可选`);
      }
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
            <div className="flex shrink-0 items-center gap-1.5">
              {reference.items.map((item, index) => (
                <div key={item.key} className="relative" data-slot title={item.name}>
                  <div className="group relative h-[52px] w-[52px] overflow-hidden rounded-lg border border-edge">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={item.previewUrl}
                      alt={index === 0 ? "参考图" : "可选参考图"}
                      className="h-full w-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setSlotMenu(
                          slotMenu?.kind === "edit" && slotMenu.index === index
                            ? null
                            : { kind: "edit", index },
                        )
                      }
                      title={index === 0 ? "更换参考图" : "更换这张可选参考图"}
                      className="absolute inset-0 flex items-center justify-center bg-black/55 text-white opacity-0 transition group-hover:opacity-100"
                    >
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
                        <path
                          d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20Z"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => reference.removeAt(index)}
                      title="移除这张"
                      className="absolute right-0.5 top-0.5 hidden h-4 w-4 items-center justify-center rounded bg-black/70 text-[10px] text-white group-hover:flex"
                    >
                      ×
                    </button>
                    {index === 0 ? (
                      <button
                        type="button"
                        onClick={() => setMaskEditing(true)}
                        title="画遮罩：只有涂到的地方会被重绘"
                        className="absolute bottom-0 left-0 hidden items-center gap-0.5 bg-black/70 px-1 py-0.5 text-[9px] text-white group-hover:flex"
                        data-mask-button
                      >
                        <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" aria-hidden>
                          <path
                            d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20Z"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinejoin="round"
                          />
                        </svg>
                        遮罩
                      </button>
                    ) : null}
                  </div>
                  <span className="absolute -bottom-4 left-0 text-[9px] text-muted/70">
                    {index === 0 ? "结构" : "参考"}
                  </span>
                  <SlotMenu
                    open={slotMenu?.kind === "edit" && slotMenu.index === index}
                    onUpload={() => {
                      setSlotMenu(null);
                      fileRef.current?.click();
                      pendingSlot.current = index;
                    }}
                    onPickAsset={() => {
                      setSlotMenu(null);
                      setPicking({ kind: "edit", index });
                    }}
                  />
                </div>
              ))}
              {mask ? (
                <div
                  className="relative"
                  data-slot
                  data-mask-slot
                  title={`遮罩 ${mask.width}×${mask.height}：只有涂过的地方会被重绘`}
                >
                  <div className="group relative h-[52px] w-[52px] overflow-hidden rounded-lg border border-accent/60">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={mask.overlayUrl} alt="遮罩" className="h-full w-full object-cover" />
                    <button
                      type="button"
                      onClick={() => setMaskEditing(true)}
                      title="重新画遮罩"
                      className="absolute inset-0 flex items-center justify-center bg-black/55 text-white opacity-0 transition group-hover:opacity-100"
                    >
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
                        <path
                          d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20Z"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => clearMask()}
                      title="移除遮罩（改回普通图片编辑）"
                      className="absolute right-0.5 top-0.5 hidden h-4 w-4 items-center justify-center rounded bg-black/70 text-[10px] text-white group-hover:flex"
                    >
                      ×
                    </button>
                  </div>
                  <span className="absolute -bottom-4 left-0 text-[9px] text-accentSoft/80">
                    遮罩
                  </span>
                </div>
              ) : null}
              {reference.items.length < MAX_EDIT_REFS ? (
                <div className="relative" data-slot>
                  <button
                    type="button"
                    onClick={() =>
                      setSlotMenu(
                        slotMenu?.kind === "edit" && slotMenu.index === reference.items.length
                          ? null
                          : { kind: "edit", index: reference.items.length },
                      )
                    }
                    className={`flex h-[52px] w-[52px] flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed transition ${
                      slotMenu?.kind === "edit" && slotMenu.index === reference.items.length
                        ? "border-accent/60 text-accentSoft"
                        : "border-edge text-muted hover:border-accent/50 hover:text-accentSoft"
                    }`}
                    title={
                      reference.items.length === 0
                        ? "第 1 张：要被编辑的画面（定结构、比例、构图）"
                        : "第 2 张（可选）：服装 / 材质参考，只影响条件"
                    }
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
                      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                    <span className="text-[10px]">
                      {reference.items.length === 0 ? "参考图" : "再 1 张?"}
                    </span>
                  </button>
                  <SlotMenu
                    open={slotMenu?.kind === "edit" && slotMenu.index === reference.items.length}
                    onUpload={() => {
                      const index = reference.items.length;
                      setSlotMenu(null);
                      pendingSlot.current = index;
                      fileRef.current?.click();
                    }}
                    onPickAsset={() => {
                      setSlotMenu(null);
                      setPicking({ kind: "edit", index: reference.items.length });
                    }}
                  />
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex shrink-0 items-center gap-1.5">
              {genRefs.items.map((item) => (
                <div
                  key={item.key}
                  className="group relative h-[52px] w-[52px] overflow-hidden rounded-lg border border-edge"
                  title={item.name}
                  data-slot
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
                <div className="relative" data-slot>
                  <button
                    type="button"
                    onClick={() => setSlotMenu(slotMenu?.kind === "gen" ? null : { kind: "gen" })}
                    title="可选：加 1–2 张参考图，只参考构图，出图尺寸仍按右下角设置"
                    className={`flex h-[52px] w-[52px] flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed transition ${
                      slotMenu?.kind === "gen"
                        ? "border-accent/60 text-accentSoft"
                        : "border-edge text-muted hover:border-accent/50 hover:text-accentSoft"
                    }`}
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
                      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                    <span className="text-[10px]">参考图?</span>
                  </button>
                  <SlotMenu
                    open={slotMenu?.kind === "gen"}
                    onUpload={() => {
                      setSlotMenu(null);
                      genFileRef.current?.click();
                    }}
                    onPickAsset={() => {
                      setSlotMenu(null);
                      setPicking({ kind: "gen" });
                    }}
                  />
                </div>
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
                ? reference.items.length > 1
                  ? "只描述要改的部分，例如 把服装换成第二张图的样式，其余保持不变"
                  : "只描述要改的部分，例如 换成夜景，加一层月光"
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
          multiple
          className="hidden"
          onChange={(event) => {
            const into = pendingSlot.current;
            pendingSlot.current = undefined;
            handleFiles(event.target.files, into);
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

        <MaskEditor
          open={maskEditing && reference.items.length > 0}
          imageUrl={reference.items[0]?.previewUrl ?? ""}
          initialMaskUrl={mask?.maskUrl ?? null}
          onClose={() => setMaskEditing(false)}
          onApply={(result) => {
            setMask(result);
            setMaskEditing(false);
            onToast("遮罩已就绪：这一单只重绘涂到的地方");
          }}
        />

        <ImagePicker
          open={picking !== null}
          title={picking?.kind === "edit" ? "选参考图（编辑）" : "加参考图（生成）"}
          hint={
            picking?.kind === "edit"
              ? picking.index === 0
                ? "第 1 张决定被编辑的画面：定结构、比例与构图"
                : "第 2 张可选：例如只想借它的服装、材质或配色"
              : `最多 ${MAX_GENERATION_REFS} 张，只参考构图与材质，出图尺寸仍按右下角设置`
          }
          onClose={() => setPicking(null)}
          onPick={pickAsset}
          onUpload={() => {
            const target = picking;
            setPicking(null);
            if (target?.kind === "edit") {
              pendingSlot.current = target.index;
              fileRef.current?.click();
            } else {
              genFileRef.current?.click();
            }
          }}
        />
      </div>
    </div>
  );
}

