"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import ImageDetail from "@/components/ImageDetail";
import ToastStack, { type ToastItem } from "@/components/ToastStack";
import TopBar from "@/components/TopBar";
import { useImageActions, type AssetRef } from "@/hooks/useImageActions";
import { useTaskEvents } from "@/hooks/useTaskEvents";
import { fetchGenerations, fetchModels, imageThumbnailUrl } from "@/lib/api";
import { bucketOf, dateRangeFor, formatTime, parseIso, type DateBucket, type DateFilter } from "@/lib/date";
import type { FeedItem, GenerationRead, ImageBrief } from "@/types/api";

const ACTIVE = new Set(["pending", "queued", "running"]);
const PAGE_SIZE = 60;
const BUCKETS: DateBucket[] = ["今天", "昨天", "更早"];

type Asset = AssetRef;

/**
 * 资产库：只做浏览。按生成时间从新到旧、按日期分组铺成响应式网格，
 * 不按批次分块——同一批的几张图在这里只是时间相邻。
 */
export default function GalleryPage() {
  useTaskEvents();

  const [query, setQuery] = useState("");
  const [modelFilter, setModelFilter] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [detail, setDetail] = useState<FeedItem | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = (text: string) => {
    setToasts((current) => [...current, { id: Date.now() + Math.random(), text }]);
  };
  const dismissToast = (id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  };

  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: fetchModels,
    staleTime: 60_000,
  });

  const generationsQuery = useQuery({
    queryKey: ["generations", "gallery", query, modelFilter, dateFilter, favoriteOnly, limit],
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
      return active ? 2000 : false;
    },
  });

  const generations: GenerationRead[] = generationsQuery.data?.items ?? [];
  const total = generationsQuery.data?.total ?? 0;

  const modelLabels = useMemo(
    () =>
      Object.fromEntries(
        (modelsQuery.data ?? []).map((model) => [
          model.id,
          model.label.replace(/^Qwen Image /, "Qwen "),
        ]),
      ),
    [modelsQuery.data],
  );

  // 展平成图片列表，按生成时间倒序；同一批里先出的排后面
  const assets: Asset[] = useMemo(() => {
    const flat: Asset[] = generations.flatMap((generation) =>
      generation.images.map((image) => ({ image, generation })),
    );
    return flat.sort((left, right) => {
      const delta = parseIso(right.image.created_at).getTime() - parseIso(left.image.created_at).getTime();
      return delta !== 0 ? delta : right.image.id - left.image.id;
    });
  }, [generations]);

  const groups = useMemo(() => {
    const map = new Map<DateBucket, Asset[]>();
    for (const asset of assets) {
      const bucket = bucketOf(asset.image.created_at);
      map.set(bucket, [...(map.get(bucket) ?? []), asset]);
    }
    return BUCKETS.filter((bucket) => map.has(bucket)).map((bucket) => ({
      bucket,
      items: map.get(bucket)!,
    }));
  }, [assets]);

  const actions = useImageActions({
    onToast: toast,
    onDeleted: (imageId) => {
      if (detail?.image.id === imageId) {
        setDetail(null);
      }
    },
    onEdited: () => setDetail(null),
  });

  const openDetail = (asset: Asset) => {
    const task = asset.generation.tasks.find((item) => item.id === asset.image.task_id) ?? null;
    setDetail({
      key: `${asset.generation.id}-i${asset.image.id}`,
      image: asset.image,
      generation: asset.generation,
      seed: task?.seed ?? null,
    });
  };

  return (
    <>
      <TopBar
        title="资产"
        viewToggle={false}
        countText={`${assets.length} 张`}
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
        view="grid"
        onView={() => {}}
        total={total}
      />

      <div className="scroll-thin flex-1 overflow-y-auto px-5 pb-10 pt-4">
        {generationsQuery.isLoading ? (
          <p className="text-xs text-muted">正在读取资产…</p>
        ) : assets.length === 0 ? (
          <div className="mt-24 flex flex-col items-center gap-2 text-center">
            <p className="text-sm text-ink/80">这里还没有图片</p>
            <p className="text-xs text-muted">去左侧「图片」生成第一批，出图后会自动出现在这里</p>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.bucket} className="mb-7">
              <header className="mb-2.5 flex items-baseline gap-2">
                <h2 className="text-sm text-ink/90">{group.bucket}</h2>
                <span className="text-[11px] text-muted">{group.items.length} 张</span>
              </header>
              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))" }}
              >
                {group.items.map((asset) => (
                  <AssetCard
                    key={asset.image.id}
                    asset={asset}
                    modelLabel={modelLabels[asset.generation.model_name]}
                    onOpen={() => openDetail(asset)}
                    onFavorite={() => actions.favorite(asset)}
                    onDownload={() => void actions.download(asset)}
                    onDelete={() => void actions.remove(asset)}
                    onEdit={() => actions.edit(asset)}
                  />
                ))}
              </div>
            </section>
          ))
        )}

        {assets.length > 0 && generations.length < total ? (
          <div className="flex justify-center py-3">
            <button
              type="button"
              onClick={() => setLimit((current) => current + PAGE_SIZE)}
              disabled={generationsQuery.isFetching}
              className="rounded-lg border border-edge bg-surface px-3 py-1.5 text-xs text-muted transition hover:text-ink disabled:opacity-50"
            >
              {generationsQuery.isFetching ? "加载中…" : "加载更多"}
            </button>
          </div>
        ) : null}
      </div>

      {detail ? (
        <ImageDetail
          item={detail}
          onClose={() => setDetail(null)}
          onFavorite={(item) => actions.favorite({ image: item.image, generation: item.generation })}
          onDownload={(item) => void actions.download({ image: item.image, generation: item.generation })}
          onDelete={(item) => void actions.remove({ image: item.image, generation: item.generation })}
          onEdit={(item) => actions.edit({ image: item.image, generation: item.generation })}
          onRegenerate={(item) =>
            actions.regenerate({ image: item.image, generation: item.generation })
          }
          onToast={toast}
          modelLabels={modelLabels}
        />
      ) : null}

      <ToastStack items={toasts} onDismiss={dismissToast} />
    </>
  );
}

function AssetCard({
  asset,
  modelLabel,
  onOpen,
  onFavorite,
  onDownload,
  onDelete,
  onEdit,
}: {
  asset: Asset;
  modelLabel?: string;
  onOpen: () => void;
  onFavorite: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const { image, generation } = asset;
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="group relative overflow-hidden rounded-xl border border-edge/70 bg-surface">
      <button
        type="button"
        onClick={onOpen}
        className="block w-full"
        title={`${generation.prompt}\n${formatTime(image.created_at)}`}
      >
        <div className="relative aspect-square w-full overflow-hidden bg-surface2">
          {!loaded ? <div className="absolute inset-0 animate-pulse bg-surface2" /> : null}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageThumbnailUrl(image)}
            alt={generation.prompt.slice(0, 60)}
            loading="lazy"
            onLoad={() => setLoaded(true)}
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
          />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/60 to-transparent opacity-0 transition group-hover:opacity-100" />
          <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-end justify-between gap-2 opacity-0 transition group-hover:opacity-100">
            <span className="truncate text-[10px] text-white/85">{modelLabel ?? generation.model_name}</span>
            <span className="shrink-0 text-[10px] text-white/70">{formatTime(image.created_at)}</span>
          </div>
        </div>
      </button>

      {image.is_favorite ? (
        <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/45 p-1 text-warn">
          <StarIcon filled />
        </span>
      ) : null}

      <div className="absolute right-2 top-2 flex flex-col gap-1 opacity-0 transition group-hover:opacity-100">
        <CellAction label={image.is_favorite ? "取消收藏" : "收藏"} onClick={onFavorite} active={image.is_favorite}>
          <StarIcon filled={image.is_favorite} />
        </CellAction>
        <CellAction label="继续编辑" onClick={onEdit}>
          <EditIcon />
        </CellAction>
        <CellAction label="下载" onClick={onDownload}>
          <DownloadIcon />
        </CellAction>
        <CellAction label="删除" onClick={onDelete} danger>
          <TrashIcon />
        </CellAction>
      </div>
    </div>
  );
}

function CellAction({
  label,
  onClick,
  children,
  active = false,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={[
        "flex h-6 w-6 items-center justify-center rounded-md bg-black/45 backdrop-blur transition hover:bg-black/65",
        active ? "text-warn" : danger ? "text-white/85 hover:text-bad" : "text-white/85 hover:text-white",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function StarIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <path
        d="m12 4.6 2.3 4.7 5.2.8-3.8 3.7.9 5.1-4.6-2.4-4.6 2.4.9-5.1L4.5 10l5.2-.8L12 4.6Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        fill={filled ? "currentColor" : "none"}
      />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <path
        d="M4 20h4.2l9.4-9.4a2.3 2.3 0 0 0 0-3.2l-1-1a2.3 2.3 0 0 0-3.2 0L4 15.8V20Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <path
        d="M12 4v10m0 0 3.5-3.5M12 14 8.5 10.5M5 17.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <path
        d="M5 7h14M9.5 7V5.5h5V7M7 7l.8 11.2a1 1 0 0 0 1 .8h6.4a1 1 0 0 0 1-.8L17 7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
