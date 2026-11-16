"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import CountMenu from "@/components/CountMenu";
import ImagePicker from "@/components/ImagePicker";
import Popover from "@/components/Popover";
import SlotMenu from "@/components/SlotMenu";
import { createGeneration, createImageToVideoGeneration, imageAsFile, imageThumbnailUrl } from "@/lib/api";
import {
  VIDEO_DURATION_MAX,
  VIDEO_DURATION_MIN,
  VIDEO_DURATION_PRESETS,
  VIDEO_RATIOS,
  VIDEO_TIERS,
  clampDuration,
  videoSizeFor,
  videoWeight,
  VIDEO_WEIGHT_WARN,
  type VideoRatioKey,
} from "@/lib/videoSize";
import type { ImageBrief, ModelInfo } from "@/types/api";

/** 首帧 / 尾帧的来源：本机文件，或资产库里已经生成的一张图。 */
type FrameSource =
  | { kind: "file"; file: File }
  | { kind: "image"; imageId: number; preview: string };

/** 视频创作框：提示词 + 可选首帧 / 尾帧 + 比例 × 分辨率 + 时长。 */
export default function VideoComposer({
  models,
  onToast,
}: {
  models: ModelInfo[];
  onToast: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [modelId, setModelId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [ratioKey, setRatioKey] = useState<VideoRatioKey>("auto");
  const [tierKey, setTierKey] = useState("480p");
  const [duration, setDuration] = useState(5);
  const [count, setCount] = useState(1);
  const [first, setFirst] = useState<FrameSource | null>(null);
  const [last, setLast] = useState<FrameSource | null>(null);
  const [picking, setPicking] = useState<"first" | "last" | null>(null);
  const [menu, setMenu] = useState<"first" | "last" | null>(null);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);
  const lastInput = useRef<HTMLInputElement>(null);

  const model = useMemo(
    () => models.find((item) => item.id === modelId) ?? models[0],
    [modelId, models],
  );

  useEffect(() => {
    if (!modelId && models.length > 0) {
      setModelId(models[0].id);
    }
  }, [modelId, models]);

  // 快捷档优先用模型声明的，没声明就退回内置的 3/5/8/10
  const durationPresets = useMemo(() => {
    const declared = model?.capabilities.durations ?? [];
    const values = declared.length > 0 ? declared.map((value) => Math.round(value)) : VIDEO_DURATION_PRESETS;
    return Array.from(new Set(values)).sort((left, right) => left - right);
  }, [model?.capabilities.durations]);

  const durationMin = Math.round(Number(model?.capabilities.duration_min ?? VIDEO_DURATION_MIN));
  const durationMax = Math.round(Number(model?.capabilities.duration_max ?? VIDEO_DURATION_MAX));

  // 模型切换时把时长夹回它的区间
  useEffect(() => {
    setDuration((current) => {
      const next = clampDuration(current);
      return Math.min(durationMax, Math.max(durationMin, next));
    });
    // 只在模型变化时校正
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.id]);

  const fallback = {
    width: Number(model?.defaults?.width ?? 864),
    height: Number(model?.defaults?.height ?? 480),
  };
  const ratio = VIDEO_RATIOS.find((item) => item.key === ratioKey) ?? VIDEO_RATIOS[0];
  const tier = VIDEO_TIERS.find((item) => item.key === tierKey) ?? VIDEO_TIERS[0];
  const size = videoSizeFor(ratio, tier, fallback);
  const fps = Number(model?.defaults?.fps ?? 24);
  const weight = videoWeight(size.width, size.height, duration);
  // 1080p × 10 秒以上在 16GB 卡上很容易吃满，提前提示一句
  const heavy = weight > VIDEO_WEIGHT_WARN;

  // 数量：默认 1 条，最多 4 条（能力里没声明就按 4 兜底）
  const countOptions = useMemo(() => {
    const declared = model?.capabilities.count_options ?? [];
    const max = Math.max(1, Math.round(Number(model?.capabilities.max_count ?? 4)));
    const values = declared.length > 0 ? declared : [1, 2, 3, 4];
    return Array.from(new Set(values.map((value) => Math.round(value))))
      .filter((value) => value >= 1 && value <= max)
      .sort((left, right) => left - right);
  }, [model?.capabilities.count_options, model?.capabilities.max_count]);

  // 粗估每条要几分钟：480p 5 秒约 1 分钟，720p 约 2.7 分钟，1080p 更久
  const estimateMinutes = Math.max(1, Math.round((weight / 51) * 1.2));

  // 提示词框随内容长高，最多 200px
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) {
      return;
    }
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, [prompt]);

  const submit = useMutation({
    mutationFn: async (text: string) => {
      if (!model) {
        throw new Error("还没有可用的视频模型");
      }
      if (first || last) {
        const form = new FormData();
        form.set("prompt", text);
        form.set("model", model.id);
        form.set("duration_seconds", String(clampDuration(duration)));
        form.set("width", String(size.width));
        form.set("height", String(size.height));
        form.set("count", String(count));
        if (first) {
          form.append("files", await frameAsFile(first));
        }
        if (last) {
          form.append("files", await frameAsFile(last));
        }
        return createImageToVideoGeneration(form);
      }
      return createGeneration({
        prompt: text,
        model: model.id,
        generation_type: "text_to_video",
        count,
        duration_seconds: clampDuration(duration),
        fps,
        width: size.width,
        height: size.height,
      });
    },
    onSuccess: () => {
      onToast("已提交，视频排队生成中（单条约 1 分钟）");
      // 提交成功就清空输入：同一个提示词再来一条的情况很少，占着位置反而挡住下一次输入
      setPrompt("");
      setFirst(null);
      setLast(null);
      void queryClient.invalidateQueries({ queryKey: ["generations"] });
      window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["generations"] });
      }, 1500);
    },
    onError: (error: Error) => {
      onToast(error.message || "提交失败");
    },
  });

  const accept = (file: File | null | undefined) => {
    if (!file) {
      return;
    }
    if (!file.type.startsWith("image/")) {
      onToast("首帧 / 尾帧必须是图片");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      onToast("图片不能超过 20 MB");
      return;
    }
    const source: FrameSource = { kind: "file", file };
    if (first && !last) {
      setLast(source);
      return;
    }
    setFirst(source);
  };

  // 资产库里选一张当首帧 / 尾帧
  const pickFrame = (image: ImageBrief) => {
    const source: FrameSource = {
      kind: "image",
      imageId: image.id,
      preview: imageThumbnailUrl(image),
    };
    if (picking === "last") {
      setLast(source);
    } else {
      setFirst(source);
    }
    setPicking(null);
  };

  const openFilePicker = () => {
    const target = picking;
    setPicking(null);
    if (target === "last") {
      lastInput.current?.click();
    } else {
      firstInput.current?.click();
    }
  };

  // 点开的是小菜单，不是挑图面板——资产列表只在真的选「从资产」时才拉
  useEffect(() => {
    if (!menu) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("[data-frame-slot]")) {
        setMenu(null);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(null);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const disabled = !prompt.trim() || !model || submit.isPending;

  const go = () => {
    if (disabled) {
      return;
    }
    submit.mutate(prompt.trim());
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-4 pb-4">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 -top-32 bg-gradient-to-t from-bg via-bg via-70% to-transparent" />
      <div
        className={`pointer-events-auto relative mx-auto flex max-w-[1180px] flex-col gap-2 rounded-xl2 border bg-surface/92 p-3 shadow-pop backdrop-blur-2xl transition ${
          dragging ? "border-accent/70 ring-2 ring-accent/20" : "border-edge"
        }`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const files = Array.from(event.dataTransfer.files);
          if (files[0]) {
            setFirst({ kind: "file", file: files[0] });
          }
          if (files[1]) {
            setLast({ kind: "file", file: files[1] });
          }
        }}
      >
        {/* 首帧 / 尾帧：两个都空就是普通文生视频 */}
        <div className="flex items-center gap-2">
          <FrameSlot
            label="首帧"
            source={first}
            open={menu === "first"}
            onPick={() => setMenu(menu === "first" ? null : "first")}
            onClear={() => setFirst(null)}
            onUpload={() => {
              setMenu(null);
              firstInput.current?.click();
            }}
            onPickAsset={() => {
              setMenu(null);
              setPicking("first");
            }}
          />
          <FrameSlot
            label="尾帧"
            source={last}
            open={menu === "last"}
            onPick={() => setMenu(menu === "last" ? null : "last")}
            onClear={() => setLast(null)}
            onUpload={() => {
              setMenu(null);
              lastInput.current?.click();
            }}
            onPickAsset={() => {
              setMenu(null);
              setPicking("last");
            }}
          />
          <p className="text-[11px] leading-snug text-muted">
            {first || last
              ? "首帧决定开头画面，尾帧决定结尾；只给一张就是首帧"
              : "可选：首帧 / 尾帧可以从资产里挑，也可以拖入本机图片；都不传就是文生视频"}
          </p>
          <input
            ref={firstInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(event) => {
              accept(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <input
            ref={lastInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(event) => {
              accept(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>

        <ImagePicker
          open={picking !== null}
          title={picking === "last" ? "选尾帧" : "选首帧"}
          hint="从已生成的作品里挑一张，或者上传本机图片"
          onClose={() => setPicking(null)}
          onPick={pickFrame}
          onUpload={openFilePicker}
        />

        <div className="flex items-end gap-3">
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                go();
              }
            }}
            rows={1}
            placeholder={
              first || last
                ? "描述这一段要发生什么（镜头运动、动作、光线变化）"
                : "描述想拍的镜头：主体、动作、镜头运动、光线"
            }
            className="min-h-[52px] flex-1 resize-none bg-transparent text-sm leading-relaxed text-ink outline-none placeholder:text-muted/60"
          />

          <div className="flex shrink-0 items-center gap-1 pb-1">
            {/* 尺寸：比例 × 分辨率档，和图片创作框的面板同一套信息密度 */}
            <Popover label={size.label} title="尺寸" width={330}>
              {(close) => (
                <div className="flex flex-col gap-2.5">
                  <div>
                    <p className="mb-1.5 text-[10px] text-muted">比例</p>
                    <div className="grid grid-cols-7 gap-1">
                      {VIDEO_RATIOS.map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          onClick={() => setRatioKey(item.key)}
                          title={item.key === "auto" ? "跟随模型默认" : item.label}
                          className={`flex h-11 flex-col items-center justify-center gap-1 rounded-md border text-[10px] transition ${
                            item.key === ratioKey
                              ? "border-accent/60 bg-accent/15 text-accentSoft"
                              : "border-edge/70 text-muted hover:border-edge hover:text-ink"
                          }`}
                        >
                          <span
                            className={`block rounded-[2px] border ${
                              item.key === ratioKey ? "border-accentSoft/70" : "border-muted/40"
                            }`}
                            style={
                              item.key === "auto"
                                ? { width: 16, height: 12, borderStyle: "dashed" }
                                : item.value >= 1
                                  ? { width: 18, height: Math.max(6, Math.round(18 / item.value)) }
                                  : { width: Math.max(6, Math.round(18 * item.value)), height: 18 }
                            }
                          />
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="mb-1.5 text-[10px] text-muted">分辨率</p>
                    <div className="grid grid-cols-3 gap-1">
                      {VIDEO_TIERS.map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          onClick={() => setTierKey(item.key)}
                          className={`whitespace-nowrap rounded-md border py-1.5 text-[11px] transition ${
                            item.key === tierKey
                              ? "border-accent/60 bg-accent/15 text-accentSoft"
                              : "border-edge/70 text-muted hover:border-edge hover:text-ink"
                          }`}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between border-t border-edge/70 pt-2 text-[10px] text-muted">
                    <span>
                      {size.width}×{size.height} · {Math.round(fps)}fps
                    </span>
                    <button
                      type="button"
                      onClick={close}
                      className="rounded px-1.5 py-0.5 text-accentSoft hover:bg-white/5"
                    >
                      完成
                    </button>
                  </div>
                </div>
              )}
            </Popover>

            {/* 时长：3/5/8/10 快捷档 + 1–15 秒滑块 */}
            <Popover label={`${duration} 秒`} title="时长" width={280}>
              {(close) => (
                <div className="grid gap-2.5">
                  <div className="grid grid-cols-4 gap-1">
                    {durationPresets.map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setDuration(value)}
                        className={`rounded-md border py-1.5 text-[11px] transition ${
                          value === duration
                            ? "border-accent/60 bg-accent/15 text-accentSoft"
                            : "border-edge/70 text-muted hover:border-edge hover:text-ink"
                        }`}
                      >
                        {value} 秒
                      </button>
                    ))}
                  </div>

                  <div>
                    <div className="mb-1 flex items-center justify-between text-[10px] text-muted">
                      <span>自定义</span>
                      <span className="text-ink/80">{duration} 秒</span>
                    </div>
                    <input
                      type="range"
                      min={VIDEO_DURATION_MIN}
                      max={VIDEO_DURATION_MAX}
                      step={1}
                      value={duration}
                      onChange={(event) => setDuration(Number(event.target.value))}
                      className="h-1 w-full cursor-pointer appearance-none rounded-full bg-edge accent-accent"
                    />
                    <div className="mt-1 flex justify-between text-[9px] text-muted/70">
                      <span>{VIDEO_DURATION_MIN} 秒</span>
                      <span>{VIDEO_DURATION_MAX} 秒</span>
                    </div>
                  </div>

                  {heavy ? (
                    <p className="rounded-md border border-warn/30 bg-warn/10 px-2 py-1.5 text-[10px] leading-relaxed text-warn">
                      这个组合偏重（{weight.toFixed(0)} MP·帧），16GB 显存可能要重试：建议 480p 或缩短时长。
                    </p>
                  ) : null}

                  <div className="flex items-center justify-between border-t border-edge/60 pt-2 text-[10px] text-muted">
                    <span>
                      {size.width}×{size.height} · {Math.max(5, Math.round(duration * fps))} 帧
                    </span>
                    <button
                      type="button"
                      onClick={() => close?.()}
                      className="rounded-md px-2 py-1 text-[10px] text-accentSoft hover:bg-white/5"
                    >
                      完成
                    </button>
                  </div>
                </div>
              )}
            </Popover>

            {/* 数量：视频一次最多 4 条，默认 1 条；和图片创作框共用同一个菜单样式 */}
            <Popover
              label={`${count} 条`}
              title={`串行生成，${count} 条约需 ${count * estimateMinutes} 分钟（最多 4 条）`}
              width={80}
            >
              {(close) => (
                <CountMenu
                  options={countOptions}
                  value={count}
                  unit="条"
                  onSelect={(value) => {
                    setCount(value);
                    close();
                  }}
                />
              )}
            </Popover>

            <Popover label={model?.label ?? "模型"} title="模型" width={240}>
              {(close) => (
                <div className="grid gap-0.5">
                  {models.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setModelId(item.id);
                        close();
                      }}
                      className={`rounded-md px-2 py-1.5 text-left text-xs ${
                        item.id === model?.id ? "bg-accent/15 text-accentSoft" : "text-ink/80 hover:bg-white/5"
                      }`}
                    >
                      <span className="block">{item.label}</span>
                      <span className="block text-[10px] text-muted">{item.description}</span>
                    </button>
                  ))}
                </div>
              )}
            </Popover>

            <span className="ml-1 text-[10px] text-muted/70">{Math.round(fps)}fps</span>
          </div>

          <button
            type="button"
            onClick={go}
            disabled={disabled}
            className="btn-primary mb-0.5 shrink-0 disabled:cursor-not-allowed disabled:opacity-40"
            title={prompt.trim() ? "提交（⌘/Ctrl + Enter）" : "先写点提示词"}
          >
            {submit.isPending ? "提交中…" : "生成视频"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 把首帧 / 尾帧统一成 File：资产里选的图先取回字节再当上传。 */
async function frameAsFile(source: FrameSource): Promise<File> {
  if (source.kind === "file") {
    return source.file;
  }
  return imageAsFile(source.imageId);
}

function FrameSlot({
  label,
  source,
  open,
  onPick,
  onClear,
  onUpload,
  onPickAsset,
}: {
  label: string;
  source: FrameSource | null;
  open: boolean;
  onPick: () => void;
  onClear: () => void;
  onUpload: () => void;
  onPickAsset: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!source) {
      setUrl(null);
      return;
    }
    if (source.kind === "image") {
      setUrl(source.preview);
      return;
    }
    const objectUrl = URL.createObjectURL(source.file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [source]);

  const menu = open ? (
    <SlotMenu open onUpload={onUpload} onPickAsset={onPickAsset} />
  ) : null;

  if (!url) {
    return (
      <div className="relative" data-frame-slot>
        <button
          type="button"
          onClick={onPick}
          title={`选择${label}：从本机上传，或从资产里挑一张`}
          className={`flex h-[52px] w-[52px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed text-[10px] transition ${
            open
              ? "border-accent/60 text-accentSoft"
              : "border-edge text-muted hover:border-accent/50 hover:text-accentSoft"
          }`}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {label}
        </button>
        {menu}
      </div>
    );
  }

  return (
    <div className="group relative shrink-0" data-frame-slot>
      <button
        type="button"
        onClick={onPick}
        title={`更换${label}：从本机上传，或从资产里挑一张`}
        className="relative block h-[52px] w-[52px] overflow-hidden rounded-lg border border-edge"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={label} className="h-full w-full object-cover" />
        <span className="absolute inset-x-0 bottom-0 bg-black/60 text-center text-[9px] text-white/90">{label}</span>
      </button>
      <button
        type="button"
        onClick={onClear}
        title={`移除${label}`}
        className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-edge bg-surface text-[10px] text-muted group-hover:flex hover:text-ink"
      >
        ×
      </button>
      {menu}
    </div>
  );
}




