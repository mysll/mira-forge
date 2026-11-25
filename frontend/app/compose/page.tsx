"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import Composer from "@/components/Composer";
import Feed from "@/components/Feed";
import ImageDetail from "@/components/ImageDetail";
import ToastStack, { type ToastItem } from "@/components/ToastStack";
import TopBar from "@/components/TopBar";
import { useImageActions } from "@/hooks/useImageActions";
import { useTaskEvents } from "@/hooks/useTaskEvents";
import { fetchGenerations, fetchModels, FEED_PAGE_LIMIT } from "@/lib/api";
import { dateRangeFor, type DateFilter } from "@/lib/date";
import { buildFeedSlots } from "@/lib/feed";
import type { FeedItem, FeedSlot, GenerationRead } from "@/types/api";

const ACTIVE = new Set(["pending", "queued", "running"]);
const PAGE_SIZE = 40;


export default function WorkspacePage() {
  useTaskEvents();

  const [query, setQuery] = useState("");
  const [modelFilter, setModelFilter] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useState<DateFilter>("week");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [detail, setDetail] = useState<FeedItem | null>(null);

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

  // 创作页只处理图片，视频模型在 /video 里；模型目录本身是共用的
  const imageModels = useMemo(
    () => (modelsQuery.data ?? []).filter((model) => model.capabilities.media !== "video"),
    [modelsQuery.data],
  );

  const generationsQuery = useQuery({
    queryKey: ["generations", "image", query, modelFilter, dateFilter, favoriteOnly, limit],
    queryFn: () => {
      const range = dateRangeFor(dateFilter);
      return fetchGenerations({
        limit,
        q: query.trim() || undefined,
        model: modelFilter ?? undefined,
        media: "image",
    hasImages: true,
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

  // 每个任务占一格：已完成的用图片，排队/生成中的用占位卡，图被删掉的不占格。
  const slots: FeedSlot[] = useMemo(() => buildFeedSlots(generations), [generations]);

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
  const actions = useImageActions({
    onToast: toast,
    onDeleted: (imageId) => {
      if (detail?.image.id === imageId) {
        setDetail(null);
      }
    },
    onEdited: () => setDetail(null),
  });

  return (
    <>
      <TopBar
        onToast={toast}
        title="创作"
        query={query}
        onQuery={(value) => {
          setQuery(value);
          setLimit(PAGE_SIZE);
        }}
        models={imageModels}
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

        <Feed
          items={slots}
          view={view}
          loading={generationsQuery.isLoading}
          hasMore={generations.length < total && limit < FEED_PAGE_LIMIT}
          capped={limit >= FEED_PAGE_LIMIT}
          emptyHint={
            generations.length > 0
              ? `这些批次的文件已经被删除（共 ${generations.length} 个），可以到资产页清空工作区，或者直接重新生成。`
              : undefined
          }
          onLoadMore={() => setLimit((current) => Math.min(current + PAGE_SIZE, FEED_PAGE_LIMIT))}
          onOpen={(slot) => { if (slot.image) setDetail({ key: slot.key, image: slot.image, generation: slot.generation, seed: slot.seed }); }}
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
          modelLabels={modelLabels}
        />
      </div>

      {/* 创作框悬浮在作品流之上：absolute 定位，不再占据独立的一段高度 */}
      <Composer models={imageModels} onToast={toast} />

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
