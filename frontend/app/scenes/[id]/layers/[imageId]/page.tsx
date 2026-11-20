"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import Feed from "@/components/Feed";
import ImageDetail from "@/components/ImageDetail";
import LayerComposer from "@/components/LayerComposer";
import LLMChat from "@/components/LLMChat";
import ToastStack, { type ToastItem } from "@/components/ToastStack";
import { useImageActions } from "@/hooks/useImageActions";
import { useTaskEvents } from "@/hooks/useTaskEvents";
import { buildFeedSlots } from "@/lib/feed";
import {
  createLayerSet,
  deleteLayerSet,
  fetchGenerations,
  fetchImage,
  fetchLayerGenerations,
  fetchLayerSets,
  fetchModels,
  fetchScene,
  imageThumbnailUrl,
  renderAllLayers,
  renderLayer,
  updateLayer,
} from "@/lib/api";
import type {
  FeedItem,
  FeedSlot,
  GenerationRead,
  LayerRead,
  LayerSetRead,
} from "@/types/api";

const ACTIVE = new Set(["pending", "queued", "running"]);

/**
 * 分层工作台：源图固定为进来时那张场景图，一层一个页签。
 * 页签里是这个层出过的批次（信息流），底部输入框是这一层的提示词 + 生成按钮。
 */
export default function LayerWorkbenchPage() {
  useTaskEvents();
  const params = useParams<{ id: string; imageId: string }>();
  const sceneId = Number(params?.id ?? 0);
  const imageId = Number(params?.imageId ?? 0);
  const queryClient = useQueryClient();

  const [activeLayerId, setActiveLayerId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [detail, setDetail] = useState<FeedItem | null>(null);
  // 输入框默认收起，只占一行，点箭头再展开（省得挡住下面的信息流）
  const [composerCollapsed, setComposerCollapsed] = useState(true);
  const [showChat, setShowChat] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((text: string) => {
    setToasts((current) => [...current, { id: Date.now() + Math.random(), text }]);
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const sceneQuery = useQuery({
    queryKey: ["scenes", sceneId],
    queryFn: () => fetchScene(sceneId),
    enabled: sceneId > 0,
  });
  const imageQuery = useQuery({
    queryKey: ["image", imageId],
    queryFn: () => fetchImage(imageId),
    enabled: imageId > 0,
  });

  const modelsQuery = useQuery({ queryKey: ["models"], queryFn: fetchModels, staleTime: 60_000 });
  const editModels = useMemo(
    () =>
      (modelsQuery.data ?? []).filter(
        (model) =>
          model.capabilities.media !== "video" &&
          model.workflows.some((target) => target.type === "image_edit"),
      ),
    [modelsQuery.data],
  );
  const modelLabels = useMemo(
    () =>
      Object.fromEntries(
        (modelsQuery.data ?? []).map((model) => [model.id, model.label.replace(/^Qwen Image /, "Qwen ")]),
      ),
    [modelsQuery.data],
  );

  const setsQuery = useQuery({
    queryKey: ["layer-sets", sceneId],
    queryFn: () => fetchLayerSets(sceneId),
    enabled: sceneId > 0,
    refetchInterval: (q) =>
      q.state.data?.items.some((item) => item.status === "analyzing") ? 1500 : false,
  });

  // 这张图的分层方案：优先用最新一套**成功**的（失败的那套留着只是给人看原因），
  // 同一张图可以「重新分析」出多套，历史的不展示。
  const layerSet: LayerSetRead | null = useMemo(() => {
    const rows = (setsQuery.data?.items ?? []).filter(
      (item) => item.source_image_id === imageId,
    );
    return rows.find((item) => item.status === "planned") ?? rows[0] ?? null;
  }, [setsQuery.data, imageId]);

  const layers = layerSet?.layers ?? [];
  const activeLayer: LayerRead | null =
    layers.find((layer) => layer.id === activeLayerId) ?? layers[0] ?? null;

  // 提示词草稿：切页签、切回来都还在（失焦才写回后端）
  const prompt = activeLayer ? drafts[activeLayer.id] ?? activeLayer.prompt : "";

  const activeBusy = ACTIVE.has(layerSet?.status ?? "");

  const layerGenerationsQuery = useQuery({
    queryKey: ["layer-generations", activeLayer?.id ?? 0],
    queryFn: () => fetchLayerGenerations(activeLayer?.id ?? 0),
    enabled: Boolean(activeLayer?.id),
    refetchInterval: (q) => {
      const active = q.state.data?.items.some((item) => ACTIVE.has(item.status));
      return active ? 1500 : false;
    },
  });

  const generations: GenerationRead[] = layerGenerationsQuery.data?.items ?? [];
  const slots: FeedSlot[] = useMemo(() => buildFeedSlots(generations), [generations]);

  const actions = useImageActions({
    onToast: toast,
    onDeleted: (deletedId) => {
      if (detail?.image.id === deletedId) setDetail(null);
    },
    onEdited: () => setDetail(null),
  });

  const analyze = useMutation({
    mutationFn: (payload: {
      model: string;
      layer_count: number;
      count_per_layer: number;
      brief: string | null;
    }) =>
      createLayerSet(sceneId, {
        source_image_id: imageId,
        model: payload.model,
        layer_count: payload.layer_count,
        count_per_layer: payload.count_per_layer,
        brief: payload.brief,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["layer-sets", sceneId] });
      toast("开始分析，通常 1–3 分钟，过程会显示在下面");
    },
    onError: (error: Error) => toast(error.message),
  });

  const saveLayer = useMutation({
    mutationFn: (values: { layerId: number; prompt?: string; negative_prompt?: string }) => {
      const patch: { prompt?: string; negative_prompt?: string } = {};
      if (values.prompt !== undefined) patch.prompt = values.prompt;
      if (values.negative_prompt !== undefined) patch.negative_prompt = values.negative_prompt;
      return updateLayer(values.layerId, patch);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["layer-sets", sceneId] });
    },
    onError: (error: Error) => toast(error.message),
  });

  const render = useMutation({
    mutationFn: ({
      layer,
      values,
    }: {
      layer: LayerRead;
      values: {
        count: number;
        negative: string;
        model: string;
        seed: string;
        steps: string;
        cfg: string;
        sampler: string;
      };
    }) =>
      renderLayer(layer.id, {
        count: values.count,
        prompt: (drafts[layer.id] ?? layer.prompt).trim() || layer.prompt,
        negative_prompt: values.negative,
        model: values.model || layerSet?.model_name || null,
        seed: values.seed ? Number(values.seed) : null,
        steps: values.steps ? Number(values.steps) : null,
        cfg: values.cfg ? Number(values.cfg) : null,
        sampler: values.sampler || null,
        save_prompt: true,
      }),
    onSuccess: (generation, variables) => {
      const layer = variables.layer;
      setDrafts((current) => {
        const next = { ...current };
        delete next[layer.id];
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ["layer-generations", layer.id] });
      void queryClient.invalidateQueries({ queryKey: ["layer-sets", sceneId] });
      void queryClient.invalidateQueries({ queryKey: ["generations"] });
      void queryClient.invalidateQueries({ queryKey: ["scenes"] });
      toast(`L${layer.ord} ${layer.name}：已提交 ${generation.requested_count} 张`);
    },
    onError: (error: Error) => toast(error.message),
  });

  // 一次把整套方案的每一层都排进去（worker 单协程，一层接一层跑）
  const renderAll = useMutation({
    mutationFn: (setId: number) => renderAllLayers(setId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["layer-generations"] });
      void queryClient.invalidateQueries({ queryKey: ["layer-sets", sceneId] });
      void queryClient.invalidateQueries({ queryKey: ["generations"] });
      void queryClient.invalidateQueries({ queryKey: ["scenes"] });
      const parts = [`已排队 ${result.submitted} 层 · 共 ${result.images} 张`];
      if (result.skipped.length > 0) parts.push(`跳过 ${result.skipped.length} 层`);
      toast(parts.join("，"));
    },
    onError: (error: Error) => toast(error.message),
  });

  // 指定这一层导出用哪一张（一层只能有一张：再点另一张就换过去）
  const pickImage = useMutation({
    mutationFn: (variables: { layerId: number; imageId: number; same: boolean }) =>
      updateLayer(variables.layerId, {
        selected_image_id: variables.same ? null : variables.imageId,
      }),
    onSuccess: (_layer, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["layer-sets", sceneId] });
      if (variables.same) {
        toast("已改为「用最新的那张」");
      } else {
        const layer = layerSet?.layers.find((item) => item.id === variables.layerId);
        toast(`L${layer?.ord ?? ""} 导出时用这张`);
      }
    },
    onError: (error: Error) => toast(error.message),
  });

  const removeSet = useMutation({
    mutationFn: (setId: number) => deleteLayerSet(setId),
    onSuccess: () => {
      setActiveLayerId(null);
      setDrafts({});
      void queryClient.invalidateQueries({ queryKey: ["layer-sets", sceneId] });
      void queryClient.invalidateQueries({ queryKey: ["scene-layer-generations"] });
      toast("方案已删除，可以重新分析");
    },
    onError: (error: Error) => toast(error.message),
  });

  const scene = sceneQuery.data;
  const source = imageQuery.data;
  const analyzing = layerSet?.status === "analyzing";
  const failed = layerSet?.status === "failed";

  return (
    <>
      <header className="flex items-center gap-3 border-b border-edge/70 px-5 py-2.5">
        <Link
          href={`/scenes/${sceneId}`}
          className="shrink-0 text-xs text-muted transition hover:text-ink"
        >
          ← 场景
        </Link>
        <h1 className="truncate text-[13px] font-medium text-ink">
          {scene?.name ?? "…"} · 分层
        </h1>
        {source ? (
          <span className="shrink-0 text-[11px] text-muted/70">
            {source.width}×{source.height}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {layerSet && layerSet.status === "planned" && layers.length > 0 ? (
            <button
              type="button"
              disabled={renderAll.isPending}
              onClick={() => renderAll.mutate(layerSet.id)}
              title={`每层各生成 ${layerSet.count_per_layer || 1} 张`}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[11px] font-medium text-white transition hover:bg-accent/85 disabled:opacity-60"
            >
              {renderAll.isPending ? "正在排队…" : `生成所有层（${layers.length}）`}
            </button>
          ) : null}
          {layerSet && !analyzing ? (
            <button
              type="button"
              disabled={removeSet.isPending}
              onClick={() => removeSet.mutate(layerSet.id)}
              className="h-8 rounded-lg border border-edge bg-surface2 px-2.5 text-[11px] text-ink/85 transition hover:border-bad/50 hover:text-bad disabled:opacity-50"
            >
              重新分析
            </button>
          ) : null}
        </div>
      </header>

      {/* 源图固定：这一栏只展示，不给换 */}
      <div className="flex items-center gap-3 border-b border-edge/40 px-5 py-3">
        <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-edge bg-surface2">
          {source ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={imageThumbnailUrl(source)}
              alt={`源图 ${source.id}`}
              className="h-full w-full object-cover"
            />
          ) : null}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] text-muted/70">场景原图</p>
          <p className="mt-0.5 truncate text-xs text-ink/85">
            {layerSet ? `${layers.length} 层 · 每层 ${layerSet.count_per_layer} 张` : "还没有分层"}
          </p>
        </div>
      </div>

      {setsQuery.isError ? (
        <div className="p-6 text-xs text-bad">{(setsQuery.error as Error).message}</div>
      ) : null}

      {!layerSet || failed || analyzing ? (
        <div className="scroll-thin flex-1 overflow-y-auto px-5 py-6">
          {analyzing ? (
            <div className="flex flex-col items-center gap-6">
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <span className="h-6 w-6 animate-spin rounded-full border-2 border-muted/30 border-t-accentSoft" />
                <p className="text-sm text-ink/85">正在拆分层…</p>
                <p className="text-xs text-muted">通常 1–3 分钟。出来之后会变成上面的页签。</p>
              </div>
              <LLMChat
                exchange={layerSet?.llm_exchange ?? []}
                waiting
                model={layerSet?.model_name}
              />
            </div>
          ) : (
            <div className="flex flex-col items-center gap-6">
              {layerSet?.llm_exchange?.length ? (
                <div className="w-full">
                  <LLMChat
                    exchange={layerSet.llm_exchange}
                    model={layerSet.model_name}
                  />
                  <p className="mx-auto mt-2 max-w-3xl text-[10.5px] text-muted/60">
                    上一次没有成功，可以改改下面的设置再试一次。
                  </p>
                </div>
              ) : null}
              <AnalyzeForm
                failed={Boolean(failed)}
                errorMessage={layerSet?.error_message ?? null}
                models={editModels.map((model) => ({ id: model.id, label: model.label }))}
                defaultModel={layerSet?.model_name ?? ""}
                defaultCount={layerSet?.count_per_layer ?? 1}
                defaultBrief={layerSet?.brief ?? scene?.description ?? ""}
                defaultLayerCount={layerSet?.layer_count ?? 0}
                busy={analyze.isPending}
                onSubmit={(values) => analyze.mutate(values)}
              />
            </div>
          )}
        </div>
      ) : (
        <>
          {/* 这套方案是怎么来的：随时能翻回 LLM 的请求与应答 */}
          {layerSet?.llm_exchange?.length ? (
            <div className="border-b border-edge/50">
              <button
                type="button"
                onClick={() => setShowChat((value) => !value)}
                className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-[11px] text-muted transition hover:text-ink/80"
              >
                <span className={`inline-block transition ${showChat ? "rotate-90" : ""}`}>▸</span>
                与模型的对话
                <span className="text-muted/60">{layerSet.llm_exchange.length} 轮</span>
              </button>
              {showChat ? (
                <div className="px-4 pb-3">
                  <LLMChat exchange={layerSet.llm_exchange} model={layerSet.model_name} compact />
                </div>
              ) : null}
            </div>
          ) : null}

          {/* 层页签 */}
          <div className="scroll-thin flex items-center gap-1 overflow-x-auto border-b border-edge/50 px-4 py-2">
            {layers.map((layer) => {
              const selected = layer.id === activeLayer?.id;
              return (
                <button
                  key={layer.id}
                  type="button"
                  onClick={() => setActiveLayerId(layer.id)}
                  className={[
                    "flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] transition",
                    selected
                      ? "bg-accent/15 text-accentSoft"
                      : "text-muted hover:bg-surface2 hover:text-ink/85",
                  ].join(" ")}
                >
                  <span className="font-mono text-[10px] opacity-70">L{layer.ord}</span>
                  {layer.name}
                  {layer.generation_id ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-ok/80" title="已出图" />
                  ) : null}
                </button>
              );
            })}
          </div>

          {activeLayer ? (
            <>
              <div
                className={[
                  "scroll-thin flex-1 overflow-y-auto px-5 pt-3 transition-[padding] duration-200",
                  composerCollapsed ? "pb-[150px]" : "pb-[330px]",
                ].join(" ")}
              >
                <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-muted">
                  <span className="rounded bg-surface2 px-1.5 py-0.5 text-ink/80">
                    {activeLayer.name}
                  </span>
                  <span>视差 {activeLayer.scroll_scale}</span>
                  <span>层级 {activeLayer.z_index}</span>
                  {activeLayer.occluded_by ? <span>被挡：{activeLayer.occluded_by}</span> : null}
                  {activeLayer.supports ? <span>承接：{activeLayer.supports}</span> : null}
                </div>

                {activeLayer.role ? (
                  <p className="mb-3 text-[11.5px] leading-relaxed text-muted/85">{activeLayer.role}</p>
                ) : null}

                <Feed
                  items={slots}
                  view="grid"
                  loading={layerGenerationsQuery.isLoading}
                  hasMore={false}
                  onLoadMore={() => undefined}
                  emptyHint="还没有图。在下面写好提示词，点「生成本层」。"
                  onOpen={(slot) => {
                    if (slot.image) {
                      setDetail({
                        key: slot.key,
                        image: slot.image,
                        generation: slot.generation,
                        seed: slot.seed,
                      });
                    }
                  }}
                  onFavorite={(slot) => {
                    if (slot.image) actions.favorite({ image: slot.image, generation: slot.generation });
                  }}
                  onDownload={(slot) => {
                    if (slot.image) void actions.download({ image: slot.image, generation: slot.generation });
                  }}
                  onDelete={(slot) => {
                    if (slot.image) void actions.remove({ image: slot.image, generation: slot.generation });
                  }}
                  onDeleteBatch={(generation) => void actions.removeBatch(generation)}
                  onRenameBatch={(generation, next) => void actions.renameBatch(generation, next)}
                  onDeleteTask={(slot) => {
                    if (slot.task) void actions.removeTask(slot.generation, slot.task.id);
                  }}
                  onEdit={(slot) => {
                    if (slot.image) actions.edit({ image: slot.image, generation: slot.generation });
                  }}
                  onPick={(slot) => {
                    if (!slot.image) return;
                    pickImage.mutate({
                      layerId: activeLayer.id,
                      imageId: slot.image.id,
                      same: activeLayer.selected_image_id === slot.image.id,
                    });
                  }}
                  pickedImageId={
                    activeLayer.selected_image_id ??
                    slots.reduce<number | null>(
                      (latest, slot) =>
                        slot.image && (latest === null || slot.image.id > latest)
                          ? slot.image.id
                          : latest,
                      null,
                    )
                  }
                  modelLabels={modelLabels}
                />
              </div>

              {/* 底部：这一层的输入框（布局同「图片编辑」，源图固定、字段预填好） */}
              <LayerComposer
                layer={activeLayer}
                source={source ?? null}
                models={editModels}
                fallbackModel={layerSet?.model_name ?? ""}
                prompt={prompt}
                onPromptChange={(value) =>
                  setDrafts((current) => ({ ...current, [activeLayer.id]: value }))
                }
                onCommit={({ prompt: nextPrompt, negative }) => {
                  const trimmed = nextPrompt.trim();
                  const patch: { layerId: number; prompt?: string; negative_prompt?: string } = {
                    layerId: activeLayer.id,
                  };
                  if (trimmed && trimmed !== activeLayer.prompt) patch.prompt = trimmed;
                  if ((negative ?? "") !== (activeLayer.negative_prompt ?? "")) {
                    patch.negative_prompt = negative;
                  }
                  if (patch.prompt !== undefined || patch.negative_prompt !== undefined) {
                    saveLayer.mutate(patch);
                  }
                }}
                busy={activeBusy}
                pending={render.isPending}
                onRender={(values) => render.mutate({ layer: activeLayer, values })}
                onCollapsedChange={setComposerCollapsed}
              />
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-xs text-muted">
              这个方案还没有层，试试「重新分析」。
            </div>
          )}
        </>
      )}

      {detail ? (
        <ImageDetail
          item={detail}
          onClose={() => setDetail(null)}
          onFavorite={(item) => actions.favorite({ image: item.image, generation: item.generation })}
          onDownload={(item) => void actions.download({ image: item.image, generation: item.generation })}
          onDelete={(item) => void actions.remove({ image: item.image, generation: item.generation })}
          onEdit={(item) => actions.edit({ image: item.image, generation: item.generation })}
          onRegenerate={(item) => actions.regenerate({ image: item.image, generation: item.generation })}
          onToast={toast}
          modelLabels={modelLabels}
        />
      ) : null}

      <ToastStack items={toasts} onDismiss={dismissToast} />
    </>
  );
}

/** 一个任务占一格，排队中的先用占位卡（与创作页同一套排布，图被删掉的不占格）。 */

function AnalyzeForm({
  failed,
  errorMessage,
  models,
  defaultModel,
  defaultCount,
  defaultBrief,
  defaultLayerCount,
  busy,
  onSubmit,
}: {
  failed: boolean;
  errorMessage: string | null;
  models: { id: string; label: string }[];
  defaultModel: string;
  defaultCount: number;
  defaultBrief: string;
  defaultLayerCount: number;
  busy: boolean;
  onSubmit: (values: {
    model: string;
    layer_count: number;
    count_per_layer: number;
    brief: string | null;
  }) => void;
}) {
  const [model, setModel] = useState(defaultModel || models[0]?.id || "");
  const [layerCount, setLayerCount] = useState(defaultLayerCount);
  const [countPerLayer, setCountPerLayer] = useState(defaultCount || 1);
  const [brief, setBrief] = useState(defaultBrief);
  const briefTouched = useRef(false);

  // 场景数据比表单晚到：用户没动过就跟着补上默认值
  useEffect(() => {
    if (briefTouched.current) return;
    if (!brief && defaultBrief) setBrief(defaultBrief);
  }, [brief, defaultBrief]);

  return (
    <div className="mx-auto w-full max-w-[720px]">
      <h2 className="text-sm font-medium text-ink">把这张场景图拆成可做视差的图层</h2>
      <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
        先读这张图，写出每一层的提示词：保留什么、删掉什么、被挡住的部分补到哪里。
        方案出来后可以逐层改，再一层一层出图。
      </p>

      {failed ? (
        <p className="mt-4 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-[11.5px] text-bad">
          上一次没有成功：{errorMessage ?? "未知原因"}
        </p>
      ) : null}

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          出图模型
          <select
            value={model}
            onChange={(event) => setModel(event.target.value)}
            className="h-9 rounded-lg border border-edge bg-surface2 px-2 text-xs text-ink outline-none"
          >
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          层数
          <select
            value={layerCount}
            onChange={(event) => setLayerCount(Number(event.target.value))}
            className="h-9 rounded-lg border border-edge bg-surface2 px-2 text-xs text-ink outline-none"
          >
            <option value={0}>自动判断</option>
            {[2, 3, 4, 5, 6, 7, 8].map((value) => (
              <option key={value} value={value}>
                {value} 层
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          每层张数
          <select
            value={countPerLayer}
            onChange={(event) => setCountPerLayer(Number(event.target.value))}
            className="h-9 rounded-lg border border-edge bg-surface2 px-2 text-xs text-ink outline-none"
          >
            {[1, 2, 3, 4].map((value) => (
              <option key={value} value={value}>
                {value} 张
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="mt-3 flex flex-col gap-1 text-[11px] text-muted">
        创作者需求（可选）
        <textarea
          value={brief}
          rows={3}
          maxLength={8000}
          onChange={(event) => {
            briefTouched.current = true;
            setBrief(event.target.value);
          }}
          placeholder="比如：主角从中间台阶走上来；左边那排荧光蘑菇要单独一层，后面剧情里会发光；门要做成能开关的"
          className="w-full resize-none rounded-lg border border-edge bg-surface2 px-2.5 py-2 text-xs leading-relaxed text-ink outline-none focus:border-accent/60"
        />
      </label>

      <button
        type="button"
        disabled={busy || !model}
        onClick={() =>
          onSubmit({
            model,
            layer_count: layerCount,
            count_per_layer: countPerLayer,
            brief: brief.trim() || null,
          })
        }
        className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-xs font-medium text-white transition hover:bg-accent/90 disabled:opacity-50"
      >
        {busy ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border border-white/40 border-t-white" />
        ) : null}
        分析分层
      </button>
    </div>
  );
}
