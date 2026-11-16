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
import type { FeedItem, FeedSlot, GenerationRead, ImageBrief } from "@/types/api";

const ACTIVE = new Set(["pending", "queued", "running"]);
type CardRef = { image: ImageBrief; generation: GenerationRead };
const PAGE_SIZE = 40;


export default function WorkspacePage() {
  const queryClient = useQueryClient();
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

  // 每个任务占一格：已完成的用图片，排队/生成中的用占位卡，这样新批次一提交就出现在最终位置。
  const slots: FeedSlot[] = useMemo(() => {
    const flat: FeedSlot[] = [];
    for (const generation of generations) {
      const tasks = [...generation.tasks].sort((left, right) => left.id - right.id);
      const imageByTask = new Map(generation.images.map((image) => [image.task_id, image]));
      tasks.forEach((task, position) => {
        const image = imageByTask.get(task.id) ?? null;
        // 已完成的图被用户删掉后，占位卡没有意义，直接跳过（批次里剩下的照样显示）
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
      // 兜底：没有对应任务的图（例如任务行被删）也要显示出来
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

  const onFavorite = (item: CardRef) => {
    const next = !item.image.is_favorite;
    void setImageFavorite(item.image.id, next)
      .then(() => {
        invalidate();
        toast(next ? "已收藏" : "已取消收藏");
      })
      .catch((error: Error) => toast(error.message || "操作失败"));
  };

  const onDownload = async (item: CardRef) => {
    try {
      const response = await fetch(imageFileUrl(item.image));
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

  const onDelete = async (item: CardRef) => {
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

  const onEdit = (item: CardRef) => {
    setDetail(null);
    useReferenceStore.getState().setImage({
      id: item.image.id,
      url: imageFileUrl(item.image),
    });
    toast("已作为参考图，写在下方提示词里描述要改成什么");
  };

  const onRegenerate = (item: CardRef) => {
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

        <Feed
          items={slots}
          view={view}
          loading={generationsQuery.isLoading}
          hasMore={generations.length < total}
          onLoadMore={() => setLimit((current) => current + PAGE_SIZE)}
          onOpen={(slot) => { if (slot.image) setDetail({ key: slot.key, image: slot.image, generation: slot.generation, seed: slot.seed }); }}
          onFavorite={(slot) => {
            if (slot.image) onFavorite({ image: slot.image, generation: slot.generation });
          }}
          onDownload={(slot) => {
            if (slot.image) void onDownload({ image: slot.image, generation: slot.generation });
          }}
          onDelete={(slot) => {
            if (slot.image) void onDelete({ image: slot.image, generation: slot.generation });
          }}
          onEdit={(slot) => {
            if (slot.image) onEdit({ image: slot.image, generation: slot.generation });
          }}
          modelLabels={modelLabels}
        />
      </div>

      {/* 创作框悬浮在作品流之上：absolute 定位，不再占据独立的一段高度 */}
      <Composer models={modelsQuery.data ?? []} onToast={toast} />

      {detail ? (
        <ImageDetail
          item={detail}
          onClose={() => setDetail(null)}
          onFavorite={(item) => onFavorite({ image: item.image, generation: item.generation })}
          onDownload={(item) => void onDownload({ image: item.image, generation: item.generation })}
          onDelete={(item) => void onDelete({ image: item.image, generation: item.generation })}
          onEdit={(item) => onEdit({ image: item.image, generation: item.generation })}
          onRegenerate={(item) => onRegenerate({ image: item.image, generation: item.generation })}
          onToast={toast}
          modelLabels={modelLabels}
        />
      ) : null}

      <ToastStack items={toasts} onDismiss={dismissToast} />
    </>
  );
}