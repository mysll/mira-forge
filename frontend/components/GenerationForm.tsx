"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { createGeneration } from "@/lib/api";
import type { GenerationType, ModelInfo } from "@/types/api";

const COUNT_PRESETS = [1, 2, 4, 6, 8];

type Ratio = { key: string; label: string; w: number; h: number };

const RATIOS: Ratio[] = [
  { key: "1:1", label: "1:1 方图", w: 1, h: 1 },
  { key: "4:3", label: "4:3 横图", w: 4, h: 3 },
  { key: "3:2", label: "3:2 横图", w: 3, h: 2 },
  { key: "16:9", label: "16:9 宽屏", w: 16, h: 9 },
  { key: "3:4", label: "3:4 竖图", w: 3, h: 4 },
  { key: "2:3", label: "2:3 竖图", w: 2, h: 3 },
  { key: "9:16", label: "9:16 竖屏", w: 9, h: 16 },
];

/** 分辨率按"长边"给，短边按比例算出来后对齐到 16 的倍数（VAE 下采样要求）。 */
const LONG_EDGES = [768, 1024, 1328, 1536];

function snap(value: number): number {
  return Math.max(64, Math.round(value / 16) * 16);
}

function sizeFor(ratio: Ratio, longEdge: number): [number, number] {
  if (ratio.w >= ratio.h) {
    return [snap(longEdge), snap((longEdge * ratio.h) / ratio.w)];
  }
  return [snap((longEdge * ratio.w) / ratio.h), snap(longEdge)];
}

type Props = {
  models: ModelInfo[];
};

export function GenerationForm({ models }: Props) {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState(
    () => models.find((model) => model.is_default)?.id ?? models[0]?.id ?? "",
  );
  const [generationType, setGenerationType] = useState<GenerationType>("text_to_image");
  const [ratioKey, setRatioKey] = useState("1:1");
  const [longEdge, setLongEdge] = useState(1024);
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [count, setCount] = useState(1);

  const selected = useMemo(
    () => models.find((model) => model.id === modelId) ?? models[0],
    [modelId, models],
  );
  const target = selected?.workflows.find((workflow) => workflow.type === generationType);

  const mutation = useMutation({
    mutationFn: createGeneration,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["generations"] });
      setPrompt("");
    },
  });

  if (!selected) {
    return (
      <section className="card">
        <p className="text-xs text-rose-400">后端未返回任何模型，请检查 workflow_configs/registry.yaml。</p>
      </section>
    );
  }

  const editDisabled = selected.workflows.every((workflow) => workflow.type !== "image_edit");

  function applyPreset(nextRatioKey: string, nextLongEdge: number) {
    const ratio = RATIOS.find((item) => item.key === nextRatioKey) ?? RATIOS[0];
    const edge = nextLongEdge > 0 ? nextLongEdge : 1024;
    const [nextWidth, nextHeight] = sizeFor(ratio, edge);
    setRatioKey(nextRatioKey);
    setLongEdge(edge);
    setWidth(nextWidth);
    setHeight(nextHeight);
  }

  const manualSize = !LONG_EDGES.includes(longEdge);

  return (
    <section className="card">
      <h2 className="mb-4 text-sm font-semibold tracking-wide text-slate-200">新建生成</h2>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate({
            prompt,
            model: selected.id,
            generation_type: generationType,
            width: generationType === "text_to_image" ? width : undefined,
            height: generationType === "text_to_image" ? height : undefined,
            count,
          });
        }}
        className="space-y-4"
      >
        <div>
          <label className="label" htmlFor="prompt">
            提示词
          </label>
          <textarea
            id="prompt"
            className="field h-24 resize-y"
            placeholder="描述你想要的画面…"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            required
          />
        </div>

        {/* 尺寸面板：贴着提示词输入框底部，比例 + 长边分辨率 */}
        <div className="rounded-lg border border-edge/70 bg-black/20 p-3">
          <div className="flex items-baseline justify-between">
            <span className="label mb-0">出图尺寸</span>
            <span className="font-mono text-[11px] text-slate-400">
              {width} × {height}
              <span className="ml-2 text-slate-600">
                {((width * height) / 1_000_000).toFixed(2)} MP
              </span>
            </span>
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {RATIOS.map((ratio) => (
              <button
                key={ratio.key}
                type="button"
                onClick={() => applyPreset(ratio.key, longEdge)}
                className={`rounded-md border px-2 py-1 text-[11px] transition ${
                  ratioKey === ratio.key && !manualSize
                    ? "border-sky-500/60 bg-sky-500/10 text-sky-300"
                    : "border-edge text-slate-400 hover:border-slate-600"
                }`}
              >
                {ratio.label}
              </button>
            ))}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[10px] text-slate-500">长边</span>
            {LONG_EDGES.map((edge) => (
              <button
                key={edge}
                type="button"
                onClick={() => applyPreset(ratioKey, edge)}
                className={`rounded-md border px-2 py-1 font-mono text-[11px] transition ${
                  longEdge === edge && !manualSize
                    ? "border-sky-500/60 bg-sky-500/10 text-sky-300"
                    : "border-edge text-slate-400 hover:border-slate-600"
                }`}
              >
                {edge}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setLongEdge(0)}
              className={`rounded-md border px-2 py-1 text-[11px] transition ${
                manualSize
                  ? "border-sky-500/60 bg-sky-500/10 text-sky-300"
                  : "border-edge text-slate-400 hover:border-slate-600"
              }`}
            >
              自定义
            </button>
          </div>

          {manualSize && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div>
                <label className="label" htmlFor="width">
                  宽度
                </label>
                <input
                  id="width"
                  type="number"
                  min={64}
                  max={4096}
                  step={16}
                  className="field"
                  value={width}
                  onChange={(event) => setWidth(Number(event.target.value))}
                />
              </div>
              <div>
                <label className="label" htmlFor="height">
                  高度
                </label>
                <input
                  id="height"
                  type="number"
                  min={64}
                  max={4096}
                  step={16}
                  className="field"
                  value={height}
                  onChange={(event) => setHeight(Number(event.target.value))}
                />
              </div>
            </div>
          )}

          {generationType === "image_edit" && (
            <p className="mt-2 text-[11px] text-amber-400/90">
              编辑时输出比例跟随参考图，这里的分辨率决定像素量级。
            </p>
          )}
        </div>

        <div>
          <span className="label">任务类型</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setGenerationType("text_to_image")}
              className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                generationType === "text_to_image"
                  ? "border-sky-500/60 bg-sky-500/10 text-sky-300"
                  : "border-edge text-slate-400 hover:border-slate-600"
              }`}
            >
              文生图
            </button>
            <button
              type="button"
              disabled={editDisabled}
              title="图片编辑需要上传参考图，P4 开放"
              onClick={() => setGenerationType("image_edit")}
              className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                generationType === "image_edit"
                  ? "border-sky-500/60 bg-sky-500/10 text-sky-300"
                  : "border-edge text-slate-500"
              } disabled:cursor-not-allowed disabled:opacity-50`}
            >
              图片编辑（P4）
            </button>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="model">
            模型
          </label>
          <select
            id="model"
            className="field"
            value={selected.id}
            onChange={(event) => setModelId(event.target.value)}
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
            {selected.description}
          </p>
        </div>

        <div className="rounded-lg border border-edge/70 bg-black/20 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
          {selected.capabilities.exposes_steps ? (
            <span>步数 {String(selected.defaults.steps ?? "—")}（可调）· </span>
          ) : (
            <span>步数固定 {String(selected.defaults.steps ?? "—")} 步，由 sigma 表决定，不可调 · </span>
          )}
          {selected.capabilities.exposes_cfg ? (
            <span>cfg {String(selected.defaults.cfg ?? "—")} · </span>
          ) : (
            <span>cfg 固定 · </span>
          )}
          <span>采样器 {String(selected.defaults.sampler ?? "—")}</span>
        </div>

        <div>
          <span className="label">生成数量</span>
          <div className="flex flex-wrap gap-2">
            {COUNT_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setCount(preset)}
                className={`h-9 w-12 rounded-lg border text-xs transition ${
                  count === preset
                    ? "border-sky-500/60 bg-sky-500/10 text-sky-300"
                    : "border-edge text-slate-400 hover:border-slate-600"
                }`}
              >
                {preset}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">
            每张图独立 task + 独立 seed，按 WORKER_CONCURRENCY=1 串行执行。
          </p>
        </div>

        {target && !target.available && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-300/90">
            工作流 JSON 尚未落地（{target.json_path}）。本次记录会以 pending 状态入库，
            <strong>不会产生图片</strong>。
          </p>
        )}

        {mutation.isError && (
          <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {mutation.error instanceof Error ? mutation.error.message : "提交失败"}
          </p>
        )}

        <button type="submit" className="btn-primary w-full" disabled={mutation.isPending || !prompt.trim()}>
          {mutation.isPending ? "提交中…" : `创建 ${count} 个任务`}
        </button>
      </form>
    </section>
  );
}
