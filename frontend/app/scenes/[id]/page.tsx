"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import Composer from "@/components/Composer";
import ConfirmDialog from "@/components/ConfirmDialog";
import Feed from "@/components/Feed";
import ImageDetail from "@/components/ImageDetail";
import ToastStack, { type ToastItem } from "@/components/ToastStack";
import { useImageActions } from "@/hooks/useImageActions";
import { useTaskEvents } from "@/hooks/useTaskEvents";
import { buildFeedSlots } from "@/lib/feed";
import { deleteScene, fetchGenerations, fetchLayerSets, fetchModels, fetchScene, layerExportUrl, startDownload, updateScene } from "@/lib/api";
import type { FeedItem, FeedSlot, GenerationRead } from "@/types/api";

const ACTIVE = new Set(["pending", "queued", "running"]);
const PAGE_SIZE = 40;

export default function SceneDetailPage() {
  useTaskEvents();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const sceneId = Number(params?.id ?? 0);
  const queryClient = useQueryClient();

  const [limit, setLimit] = useState(PAGE_SIZE);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [detail, setDetail] = useState<FeedItem | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
    enabled: Number.isFinite(sceneId) && sceneId > 0,
  });

  const modelsQuery = useQuery({ queryKey: ["models"], queryFn: fetchModels, staleTime: 60_000 });
  const imageModels = useMemo(
    () => (modelsQuery.data ?? []).filter((model) => model.capabilities.media !== "video"),
    [modelsQuery.data],
  );
  const modelLabels = useMemo(
    () =>
      Object.fromEntries(
        (modelsQuery.data ?? []).map((model) => [model.id, model.label.replace(/^Qwen Image /, "Qwen ")]),
      ),
    [modelsQuery.data],
  );

  const generationsQuery = useQuery({
    queryKey: ["generations", "scene", sceneId, limit],
    queryFn: () => fetchGenerations({ limit, scene: sceneId, hasImages: true, excludeLayer: true }),
    enabled: sceneId > 0,
    refetchInterval: (q) => {
      const active = q.state.data?.items.some((item) => ACTIVE.has(item.status));
      return active ? 1500 : false;
    },
  });

  // 分层产物只在对应层的页签里出现（它们带着 layer_id），场景信息流里不要
  const generations: GenerationRead[] = useMemo(
    () => (generationsQuery.data?.items ?? []).filter((item) => !item.layer_id),
    [generationsQuery.data],
  );
  const total = generationsQuery.data?.total ?? 0;

  // 与创作页同一套排布：一个任务占一格，图被删掉的不占格
  const slots: FeedSlot[] = useMemo(() => buildFeedSlots(generations), [generations]);

  // 有分层方案的源图才能在场景页直接导出（没有方案就没有层可导）
  const layerSetsQuery = useQuery({
    queryKey: ["layer-sets", sceneId],
    queryFn: () => fetchLayerSets(sceneId),
    enabled: sceneId > 0,
    staleTime: 15_000,
  });
  const exportableIds = useMemo(
    () =>
      new Set(
        (layerSetsQuery.data?.items ?? [])
          .filter((item) => item.status === "planned" && item.source_image_id)
          .map((item) => item.source_image_id as number),
      ),
    [layerSetsQuery.data],
  );

  // 已经分过层的源图 → 角标文案（同一张图可能分析过多次，取层数最多的那套）
  const layerBadges = useMemo(() => {
    const map = new Map<number, string>();
    for (const item of layerSetsQuery.data?.items ?? []) {
      if (!item.source_image_id) continue;
      const count = item.layers.length;
      const label = item.status === "failed" ? "分层失败" : count > 0 ? `${count} 层` : "已分层";
      const current = map.get(item.source_image_id);
      // 「6 层」比「分层失败」更该展示，同一个 id 只留信息量最大的那条
      if (!current || (item.status === "planned" && count > 0)) {
        map.set(item.source_image_id, label);
      }
    }
    return map;
  }, [layerSetsQuery.data]);

  const layerBadge = useCallback(
    (imageId: number) => layerBadges.get(imageId) ?? null,
    [layerBadges],
  );

  const actions = useImageActions({
    onToast: toast,
    onDeleted: (imageId) => {
      if (detail?.image.id === imageId) setDetail(null);
    },
    onEdited: () => setDetail(null),
  });

  const rename = useMutation({
    mutationFn: (values: { name: string; description: string | null }) =>
      updateScene(sceneId, values),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["scenes"] });
      setEditing(false);
      toast("场景信息已更新");
    },
    onError: (error: Error) => toast(error.message),
  });

  const remove = useMutation({
    mutationFn: () => deleteScene(sceneId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["scenes"] });
      void queryClient.invalidateQueries({ queryKey: ["generations"] });
      toast("场景已删除");
      router.push("/scenes");
    },
    onError: (error: Error) => toast(error.message),
  });

  const scene = sceneQuery.data;
  const busy = generations.some((item) => ACTIVE.has(item.status));

  if (sceneQuery.isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted">
        <p className="text-xs">{(sceneQuery.error as Error).message}</p>
        <Link href="/scenes" className="text-xs text-accentSoft hover:underline">
          ← 回到场景列表
        </Link>
      </div>
    );
  }

  return (
    <>
      <header className="flex items-center gap-3 border-b border-edge/70 px-5 py-2.5">
        <Link href="/scenes" className="shrink-0 text-xs text-muted transition hover:text-ink">
          ← 场景
        </Link>
        <h1 className="truncate text-[13px] font-medium text-ink">{scene?.name ?? "…"}</h1>
        {scene ? (
          <span className="shrink-0 text-[11px] text-muted/70">
            {scene.generation_count} 批 · {scene.image_count} 图{busy ? " · 生成中" : ""}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setView(view === "grid" ? "list" : "grid")}
            className="h-8 rounded-lg border border-edge bg-surface2 px-2.5 text-[11px] text-ink/85 transition hover:border-accent/40"
          >
            {view === "grid" ? "列表" : "网格"}
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="h-8 rounded-lg border border-edge bg-surface2 px-2.5 text-[11px] text-ink/85 transition hover:border-accent/40"
          >
            编辑
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="h-8 rounded-lg border border-bad/40 bg-bad/10 px-2.5 text-[11px] text-bad transition hover:bg-bad/20"
          >
            删除场景
          </button>
        </div>
      </header>

      {scene?.description ? (
        <p className="border-b border-edge/40 px-5 py-2 text-[11.5px] leading-relaxed text-muted/85">
          {scene.description}
        </p>
      ) : null}

      <div className="scroll-thin flex-1 overflow-y-auto px-5 pb-[240px] pt-4">

        <Feed
          items={slots}
          view={view}
          loading={generationsQuery.isLoading}
          hasMore={generations.length < total}
          emptyHint="这个场景还没有图。下面的创作框里写提示词，生成的图只属于这个场景，不会出现在图片页；生成满意后，把鼠标移到图上点「场景分层」。"
          onLoadMore={() => setLimit((current) => current + PAGE_SIZE)}
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
          onLayers={(slot) => {
            if (slot.image) router.push(`/scenes/${sceneId}/layers/${slot.image.id}`);
          }}
          onExport={(slot) => {
            if (!slot.image) return;
            if (!exportableIds.has(slot.image.id)) {
              toast("这张图还没有分层方案，先点「场景分层」做一次再导出");
              return;
            }
            startDownload(layerExportUrl(sceneId, slot.image.id));
            toast("正在打包下载：场景图 + 每层选定的那张");
          }}
          layerBadge={layerBadge}
          modelLabels={modelLabels}
        />
      </div>

      <Composer models={imageModels} onToast={toast} sceneId={sceneId} />

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

      {editing && scene ? (
        <EditSceneDialog
          initialName={scene.name}
          initialDescription={scene.description ?? ""}
          busy={rename.isPending}
          onCancel={() => setEditing(false)}
          onSubmit={(values) => rename.mutate(values)}
        />
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        danger
        busy={remove.isPending}
        title={`删除场景「${scene?.name ?? ""}」？`}
        description={
          <>
            场景里的 {scene?.generation_count ?? 0} 个批次、{scene?.image_count ?? 0} 张图会一起进回收站（图片文件仍在
            <code className="mx-1 rounded bg-surface2 px-1">storage/scenes/&lt;id&gt;/</code>
            下，之后可以手动清）。这一步不会影响图片页的作品。
          </>
        }
        confirmLabel="删除场景"
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirmDelete(false)}
      />

      <ToastStack items={toasts} onDismiss={dismissToast} />
    </>
  );
}

function EditSceneDialog({
  initialName,
  initialDescription,
  busy,
  onCancel,
  onSubmit,
}: {
  initialName: string;
  initialDescription: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: { name: string; description: string | null }) => void;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-[460px] rounded-xl2 border border-edge bg-surface p-5 shadow-pop">
        <h2 className="text-sm font-medium text-ink">编辑场景</h2>
        <label className="mt-4 block text-[11.5px] text-muted">
          场景名
          <input
            autoFocus
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 h-9 w-full rounded-lg border border-edge bg-surface2 px-2.5 text-xs text-ink outline-none focus:border-accent/60"
          />
        </label>
        <label className="mt-3 block text-[11.5px] text-muted">
          场景说明
          <textarea
            value={description}
            rows={3}
            maxLength={4000}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="这个场景是什么地方、什么光线、要出现哪些元素"
            className="mt-1 w-full resize-none rounded-lg border border-edge bg-surface2 px-2.5 py-2 text-xs leading-relaxed text-ink outline-none focus:border-accent/60"
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-9 rounded-lg border border-edge bg-surface2 px-3 text-xs text-ink/90 transition hover:border-accent/40 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy || name.trim().length === 0}
            onClick={() => onSubmit({ name: name.trim(), description: description.trim() || null })}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-white transition hover:bg-accent/90 disabled:opacity-50"
          >
            {busy ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border border-white/40 border-t-white" />
            ) : null}
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
