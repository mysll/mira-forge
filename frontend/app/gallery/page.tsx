"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";

import ConfirmDialog from "@/components/ConfirmDialog";
import ImageDetail from "@/components/ImageDetail";
import ToastStack, { type ToastItem } from "@/components/ToastStack";
import TopBar from "@/components/TopBar";
import { useImageActions, type AssetRef } from "@/hooks/useImageActions";
import { useTaskEvents } from "@/hooks/useTaskEvents";
import { clearWorkspace, deleteImages, fetchGenerations, fetchModels, imageThumbnailUrl } from "@/lib/api";
import { bucketOf, dateRangeFor, formatTime, parseIso, type DateBucket, type DateFilter } from "@/lib/date";
import { modelLabel } from "@/lib/models";
import type { FeedItem, GenerationRead, ImageBrief } from "@/types/api";

const ACTIVE = new Set(["pending", "queued", "running"]);
const PAGE_SIZE = 60;
const BUCKETS: DateBucket[] = ["今天", "昨天", "更早"];

type MediaFilter = "all" | "image" | "video" | "asset";

const MEDIA_FILTERS: { value: MediaFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "asset", label: "素材" },
];

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
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [detail, setDetail] = useState<FeedItem | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState<"selected" | "all" | null>(null);
  const [busy, setBusy] = useState(false);

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
    queryKey: ["generations", "gallery", query, modelFilter, dateFilter, favoriteOnly, mediaFilter, limit],
    queryFn: () => {
      const range = dateRangeFor(dateFilter);
      return fetchGenerations({
        limit,
        q: query.trim() || undefined,
        model: modelFilter ?? undefined,
        media: mediaFilter === "all" ? undefined : mediaFilter,
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

  const loadedIds = useMemo(() => assets.map((asset) => asset.image.id), [assets]);
  const allSelected = loadedIds.length > 0 && selected.size === loadedIds.length;

  const toggleOne = (imageId: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(imageId)) {
        next.delete(imageId);
      } else {
        next.add(imageId);
      }
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(loadedIds));
  };

  const startManaging = () => {
    setManaging(true);
    setSelected(new Set());
  };

  const stopManaging = () => {
    setManaging(false);
    setSelected(new Set());
  };

  const removeSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0) {
      return;
    }
    setBusy(true);
    try {
      const result = await deleteImages(ids);
      setConfirm(null);
      setSelected(new Set());
      actions.refresh();
      toast(result.deleted.length > 0 ? `已删除 ${result.deleted.length} 张` : "这些图片已经不在了");
    } catch (error) {
      toast((error as Error).message || "删除失败");
    } finally {
      setBusy(false);
    }
  };

  const wipeWorkspace = async () => {
    setBusy(true);
    try {
      const result = await clearWorkspace();
      setConfirm(null);
      setSelected(new Set());
      setManaging(false);
      actions.refresh();
      toast(`已清空：${result.images} 张图片、${result.generations} 个批次`);
    } catch (error) {
      toast((error as Error).message || "清空失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <TopBar
        onToast={toast}
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
        actions={
          <button
            type="button"
            onClick={managing ? stopManaging : startManaging}
            className={[
              "inline-flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition",
              managing
                ? "border-accent/50 bg-accent/15 text-accentSoft"
                : "border-edge bg-surface2 text-muted hover:text-ink",
            ].join(" ")}
            title={managing ? "退出管理" : "批量选择图片"}
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden>
              <rect x="4" y="4" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
              <rect x="13" y="4" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
              <rect x="4" y="13" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
              <path d="M14.5 17.2 16.4 19l3.1-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {managing ? "完成" : "管理"}
          </button>
        }
      />

      {managing ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-edge/70 bg-surface/70 px-5 py-2">
          <button
            type="button"
            onClick={toggleAll}
            disabled={loadedIds.length === 0}
            className="h-8 rounded-lg border border-edge bg-surface2 px-2.5 text-xs text-ink/90 transition hover:border-accent/40 disabled:opacity-40"
          >
            {allSelected ? "取消全选" : "全选"}
          </button>
          <span className="text-xs text-muted">
            已选 <span className="text-ink">{selected.size}</span> / {loadedIds.length} 张
          </span>
          <span className="hidden text-[11px] text-muted/70 sm:inline">点图片即可选择或取消</span>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setConfirm("selected")}
              disabled={selected.size === 0}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-edge bg-surface2 px-2.5 text-xs text-ink/90 transition hover:border-bad/50 hover:text-bad disabled:opacity-40"
            >
              <TrashIcon />
              删除所选
            </button>
            <button
              type="button"
              onClick={() => setConfirm("all")}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-bad/40 bg-bad/10 px-2.5 text-xs text-bad transition hover:bg-bad/15"
              title="删除全部图片与生成记录，不可恢复"
            >
              <TrashIcon />
              清空工作区
            </button>
          </div>
        </div>
      ) : null}

      <div className="scroll-thin flex-1 overflow-y-auto px-5 pb-10 pt-4">
        <div className="mb-4 flex items-center gap-1.5">
          {MEDIA_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                setMediaFilter(option.value);
                setLimit(PAGE_SIZE);
              }}
              className={[
                "h-7 rounded-full border px-2.5 text-[11px] transition",
                mediaFilter === option.value
                  ? "border-accent/50 bg-accent/15 text-accentSoft"
                  : "border-edge/70 bg-surface text-muted hover:text-ink",
              ].join(" ")}
            >
              {option.label}
            </button>
          ))}
          <span className="ml-1 text-[11px] text-muted/70">
            {mediaFilter === "video"
              ? "视频"
              : mediaFilter === "image"
                ? "图片"
                : mediaFilter === "asset"
                  ? "素材"
                  : "图片、视频与素材"}{" "}
            · {assets.length} 个产物
          </span>
        </div>

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
                    modelLabel={modelLabel(asset.generation.model_name, modelLabels)}
                    selectable={managing}
                    selected={selected.has(asset.image.id)}
                    onToggle={() => toggleOne(asset.image.id)}
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

      <ConfirmDialog
        open={confirm === "selected"}
        title={`删除选中的 ${selected.size} 张图片？`}
        description={
          <>
            图片文件会从磁盘移除，数据库记录一并删除，<span className="text-bad">不可恢复</span>。
            对应的批次会留在作品流里，只是少了几张图。
          </>
        }
        confirmLabel="删除"
        danger
        busy={busy}
        onConfirm={() => void removeSelected()}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm === "all"}
        title="清空工作区？"
        description={
          <>
            会删除全部图片与全部生成记录（当前视图里 {assets.length} 张 / {total} 个批次），
            <span className="text-bad">文件从磁盘移除且无法恢复</span>。模型与工作流配置不受影响。
          </>
        }
        confirmLabel="清空工作区"
        danger
        busy={busy}
        onConfirm={() => void wipeWorkspace()}
        onCancel={() => setConfirm(null)}
      />

      <ToastStack items={toasts} onDismiss={dismissToast} />
    </>
  );
}

function AssetCard({
  asset,
  modelLabel,
  selectable,
  selected,
  onToggle,
  onOpen,
  onFavorite,
  onDownload,
  onDelete,
  onEdit,
}: {
  asset: Asset;
  modelLabel?: string;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onFavorite: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const { image, generation } = asset;
  const [loaded, setLoaded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const isVideo = image.media_type === "video";
  const isAsset = image.media_type === "asset";
  const duration = image.duration_seconds;
  // 素材可能是图集 PNG，也可能是 ZIP / JSON —— 后两种没法当图渲染。
  const isRaster = !isAsset || /\.(png|jpe?g|webp|gif)$/i.test(image.file_path);
  const suffix = isAsset ? (image.file_path.split(".").pop() ?? "").toLowerCase() : "";
  // 素材若是 ZIP，缩略图是服务端从图集第一页抽出来的；JSON 没有缩略图，加载失败就退回文件牌。
  const canPreview = !isAsset || isRaster || !imageFailed;
  const studioHref = isVideo
    ? `/tools/spriteforge?video=${image.id}`
    : isAsset
      ? `/tools/spriteforge?asset=${image.id}`
      : null;

  return (
    <div
      className={[
        "group relative overflow-hidden rounded-xl border bg-surface transition",
        selected ? "border-accent ring-2 ring-accent/40" : "border-edge/70",
        selectable ? "cursor-pointer" : "",
      ].join(" ")}
      onClick={selectable ? onToggle : onOpen}
      role={selectable ? "checkbox" : "button"}
      aria-checked={selectable ? selected : undefined}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (selectable) {
            onToggle();
          } else {
            onOpen();
          }
        }
      }}
      title={selectable ? "点击选择这张图" : `${generation.prompt}\n${formatTime(image.created_at)}`}
    >
      <div className="relative aspect-square w-full overflow-hidden bg-surface2">
        {canPreview ? (
          <>
            {!loaded ? <div className="absolute inset-0 animate-pulse bg-surface2" /> : null}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageThumbnailUrl(image)}
              alt={generation.prompt.slice(0, 60)}
              loading="lazy"
              onLoad={() => setLoaded(true)}
              onError={() => setImageFailed(true)}
              className={[
                "h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]",
                isVideo ? "opacity-95" : "",
              ].join(" ")}
            />
          </>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-3 text-center">
            <span className="rounded-md border border-edge bg-surface px-2 py-1 text-[10px] uppercase tracking-wide text-muted">
              {suffix || "file"}
            </span>
            <span className="line-clamp-2 text-[10px] text-muted/80">{generation.prompt}</span>
          </div>
        )}

        {isVideo ? (
          <>
            {/* 视频用播放键 + 时长标出来，缩略图本身和图片长得一样 */}
            <span className="pointer-events-none absolute inset-0 grid place-items-center">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm transition group-hover:scale-105">
                <svg viewBox="0 0 24 24" className="ml-0.5 h-4 w-4" fill="currentColor" aria-hidden>
                  <path d="M8 5.5v13l11-6.5z" />
                </svg>
              </span>
            </span>
            <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-[10px] text-white/90 backdrop-blur">
              {duration != null && duration > 0 ? `${duration.toFixed(1)} 秒` : "视频"}
            </span>
            <span className="pointer-events-none absolute right-2 top-2 rounded bg-accent/85 px-1.5 py-0.5 text-[10px] text-white">
              视频
            </span>
          </>
        ) : null}

        {isAsset ? (
          <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white/90 backdrop-blur">
            素材 · {suffix || "file"}
          </span>
        ) : null}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/60 to-transparent opacity-0 transition group-hover:opacity-100" />
        <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-end justify-between gap-2 opacity-0 transition group-hover:opacity-100">
          <span className="truncate text-[10px] text-white/85">{modelLabel ?? generation.model_name}</span>
          <span className="shrink-0 text-[10px] text-white/70">{formatTime(image.created_at)}</span>
        </div>
      </div>

      {selectable ? (
        <span
          className={[
            "pointer-events-none absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded-md border transition",
            selected
              ? "border-accent bg-accent text-white"
              : "border-white/70 bg-black/35 text-transparent backdrop-blur",
          ].join(" ")}
          aria-hidden
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none">
            <path d="m5.5 12.5 4.2 4L18.5 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      ) : image.is_favorite ? (
        <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/45 p-1 text-warn">
          <StarIcon filled />
        </span>
      ) : null}

      {selectable ? null : (
        <div className="absolute right-2 top-2 flex flex-col gap-1 opacity-0 transition group-hover:opacity-100">
          <CellAction label={image.is_favorite ? "取消收藏" : "收藏"} onClick={onFavorite} active={image.is_favorite}>
            <StarIcon filled={image.is_favorite} />
          </CellAction>
          {isVideo || isAsset ? null : (
            <CellAction label="继续编辑（AI）" onClick={onEdit}>
              <EditIcon />
            </CellAction>
          )}
          {isVideo || isAsset ? null : (
            <CellAction label="本地编辑（抠底 / 画布）" href={`/tools/editor?image=${image.id}`}>
              <CropIcon />
            </CellAction>
          )}
          {studioHref ? (
            <CellAction label="在序列帧工坊打开" href={studioHref}>
              <GridIcon />
            </CellAction>
          ) : null}
          <CellAction label="下载" onClick={onDownload}>
            <DownloadIcon />
          </CellAction>
          <CellAction label="删除" onClick={onDelete} danger>
            <TrashIcon />
          </CellAction>
        </div>
      )}
    </div>
  );
}

function CellAction({
  label,
  onClick,
  href,
  children,
  active = false,
  danger = false,
}: {
  label: string;
  onClick?: () => void;
  href?: string;
  children: React.ReactNode;
  active?: boolean;
  danger?: boolean;
}) {
  const className = [
    "flex h-6 w-6 items-center justify-center rounded-md bg-black/45 backdrop-blur transition hover:bg-black/65",
    active ? "text-warn" : danger ? "text-white/85 hover:text-bad" : "text-white/85 hover:text-white",
  ].join(" ");

  if (href) {
    return (
      <Link href={href} title={label} className={className} onClick={(event) => event.stopPropagation()}>
        {children}
      </Link>
    );
  }

  return (
    <button
      type="button"
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
      className={className}
    >
      {children}
    </button>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function CropIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <path
        d="M7 3v13a1 1 0 0 0 1 1h13M3 7h13a1 1 0 0 1 1 1v13"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
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
