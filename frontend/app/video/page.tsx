"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import Feed from "@/components/Feed";
import ImageDetail from "@/components/ImageDetail";
import ToastStack, { type ToastItem } from "@/components/ToastStack";
import TopBar from "@/components/TopBar";
import VideoComposer from "@/components/VideoComposer";
import { useImageActions } from "@/hooks/useImageActions";
import { useTaskEvents } from "@/hooks/useTaskEvents";
import { fetchGenerations, fetchModels } from "@/lib/api";
import { dateRangeFor, type DateFilter } from "@/lib/date";
import type { FeedItem, FeedSlot, GenerationRead } from "@/types/api";

const ACTIVE = new Set(["pending", "queued", "running"]);
const PAGE_SIZE = 40;

/** 视频工作台：作品流只显示视频，底部是视频创作框。 */
export default function VideoPage() {
  useTaskEvents();

  const [query, setQuery] = useState("");
  const [modelFilter, setModelFilter] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useState<DateFilter>("today");
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

  const videoModels = useMemo(
    () => (modelsQuery.data ?? []).filter((model) => model.capabilities.media === "video"),
    [modelsQuery.data],
  );

  // 默认落在第一个视频模型上；用户也可以在下拉里切换到「全部」
  useEffect(() => {
    if (modelFilter === null && videoModels.length > 0) {
      setModelFilter(videoModels[0].id);
    }
  }, [modelFilter, videoModels]);

  const generationsQuery = useQuery({
    queryKey: ["generations", "video", query, modelFilter, dateFilter, favoriteOnly, limit],
    queryFn: () => {
      const range = dateRangeFor(dateFilter);
      return fetchGenerations({
        limit,
        q: query.trim() || undefined,
        // 视频页永远只捞视频，类型过滤比枚举模型 id 更可靠
        media: "video",
        model: modelFilter ?? undefined,
        favorite: favoriteOnly || undefined,
        dateFrom: range.from,
        dateTo: range.to,
      });
    },
    enabled: !modelsQuery.isLoading,
    refetchInterval: (q) => {
      const data = q.state.data;
      const active = data?.items.some((item) => ACTIVE.has(item.status));
      return active ? 1500 : false;
    },
  });

  const generations: GenerationRead[] = generationsQuery.data?.items ?? [];
  const total = generationsQuery.data?.total ?? 0;

  // 每条视频一个任务，所以一张批次卡就是一格；排队/生成中走占位卡
  const slots: FeedSlot[] = useMemo(() => {
    const flat: FeedSlot[] = [];
    for (const generation of generations) {
      const tasks = [...generation.tasks].sort((left, right) => left.id - right.id);
      const imageByTask = new Map(generation.images.map((image) => [image.task_id, image]));
      tasks.forEach((task, position) => {
        const image = imageByTask.get(task.id) ?? null;
        if (!image && task.status === "completed") {
          return;
        }
        flat.push({
          key: `${generation.id}-t${task.id}`,
          generation,
          image,
          task,
          index: position + 1,
          total: tasks.length,
          seed: task.seed,
        });
      });
      const orphans = generation.images.filter(
        (image) => image.task_id === null || !tasks.some((task) => task.id === image.task_id),
      );
      orphans.forEach((image, position) => {
        flat.push({
          key: `${generation.id}-i${image.id}`,
          generation,
          image,
          task: null,
          index: tasks.length + position + 1,
          total: tasks.length + orphans.length,
          seed: null,
        });
      });
    }
    return flat;
  }, [generations]);

  const modelLabels = useMemo(
    () => Object.fromEntries(videoModels.map((model) => [model.id, model.label])),
    [videoModels],
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

  // 视频没有「编辑成图片」这条路：重新生成要改的都是视频参数，交给上面的创作框
  const notEditable = useCallback(() => {
    toast("视频没有图片编辑；要改内容请在上方创作框重新生成");
  }, [toast]);

  return (
    <>
      <TopBar
        onToast={toast}
        title="视频"
        query={query}
        onQuery={(value) => {
          setQuery(value);
          setLimit(PAGE_SIZE);
        }}
        models={videoModels}
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

      <div className="scroll-thin flex-1 overflow-y-auto px-5 pb-[250px] pt-4">
        <Feed
          items={slots}
          view={view}
          loading={generationsQuery.isLoading}
          hasMore={generations.length < total}
          onLoadMore={() => setLimit((current) => current + PAGE_SIZE)}
          cardWidth={340}
          unit="条"
          onOpen={(slot) => {
            if (slot.image) {
              setDetail({ key: slot.key, image: slot.image, generation: slot.generation, seed: slot.seed });
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
          onEdit={() => notEditable()}
          modelLabels={modelLabels}
        />
      </div>

      <VideoComposer models={videoModels} onToast={toast} />

      {detail ? (
        <ImageDetail
          item={detail}
          onClose={() => setDetail(null)}
          onFavorite={(item) => actions.favorite({ image: item.image, generation: item.generation })}
          onDownload={(item) => void actions.download({ image: item.image, generation: item.generation })}
          onDelete={(item) => void actions.remove({ image: item.image, generation: item.generation })}
          onEdit={() => notEditable()}
          onRegenerate={() => notEditable()}
          onToast={toast}
          modelLabels={modelLabels}
        />
      ) : null}

      <ToastStack items={toasts} onDismiss={dismissToast} />
    </>
  );
}
