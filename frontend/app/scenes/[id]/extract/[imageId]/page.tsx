"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import EditComposer, {
  DEFAULT_EDIT_ADVANCED,
  type EditAdvanced,
} from "@/components/EditComposer";
import MaskEditor, { type MaskEditorResult } from "@/components/MaskEditor";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import ImagePreview from "@/components/ImagePreview";
import LLMChat from "@/components/LLMChat";
import { buildFeedSlots } from "@/lib/feed";
import {
  addKitItem,
  clearElementMask,
  createElementSet,
  createKit,
  deleteElementSet,
  deleteImage,
  extractElements,
  fetchElementGenerations,
  fetchElementSets,
  fetchImage,
  fetchKits,
  fetchModels,
  fetchScene,
  elementMaskUrl,
  imageFileUrl,
  imageTrimmedUrl,
  removeKitElement,
  updateElement,
  uploadElementMask,
} from "@/lib/api";
import type {
  ElementKind,
  ElementRead,
  ElementSetRead,
  ElementStatus,
  FeedSlot,
  ImageBrief,
} from "@/types/api";

const KIND_LABEL: Record<ElementKind, string> = {
  terrain: "地形",
  structure: "结构",
  prop: "物件",
  decor: "装饰",
};

const STATUS_LABEL: Record<ElementStatus, string> = {
  draft: "未提取",
  queued: "排队中",
  running: "提取中",
  ready: "有图",
  failed: "失败",
};

const STATUS_DOT: Record<ElementStatus, string> = {
  draft: "bg-white/25",
  queued: "bg-amber-300/80",
  running: "bg-amber-300 animate-pulse",
  ready: "bg-emerald-400",
  failed: "bg-red-400",
};

export default function ElementExtractPage() {
  const params = useParams<{ id: string; imageId: string }>();
  const sceneId = Number(params.id);
  const sourceImageId = Number(params.imageId);
  const queryClient = useQueryClient();

  const [brief, setBrief] = useState("");
  const briefTouched = useRef(false);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [count, setCount] = useState(1);
  const [kitId, setKitId] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImageBrief | null>(null);
  const [composerCollapsed, setComposerCollapsed] = useState(true);
  const [advanced, setAdvanced] = useState<EditAdvanced>(DEFAULT_EDIT_ADVANCED);
  const [maskTarget, setMaskTarget] = useState<ElementRead | null>(null);

  const sceneQuery = useQuery({ queryKey: ["scene", sceneId], queryFn: () => fetchScene(sceneId) });
  const imageQuery = useQuery({
    queryKey: ["image", sourceImageId],
    queryFn: () => fetchImage(sourceImageId),
  });
  const setsQuery = useQuery({
    queryKey: ["element-sets", sceneId],
    queryFn: () => fetchElementSets(sceneId),
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      if (items.some((item) => item.status === "analyzing")) return 1500;
      const busy = items.some((item) =>
        item.elements.some(
          (element) => element.status === "queued" || element.status === "running",
        ),
      );
      return busy ? 2000 : false;
    },
  });
  const kitsQuery = useQuery({ queryKey: ["kits"], queryFn: () => fetchKits() });
  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: fetchModels,
    staleTime: 60_000,
  });
  // 元素提取固定用「能跑图片编辑」的模型：后端没收到 model 时也按这个顺序挑第一个，
  // 所以这里显示的、提交的就是真正会跑的那个，不给换。
  const editModels = useMemo(
    () =>
      (modelsQuery.data ?? []).filter(
        (model) =>
          model.capabilities.media !== "video" &&
          model.workflows.some((target) => target.type === "image_edit"),
      ),
    [modelsQuery.data],
  );
  const elementModel = editModels[0] ?? null;

  const showToast = (message: string) => setToast(message);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const sets = setsQuery.data?.items ?? [];
  const current: ElementSetRead | null = useMemo(
    () => sets.find((item) => item.source_image_id === sourceImageId) ?? null,
    [sets, sourceImageId],
  );
  const elements = current?.elements ?? [];
  const active: ElementRead | null = useMemo(
    () => elements.find((item) => item.id === activeId) ?? elements[0] ?? null,
    [elements, activeId],
  );

  useEffect(() => {
    if (briefTouched.current) return;
    const description = sceneQuery.data?.description;
    if (description && !brief) setBrief(description);
  }, [brief, sceneQuery.data?.description]);

  const sceneName = sceneQuery.data?.name ?? "场景";
  const inThisKit = Boolean(
    active && kitId !== null && active.kit_ids.includes(kitId),
  );
  const anyBusy = elements.some(
    (element) => element.status === "queued" || element.status === "running",
  );
  const kits = kitsQuery.data?.items ?? [];

  // 默认图集：只有「这个场景之前手动选过」才沿用；没选过就是未选择，不替用户挑。
  useEffect(() => {
    if (kitId !== null) return;
    if (!kitsQuery.data) return;
    const stored = window.localStorage.getItem(`miraforge:kit:${sceneId}`);
    const storedId = stored ? Number(stored) : null;
    if (storedId !== null && kitsQuery.data.items.some((kit) => kit.id === storedId)) {
      setKitId(storedId);
      return;
    }
    if (stored !== null) {
      // 记住的图集被删了，清掉，回到「未选择」
      window.localStorage.removeItem(`miraforge:kit:${sceneId}`);
    }
  }, [kitId, kitsQuery.data, sceneId]);

  const rememberKit = (id: number) => {
    window.localStorage.setItem(`miraforge:kit:${sceneId}`, String(id));
  };

  const generationsQuery = useQuery({
    queryKey: ["element-generations", active?.id ?? 0],
    queryFn: () => fetchElementGenerations(active!.id),
    enabled: Boolean(active?.id),
    refetchInterval:
      active && (active.status === "queued" || active.status === "running") ? 1500 : false,
  });

  const analyze = useMutation({
    mutationFn: () =>
      createElementSet(sceneId, { source_image_id: sourceImageId, brief: brief.trim() || null }),
    onSuccess: () => {
      setToast("已提交，正在让模型看图…");
      void queryClient.invalidateQueries({ queryKey: ["element-sets", sceneId] });
    },
    onError: (error: Error) => setToast(error.message),
  });

  const saveElement = useMutation({
    mutationFn: ({ id, prompt }: { id: number; prompt: string }) => updateElement(id, { prompt }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["element-sets", sceneId] });
    },
    onError: (error: Error) => setToast(error.message),
  });

  const saveMask = useMutation({
    mutationFn: ({ id, file }: { id: number; file: Blob }) => uploadElementMask(id, file),
    onSuccess: (_element, variables) => {
      showToast("遮罩已保存，下次提取会按它裁参考图");
      void queryClient.invalidateQueries({ queryKey: ["element-sets", sceneId] });
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[variables.id];
        return next;
      });
    },
    onError: (error: Error) => showToast(error.message),
  });

  const clearMask = useMutation({
    mutationFn: (id: number) => clearElementMask(id),
    onSuccess: () => {
      showToast("遮罩已清除");
      void queryClient.invalidateQueries({ queryKey: ["element-sets", sceneId] });
    },
    onError: (error: Error) => showToast(error.message),
  });

  const advancedPayload = () => ({
    negative_prompt: advanced.negative.trim() || null,
    seed:
      advanced.seedMode === "fixed" && advanced.seed.trim()
        ? Number(advanced.seed)
        : null,
    steps: advanced.steps.trim() ? Number(advanced.steps) : null,
    cfg: advanced.cfg.trim() ? Number(advanced.cfg) : null,
    sampler: advanced.sampler.trim() || null,
  });

  const extract = useMutation({
    mutationFn: (element: ElementRead) =>
      extractElements(current!.id, {
        element_ids: [element.id],
        count,
        model: elementModel?.id ?? null,
        ...advancedPayload(),
      }),
    onSuccess: () => {
      setToast(`已排队 ${count} 张`);
      void queryClient.invalidateQueries({ queryKey: ["element-sets", sceneId] });
    },
    onError: (error: Error) => setToast(error.message),
  });

  const extractAll = useMutation({
    mutationFn: () =>
      extractElements(current!.id, {
        element_ids: elements.map((element) => element.id),
        count,
        model: elementModel?.id ?? null,
        ...advancedPayload(),
      }),
    onSuccess: (generations) => {
      setToast(
        `已排队 ${generations.length} 件 · 共 ${generations.length * count} 张`,
      );
      void queryClient.invalidateQueries({ queryKey: ["element-sets", sceneId] });
    },
    onError: (error: Error) => setToast(error.message),
  });

  const removeSet = useMutation({
    mutationFn: () => deleteElementSet(current!.id),
    onSuccess: () => {
      setActiveId(null);
      setDrafts({});
      void queryClient.invalidateQueries({ queryKey: ["element-sets", sceneId] });
    },
    onError: (error: Error) => setToast(error.message),
  });

  const addToKit = useMutation({
    mutationFn: (element: ElementRead) =>
      addKitItem(kitId!, { element_id: element.id, key: element.key, anchor: element.anchor }),
    onSuccess: () => {
      setToast("已加入图集");
      void queryClient.invalidateQueries({ queryKey: ["kits"] });
      void queryClient.invalidateQueries({ queryKey: ["kit", kitId] });
      void queryClient.invalidateQueries({ queryKey: ["element-sets", sceneId] });
    },
    onError: (error: Error) => setToast(error.message),
  });

  const removeFromKit = useMutation({
    mutationFn: (element: ElementRead) => removeKitElement(kitId!, element.id),
    onSuccess: () => {
      setToast("已移出图集");
      void queryClient.invalidateQueries({ queryKey: ["kits"] });
      void queryClient.invalidateQueries({ queryKey: ["kit", kitId] });
      void queryClient.invalidateQueries({ queryKey: ["element-sets", sceneId] });
    },
    onError: (error: Error) => setToast(error.message),
  });

  const newKit = useMutation({
    mutationFn: () =>
      createKit({
        name: `${sceneName} · 提取件`.slice(0, 60),
        description: `从「${sceneName}」的元素提取自动建立`,
        padding: 6,
        max_width: 1024,
        cell: 64,
        scene_id: sceneId,
      }),
    onSuccess: (kit) => {
      setKitId(kit.id);
      window.localStorage.setItem(`miraforge:kit:${sceneId}`, String(kit.id));
      setToast(`已新建图集「${kit.name}」`);
      void queryClient.invalidateQueries({ queryKey: ["kits"] });
    },
    onError: (error: Error) => setToast(error.message),
  });

  const selectImage = useMutation({
    mutationFn: ({ element, imageId }: { element: ElementRead; imageId: number }) =>
      updateElement(element.id, { selected_image_id: imageId }),
    onSuccess: () => {
      setToast("图集改用这张");
      void queryClient.invalidateQueries({ queryKey: ["element-sets", sceneId] });
      void queryClient.invalidateQueries({ queryKey: ["kits"] });
    },
    onError: (error: Error) => setToast(error.message),
  });

  const removeImage = useMutation({
    mutationFn: (image: ImageBrief) => deleteImage(image.id),
    onSuccess: () => {
      setToast("已删除这张图");
      void queryClient.invalidateQueries({ queryKey: ["element-sets", sceneId] });
      void queryClient.invalidateQueries({ queryKey: ["kits"] });
    },
    onError: (error: Error) => setToast(error.message),
  });

  const source = imageQuery.data ?? null;
  const generations = generationsQuery.data?.items ?? [];
  const slots: FeedSlot[] = useMemo(() => buildFeedSlots(generations), [generations]);

  const status = current?.status ?? null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-edge/70 px-5 py-2.5">
        <Link
          href={`/scenes/${sceneId}`}
          className="text-[13px] text-muted transition hover:text-text"
        >
          ← {sceneQuery.data?.name ?? "场景"}
        </Link>
        <span className="text-[13px] text-muted/60">/</span>
        <h1 className="text-[13px] font-medium text-text">元素提取</h1>
        {source ? (
          <span className="text-[12px] text-muted/70">
            底图 #{source.id} · {source.width}×{source.height}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {current ? (
            <button
              type="button"
              onClick={() => removeSet.mutate()}
              disabled={removeSet.isPending}
              className="rounded-md border border-edge px-2.5 py-1 text-[12px] text-muted transition hover:border-red-400/40 hover:text-red-300 disabled:opacity-50"
            >
              删除这次提取
            </button>
          ) : null}
        </div>
      </header>

      <div
        className={`scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto ${
          current && status === "ready" ? (composerCollapsed ? "pb-[132px]" : "pb-[470px]") : ""
        }`}
      >
        {!current ? (
          <AnalyzeForm
            brief={brief}
            onBrief={(value) => {
              briefTouched.current = true;
              setBrief(value);
            }}
            busy={analyze.isPending}
            onSubmit={() => analyze.mutate()}
          />
        ) : status === "analyzing" ? (
          <div className="mx-auto flex w-full max-w-[860px] flex-col gap-3 px-5 py-6">
            <div className="rounded-xl2 border border-edge bg-surface px-4 py-3 text-[13px] text-muted">
              正在让模型看图，通常 1–3 分钟。看完会列出可以拆出来的物件。
            </div>
            <LLMChat exchange={current.llm_exchange} waiting />
          </div>
        ) : status === "failed" ? (
          <div className="mx-auto w-full max-w-[860px] px-5 py-6">
            <div className="rounded-xl2 border border-red-400/30 bg-red-400/10 px-4 py-3 text-[13px] text-red-200">
              {current.error_message ?? "提取失败"}
            </div>
            <button
              type="button"
              onClick={() => analyze.mutate()}
              className="mt-3 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-black"
            >
              重新分析
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-edge/60 px-5 py-2">
              {source ? (
                <button
                  type="button"
                  onClick={() => setPreview(source)}
                  title="点开看大图"
                  className="group/src relative shrink-0 overflow-hidden rounded-md border border-edge transition hover:border-accent/50"
                >
                  <img
                    src={imageFileUrl(source)}
                    alt=""
                    className="h-14 w-24 object-cover"
                  />
                  <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/45 text-[10px] text-white/85 opacity-0 transition group-hover/src:opacity-100">
                    点开预览
                  </span>
                </button>
              ) : null}
              <div className="min-w-0">
                <div className="text-[12px] text-text">场景原图</div>
                <div className="text-[11px] text-muted/70">
                  {elements.length} 个可提取物件 · 每件单独出一张透明图
                </div>
              </div>
              <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted">
                加入图集
                <select
                  value={kitId ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "new") {
                      newKit.mutate();
                      return;
                    }
                    const next = value === "" ? null : Number(value);
                    setKitId(next);
                    if (next !== null) rememberKit(next);
                    else window.localStorage.removeItem(`miraforge:kit:${sceneId}`);
                  }}
                  disabled={newKit.isPending}
                  className="max-w-[220px] rounded-md border border-edge bg-surface2 px-1.5 py-1 text-[11px] text-text outline-none disabled:opacity-60"
                >
                  <option value="">选择图集…</option>
                  {kits.map((kit) => (
                    <option key={kit.id} value={kit.id}>
                      {kit.name}
                      {kit.scene_id === sceneId ? "（本场景）" : ""}
                    </option>
                  ))}
                  <option value="new">
                    {newKit.isPending ? "正在新建…" : `＋ 新建图集（${sceneName} · 提取件）`}
                  </option>
                </select>
              </label>
              {elements.length > 0 ? (
                <button
                  type="button"
                  onClick={() => extractAll.mutate()}
                  disabled={extractAll.isPending || anyBusy}
                  title={`每一件各排 ${count} 张，一件接一件跑`}
                  className="btn-primary shrink-0 px-2.5 py-1 text-[11px] disabled:opacity-60"
                >
                  {extractAll.isPending
                    ? "正在排队…"
                    : anyBusy
                      ? "正在提取…"
                      : `提取所有 ${elements.length} 件`}
                </button>
              ) : null}
              {kitId ? (
                <Link
                  href={`/tools/kit/${kitId}`}
                  className="shrink-0 rounded-md border border-edge px-2 py-1 text-[11px] text-muted transition hover:border-accent/40 hover:text-text"
                >
                  打开图集 →
                </Link>
              ) : null}
            </div>

            <div className="flex gap-1.5 overflow-x-auto border-b border-edge/60 px-4 py-2">
              {elements.map((element) => {
                const selected = active?.id === element.id;
                return (
                  <button
                    key={element.id}
                    type="button"
                    onClick={() => setActiveId(element.id)}
                    className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] transition ${
                      selected
                        ? "border-accent/60 bg-accent/10 text-text"
                        : "border-edge text-muted hover:border-edge/80 hover:text-text"
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[element.status]}`} />
                    <span className="max-w-[150px] truncate">{element.name}</span>
                    <span className="text-[10px] text-muted/60">{KIND_LABEL[element.kind]}</span>
                    {element.kit_count > 0 ? (
                      <span className="rounded bg-accent/20 px-1 py-0.5 text-[9px] text-accent">
                        已在图集
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            {active ? (
              <div className="flex flex-col gap-4 px-5 py-4">
                <div className="rounded-xl2 border border-edge bg-surface p-3">
                  <div className="mb-2 flex items-center gap-2 text-[12px]">
                    <span className="font-medium text-text">{active.name}</span>
                    <span className="rounded-md border border-edge px-1.5 py-0.5 text-[10px] text-muted">
                      {KIND_LABEL[active.kind]}
                    </span>
                    <span className="text-[11px] text-muted/70">{STATUS_LABEL[active.status]}</span>
                    {active.status === "ready" && !active.has_alpha ? (
                      <span
                        className="rounded-md border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200"
                        title="这次的图没有透明背景，放进图集会带一块底；建议重新提取"
                      >
                        没有透明背景
                      </span>
                    ) : null}
                    <div className="ml-auto flex items-center gap-1.5">
                      {inThisKit ? (
                        <button
                          type="button"
                          onClick={() => removeFromKit.mutate(active)}
                          disabled={removeFromKit.isPending}
                          title="从当前图集里移出这一件"
                          className="rounded-md border border-edge px-2 py-1 text-[11px] text-muted transition hover:border-rose-400/50 hover:text-rose-200 disabled:opacity-60"
                        >
                          {removeFromKit.isPending ? "移除中…" : "移出图集"}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          if (!kitId) {
                            setToast("先在上面选一个图集，或者新建一个");
                            return;
                          }
                          addToKit.mutate(active);
                        }}
                        disabled={
                          !kitId ||
                          active.status !== "ready" ||
                          addToKit.isPending ||
                          inThisKit
                        }
                        title={
                          !kitId
                            ? "先选一个图集"
                            : inThisKit
                              ? "这件已经在当前图集里了"
                              : active.status === "ready"
                                ? "把这张加进当前图集"
                                : "先提取出一张图才能加"
                        }
                        className={`rounded-md border px-2 py-1 text-[11px] transition disabled:opacity-60 ${
                          inThisKit
                            ? "border-accent/40 bg-accent/10 text-accent"
                            : "border-edge text-muted hover:border-accent/40 hover:text-text"
                        }`}
                      >
                        {inThisKit ? "已在图集" : "加入图集"}
                      </button>
                    </div>
                  </div>
                </div>

                {slots.length ? (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
                    {slots.map((slot) => {
                      const image = slot.image;
                      const picked =
                        !!image &&
                        active.kit_count > 0 &&
                        (active.selected_image_id ?? active.image_id) === image.id;
                      if (!image) {
                        const task = slot.task;
                        const failed = task?.status === "failed" || slot.generation.status === "failed";
                        const progress = Math.max(0, Math.min(100, task?.progress ?? slot.generation.progress ?? 0));
                        return (
                          <div
                            key={slot.key}
                            className="overflow-hidden rounded-xl2 border border-dashed border-edge/70 bg-surface/60"
                          >
                            <div className="flex aspect-[4/3] flex-col items-center justify-center gap-2 px-3">
                              {failed ? (
                                <>
                                  <span className="text-[12px] text-red-300">提取失败</span>
                                  <span className="line-clamp-3 text-center text-[10px] leading-relaxed text-muted/60">
                                    {task?.error_message || "再点一次「提取」重试"}
                                  </span>
                                </>
                              ) : (
                                <>
                                  <span className="text-[12px] text-muted">
                                    {task?.status === "running" ? "提取中…" : "排队中…"}
                                  </span>
                                  <div className="h-1 w-28 overflow-hidden rounded-full bg-white/10">
                                    <div
                                      className="h-full rounded-full bg-accent transition-all duration-500"
                                      style={{ width: `${Math.max(4, progress)}%` }}
                                    />
                                  </div>
                                  <span className="text-[10px] tabular-nums text-muted/60">{progress}%</span>
                                </>
                              )}
                            </div>
                            <div className="flex items-center justify-between px-2 py-1.5 text-[11px] text-muted/60">
                              <span>{slot.index}/{slot.total}</span>
                              <span>{failed ? "失败" : task?.status === "running" ? "生成中" : "排队"}</span>
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div
                          key={slot.key}
                          className={`group/elem overflow-hidden rounded-xl2 border bg-surface transition ${
                            picked ? "border-accent/60 ring-1 ring-accent/30" : "border-edge"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => setPreview(image)}
                            title="点开看大图"
                            className="relative block aspect-[4/3] w-full cursor-zoom-in bg-[#0b0d12]"
                          >
                            <img
                              src={imageTrimmedUrl(image, 480)}
                              alt=""
                              className="h-full w-full object-contain p-2"
                            />
                            {picked ? (
                              <span className="absolute left-2 top-2 rounded-md bg-accent px-2 py-1 text-[10px] font-medium text-black">
                                图集使用
                              </span>
                            ) : null}
                            <span className="absolute bottom-2 right-2 rounded-md bg-black/70 px-2 py-1 text-[11px] text-white/90 opacity-0 transition group-hover/elem:opacity-100">
                              看大图
                            </span>
                          </button>
                          <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] text-muted/60">
                            <span>
                              {image.width}×{image.height}
                            </span>
                            <span className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => selectImage.mutate({ element: active, imageId: image.id })}
                              disabled={picked || selectImage.isPending}
                              title="图集里用这一张"
                              className={`rounded-md border px-1.5 py-0.5 text-[10px] transition ${
                                picked
                                  ? "border-accent/60 bg-accent/15 text-accent"
                                  : "border-edge text-muted hover:border-accent/40 hover:text-text"
                              }`}
                            >
                              {picked ? "已选用" : "用这张"}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (!window.confirm("删除这张图？删掉之后这一件还能重新提取。")) return;
                                removeImage.mutate(image);
                              }}
                              disabled={removeImage.isPending}
                              title="删除这张图"
                              className="rounded-md border border-edge px-1.5 py-0.5 text-[10px] text-muted/70 transition hover:border-red-400/50 hover:text-red-300 disabled:opacity-40"
                            >
                              删除
                            </button>
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-xl2 border border-dashed border-edge/70 px-4 py-10 text-center text-[12px] text-muted/70">
                    这一件还没出图。调整上面的描述，然后点「提取」。
                  </div>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>

      {current && status === "ready" && active ? (
        <EditComposer
          badge={KIND_LABEL[active.kind] ?? active.kind}
          title={active.name}
          subtitle={active.key}
          reference={{
            url: source ? imageFileUrl(source) : null,
            label: "参考",
            caption: "底图",
            title: "元素出图固定用这张场景底图做参考",
          }}
          onPreviewReference={source ? () => setPreview(source) : undefined}
          mask={{
            has: active.has_mask,
            onEdit: () => setMaskTarget(active),
            onClear: () => clearMask.mutate(active.id),
            title: active.has_mask
              ? "这一件已经圈了位置：出图会按遮罩范围裁参考图"
              : "在底图上圈出这一件，出图会按圈出来的范围裁参考图",
          }}
          maskUrl={elementMaskUrl(active.id)}
          prompt={drafts[active.id] ?? active.prompt ?? ""}
          promptPlaceholder="描述这件东西长什么样，提取时按这段描述重画"
          promptMaxLength={4000}
          onPromptChange={(value) =>
            setDrafts((prev) => ({ ...prev, [active.id]: value }))
          }
          onCommit={({ prompt: nextPrompt }) => {
            // 空提示词不让落库：清空输入框后失焦不该把这一件的描述抹掉
            if (!nextPrompt.trim()) return;
            if (nextPrompt === (active.prompt ?? "")) return;
            saveElement.mutate({ id: active.id, prompt: nextPrompt });
          }}
          sizeLabel={source ? `${source.width}×${source.height}` : "跟随底图"}
          count={count}
          onCountChange={setCount}
          model={{ label: elementModel?.label ?? "模型加载中" }}
          capabilities={elementModel?.capabilities}
          defaults={elementModel?.defaults}
          advanced={advanced}
          onAdvancedChange={(patch) =>
            setAdvanced((prev) => ({ ...prev, ...patch }))
          }
          submit={{
            label: `${active.status === "ready" ? "重新提取" : "提取"} ${count} 张`,
            pending: extract.isPending,
            onClick: () => extract.mutate(active),
          }}
          busy={active.status === "queued" || active.status === "running"}
          hint={active.has_mask ? "按遮罩范围出图" : "输出比例跟随底图"}
          onCollapsedChange={setComposerCollapsed}
        />
      ) : null}

      <MaskEditor
        open={Boolean(maskTarget) && Boolean(source)}
        imageUrl={source ? imageFileUrl(source) : ""}
        initialMaskUrl={
          maskTarget?.has_mask ? elementMaskUrl(maskTarget.id) : null
        }
        onClose={() => setMaskTarget(null)}
        onApply={(result: MaskEditorResult) => {
          if (maskTarget) saveMask.mutate({ id: maskTarget.id, file: result.file });
          setMaskTarget(null);
        }}
      />

      {toast ? (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-edge bg-surface/95 px-3 py-2 text-[12px] text-text shadow-pop">
          {toast}
        </div>
      ) : null}

      <ImagePreview image={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

function AnalyzeForm({
  brief,
  onBrief,
  busy,
  onSubmit,
}: {
  brief: string;
  onBrief: (value: string) => void;
  busy: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3 px-5 py-8">
      <div>
        <h2 className="text-[15px] font-medium text-text">从这张场景图里拆物件</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-muted/80">
          模型先看图，列出可以拆下来重复使用的部分（柱子、拱门、平台段、垂根、蘑菇这些），
          然后每一件单独出一张透明图。列出来的东西你在页签里挑着提取。
        </p>
      </div>
      <label className="text-[12px] text-muted">
        这次想要什么
        <textarea
          value={brief}
          onChange={(event) => onBrief(event.target.value)}
          rows={3}
          className="mt-1 w-full resize-y rounded-lg border border-edge bg-surface2/60 px-2.5 py-2 text-[12px] leading-relaxed text-text outline-none focus:border-accent/50"
          placeholder="比如：只拆能重复用的建筑件和地面段，不要拆一次性的装饰"
        />
      </label>
      <div>
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy}
          className="rounded-md bg-accent px-3.5 py-2 text-[12px] font-medium text-black transition hover:brightness-110 disabled:opacity-60"
        >
          {busy ? "提交中…" : "开始分析"}
        </button>
      </div>
    </div>
  );
}
