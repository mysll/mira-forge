"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import Composer from "@/components/Composer";
import Feed from "@/components/Feed";
import ImageDetail from "@/components/ImageDetail";
import ToastStack, { type ToastItem } from "@/components/ToastStack";
import TopBar from "@/components/TopBar";
import { useTaskEvents } from "@/hooks/useTaskEvents";
import {
  deleteImage,
  fetchGenerations,
  fetchModels,
  imageFileUrl,
  setImageFavorite,
} from "@/lib/api";
import { dateRangeFor, type DateFilter } from "@/lib/date";
import { useComposerStore } from "@/stores/composer";
import { useReferenceStore } from "@/stores/reference";
import type { FeedItem, GenerationRead } from "@/types/api";

const ACTIVE = new Set(["pending", "queued", "running"]);
const PAGE_SIZE = 40;

const MODE_LABEL: Record<string, string> = {
  text_to_image: "图片生成",
  image_edit: "图片编辑",
};

export default function WorkspacePage() {
  const queryClient = useQueryClient();
  useTaskEvents();

  const [query, setQuery] = useState("");
  const [modelFilter, setModelFilter] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [detail, setDetail] = useState<FeedItem | null>(null);
  const [hiddenBatches, setHiddenBatches] = useState<number[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((text: string) => {
    setToasts((current) => [...current, { id: Date.now() + Math.random(), text }]);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: fetchModels,
    staleTime: 60_000,
  });

  const generationsQuery = useQuery({
    queryKey: ["generations", query, modelFilter, dateFilter, favoriteOnly, limit],
    queryFn: () => {
      const range = dateRangeFor(dateFilter);
      return fetchGenerations({
        limit,
        q: query.trim() || undefined,
        model: modelFilter ?? undefined,
        favorite: favoriteOnly || undefined,
        dateFrom: range.from,
        dateTo: range.to,
      });
    },
    refetchInterval: (q) => {
      const data = q.state.data;
      const active = data?.items.some((item) => ACTIVE.has(item.status));
      return active ? 1500 : false;
    },
  });

  const generations: GenerationRead[] = generationsQuery.data?.items ?? [];
  const total = generationsQuery.data?.total ?? 0;

  const items: FeedItem[] = useMemo(() => {
    const flat: FeedItem[] = [];
    for (const generation of generations) {
      const seedsByTask = new Map(generation.tasks.map((task) => [task.id, task.seed]));
      for (const image of generation.images) {
        flat.push({
          key: `${generation.id}-${image.id}`,
          image,
          generation,
          seed: image.task_id === null ? null : (seedsByTask.get(image.task_id) ?? null),
        });
      }
    }
    return flat;
  }, [generations]);

  // 还没有产物但正在进行（或已失败）的批次，单独列在顶部，避免状态消失
  const pendingBatches = useMemo(
    () =>
      generations
        .filter(
          (generation) =>
            !hiddenBatches.includes(generation.id) &&
            (ACTIVE.has(generation.status) || generation.status === "failed"),
        )
        .slice(0, 3),
    [generations, hiddenBatches],
  );

  const modelLabels = useMemo(
    () =>
      Object.fromEntries(
        (modelsQuery.data ?? []).map((model) => [
          model.id,
          // 卡片宽度有限，"Qwen Image 2.1 Turbo" 会截断成半个词，短名更易读
          model.label.replace(/^Qwen Image /, "Qwen "),
        ]),
      ),
    [modelsQuery.data],
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["generations"] });
    queryClient.invalidateQueries({ queryKey: ["images"] });
  };

  const onFavorite = (item: FeedItem) => {
    const next = !item.image.is_favorite;
    void setImageFavorite(item.image.id, next)
      .then(() => {
        invalidate();
        toast(next ? "已收藏" : "已取消收藏");
      })
      .catch((error: Error) => toast(error.message || "操作失败"));
  };

  const onDownload = async (item: FeedItem) => {
    try {
      const response = await fetch(imageFileUrl(item.image.id));
      if (!response.ok) {
        throw new Error("图片下载失败");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `miraforge-${item.image.id}.png`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast((error as Error).message || "下载失败");
    }
  };

  const onDelete = async (item: FeedItem) => {
    if (!window.confirm("删除这张图？文件会从磁盘移除。")) {
      return;
    }
    try {
      await deleteImage(item.image.id);
      if (detail?.image.id === item.image.id) {
        setDetail(null);
      }
      invalidate();
      toast("已删除");
    } catch (error) {
      toast((error as Error).message || "删除失败");
    }
  };

  const onEdit = (item: FeedItem) => {
    setDetail(null);
    useReferenceStore.getState().setImage({
      id: item.image.id,
      url: imageFileUrl(item.image.id),
    });
    toast("已作为参考图，写在下方提示词里描述要改成什么");
  };

  const onRegenerate = (item: FeedItem) => {
    const store = useComposerStore.getState();
    const { generation } = item;
    store.setMode(generation.generation_type === "image_edit" ? "image_edit" : "text_to_image");
    store.setPrompt(generation.prompt);
    store.setModelId(generation.model_name);
    if (generation.width && generation.height) {
      store.setCustomSize(generation.width, generation.height);
    }
    setDetail(null);
    toast("参数已填回创作框，点「生成」即可再跑一批");
  };

  return (
    <>
      <TopBar
        query={query}
        onQuery={(value) => {
          setQuery(value);
          setLimit(PAGE_SIZE);
        }}
        models={modelsQuery.data ?? []}
        modelFilter={modelFilter}
        onModelFilter={(value) => {
          setModelFilter(value);
          setLimit(PAGE_SIZE);
        }}
        dateFilter={dateFilter}
        onDateFilter={(value) => {
          setDateFilter(value);
          setLimit(PAGE_SIZE);
        }}
        favoriteOnly={favoriteOnly}
        onFavoriteOnly={(value) => {
          setFavoriteOnly(value);
          setLimit(PAGE_SIZE);
        }}
        view={view}
        onView={setView}
        total={total}
      />

      <div className="scroll-thin flex-1 overflow-y-auto px-5 pb-[240px] pt-4">
        {pendingBatches.length > 0 ? (
          <div className="mb-4 flex flex-col gap-2">
            {pendingBatches.map((generation) => {
              const failed = generation.status === "failed";
              const reason = generation.tasks.find((task) => task.error_message)?.error_message;
              return (
                <div
                  key={generation.id}
                  className="flex items-center gap-3 rounded-xl border border-edge/70 bg-surface/70 px-3 py-2"
                >
                  <span className="shrink-0 rounded-md bg-accent/12 px-1.5 py-0.5 text-[10px] text-accentSoft">
                    批次 #{generation.id}
                  </span>
                  <span className="min-w-0 truncate text-xs text-ink/85">{generation.prompt}</span>
                  <span className="shrink-0 text-[11px] text-muted">
                    {MODE_LABEL[generation.generation_type] ?? generation.generation_type} ·{" "}
                    {generation.tasks.length} 张
                  </span>
                  {failed && reason ? (
                    <span className="min-w-0 truncate text-[11px] text-bad/80" title={reason}>
                      {reason}
                    </span>
                  ) : null}
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    {failed ? null : (
                      <div className="h-1 w-24 overflow-hidden rounded-full bg-surface2">
                        <div
                          className="h-full rounded-full bg-accent transition-all"
                          style={{ width: `${Math.max(2, generation.progress)}%` }}
                        />
                      </div>
                    )}
                    <span className={["text-[11px]", failed ? "text-bad" : "text-muted"].join(" ")}>
                      {failed ? "失败" : `${generation.progress}%`}
                    </span>
                    {failed ? (
                      <button
                        type="button"
                        onClick={() => setHiddenBatches((current) => [...current, generation.id])}
                        title="收起这条失败记录"
                        className="rounded p-1 text-muted transition hover:bg-surface2 hover:text-ink"
                      >
                        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" aria-hidden>
                          <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        </svg>
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        <Feed
          items={items}
          view={view}
          loading={generationsQuery.isLoading}
          hasMore={items.length < total && generations.length < total}
          onLoadMore={() => setLimit((current) => current + PAGE_SIZE)}
          onOpen={setDetail}
          onFavorite={onFavorite}
          onDownload={(item) => void onDownload(item)}
          onDelete={(item) => void onDelete(item)}
          onEdit={onEdit}
          modelLabels={modelLabels}
        />
      </div>

      {/* 创作框悬浮在作品流之上：absolute 定位，不再占据独立的一段高度 */}
      <Composer models={modelsQuery.data ?? []} onToast={toast} />

      {detail ? (
        <ImageDetail
          item={detail}
          onClose={() => setDetail(null)}
          onFavorite={onFavorite}
          onDownload={(item) => void onDownload(item)}
          onDelete={(item) => void onDelete(item)}
          onEdit={onEdit}
          onRegenerate={onRegenerate}
          onToast={toast}
          modelLabels={modelLabels}
        />
      ) : null}

      <ToastStack items={toasts} onDismiss={dismissToast} />
    </>
  );
}
