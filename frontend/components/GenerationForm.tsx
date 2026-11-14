"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { createGeneration } from "@/lib/api";
import type { GenerationType, ModelInfo } from "@/types/api";

const COUNT_PRESETS = [1, 2, 4, 6, 8];

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

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
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

          <div>
            <label className="label" htmlFor="width">
              宽度
            </label>
            <input
              id="width"
              type="number"
              min={64}
              max={4096}
              step={32}
              className="field"
              value={width}
              disabled={generationType === "image_edit"}
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
              step={32}
              className="field"
              value={height}
              disabled={generationType === "image_edit"}
              onChange={(event) => setHeight(Number(event.target.value))}
            />
          </div>
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
          {generationType === "image_edit" && (
            <span className="text-amber-400/90"> · 编辑保持参考图尺寸，宽高不生效</span>
          )}
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
            <strong>不会产生图片</strong>，P2 接入后即可执行。
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
