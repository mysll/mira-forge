"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import ConfirmDialog from "@/components/ConfirmDialog";
import ImageDetail from "@/components/ImageDetail";
import ToastStack, { type ToastItem } from "@/components/ToastStack";
import TopBar from "@/components/TopBar";
import { useImageActions, type AssetRef } from "@/hooks/useImageActions";
import { useTaskEvents } from "@/hooks/useTaskEvents";
import { clearWorkspace, deleteImages, fetchGenerations, fetchLayerSets, fetchModels, fetchScenes, imageThumbnailUrl, FEED_PAGE_LIMIT } from "@/lib/api";
import { bucketOf, dateRangeFor, formatTime, parseIso, type DateBucket, type DateFilter } from "@/lib/date";
import { modelLabel } from "@/lib/models";
import type { FeedItem, GenerationRead, ImageBrief, SceneRead } from "@/types/api";

const ACTIVE = new Set(["pending", "queued", "running"]);
const PAGE_SIZE = 60;
const BUCKETS: DateBucket[] = ["今天", "昨天", "更早"];

type MediaFilter = "all" | "image" | "video" | "asset" | "scene" | "scene_layer";

const MEDIA_FILTERS: { value: MediaFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "asset", label: "素材" },
  { value: "scene", label: "场景" },
  { value: "scene_layer", label: "场景分层" },
];

type Asset = AssetRef;

/**
 * 场景分层产物太多，一张场景往往几十张分层图。
 * 同属一个场景的分层图在这里收成一张「多层」卡片，点开直接进分层工作台。
 */
type GalleryEntry =
  | { kind: "single"; key: string; asset: Asset }
  | {
      kind: "layers";
      key: string;
      sceneId: number;
      /** 按时间倒序，第一个是最近出的那张 */
      items: Asset[];
      latest: Asset;
    };

function entryAsset(entry: GalleryEntry): Asset {
  return entry.kind === "single" ? entry.asset : entry.latest;
}

function entryImageIds(entry: GalleryEntry): number[] {
  return entry.kind === "single" ? [entry.asset.image.id] : entry.items.map((item) => item.image.id);
}

/** 卡片属于哪个场景：分层卡片看聚合的 sceneId，场景底图看图片自己的 scene_id。 */
function sceneOfEntry(entry: GalleryEntry, scenes: Map<number, SceneRead>): SceneRead | null {
  const sceneId = entry.kind === "layers" ? entry.sceneId : entry.asset.image.scene_id;
  return sceneId ? scenes.get(sceneId) ?? null : null;
}

/**
 * 资产库：只做浏览。按生成时间从新到旧、按日期分组铺成响应式网格，
 * 不按批次分块——同一批的几张图在这里只是时间相邻。
 */
export default function GalleryPage() {
  useTaskEvents();
  const router = useRouter();

  const [query, setQuery] = useState("");
  const [modelFilter, setModelFilter] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useState<DateFilter>("week");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [detail, setDetail] = useState<FeedItem | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState<"selected" | "all" | null>(null);
  const [busy, setBusy] = useState(false);
  const [openingScene, setOpeningScene] = useState<number | null>(null);

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

  // 分层卡片的封面用「场景底图」，最新的那张分层图往往是纯雾/纯背景，看不出是哪个场景
  const scenesQuery = useQuery({
    queryKey: ["scenes"],
    queryFn: fetchScenes,
    staleTime: 30_000,
  });

  const scenesById = useMemo(() => {
    const map = new Map<number, SceneRead>();
    for (const scene of scenesQuery.data?.items ?? []) {
      map.set(scene.id, scene);
    }
    return map;
  }, [scenesQuery.data]);

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
        excludeElement: true,
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

  const entries: GalleryEntry[] = useMemo(() => {
    const stacks = new Map<number, Asset[]>();
    const singles: GalleryEntry[] = [];
    for (const asset of assets) {
      if (asset.image.media_type === "scene_layer" && asset.image.scene_id) {
        const list = stacks.get(asset.image.scene_id) ?? [];
        list.push(asset);
        stacks.set(asset.image.scene_id, list);
      } else {
        singles.push({ kind: "single", key: `i${asset.image.id}`, asset });
      }
    }
    const stacked: GalleryEntry[] = [...stacks].map(([sceneId, items]) => ({
      kind: "layers",
      key: `s${sceneId}`,
      sceneId,
      items,
      latest: items[0],
    }));
    const timeOf = (entry: GalleryEntry) =>
      parseIso(entryAsset(entry).image.created_at).getTime();
    return [...singles, ...stacked].sort((left, right) => {
      const delta = timeOf(right) - timeOf(left);
      return delta !== 0 ? delta : entryAsset(right).image.id - entryAsset(left).image.id;
    });
  }, [assets]);

  const groups = useMemo(() => {
    const map = new Map<DateBucket, GalleryEntry[]>();
    for (const entry of entries) {
      const bucket = bucketOf(entryAsset(entry).image.created_at);
      map.set(bucket, [...(map.get(bucket) ?? []), entry]);
    }
    return BUCKETS.filter((bucket) => map.has(bucket)).map((bucket) => ({
      bucket,
      items: map.get(bucket)!,
    }));
  }, [entries]);

  const actions = useImageActions({
    onToast: toast,
    onDeleted: (imageId) => {
      if (detail?.image.id === imageId) {
        setDetail(null);
      }
    },
    onEdited: () => setDetail(null),
  });

  /** 分层卡片没有单张图可看：直接落到该场景的分层工作台（源图用这套方案记的那张）。 */
  const openLayers = async (sceneId: number) => {
    if (openingScene !== null) {
      return;
    }
    setOpeningScene(sceneId);
    try {
      const sets = await fetchLayerSets(sceneId);
      const source = sets.items.find((item) => item.source_image_id)?.source_image_id ?? null;
      router.push(source ? `/scenes/${sceneId}/layers/${source}` : `/scenes/${sceneId}`);
    } catch {
      router.push(`/scenes/${sceneId}`);
    } finally {
      setOpeningScene(null);
    }
  };

  const openEntry = (entry: GalleryEntry) => {
    // 分层产物按场景聚成一张卡，点开进分层工作台，而不是先进场景页
    if (entry.kind === "layers") {
      void openLayers(entry.sceneId);
      return;
    }
    const asset = entry.asset;
    // 场景底图不属于作品流：点开直接回到它所属的场景页，在那里继续生成 / 分层
    if (asset.image.scene_id) {
      router.push(`/scenes/${asset.image.scene_id}`);
      return;
    }
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

  /** 分层卡片代表这个场景的全部分层图：一次选中 / 取消选中它们全部。 */
  const toggleEntry = (entry: GalleryEntry) => {
    const ids = entryImageIds(entry);
    setSelected((current) => {
      const next = new Set(current);
      const allIn = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allIn) {
          next.delete(id);
        } else {
          next.add(id);
        }
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
              title="把全部产物移进回收站，30 天内可恢复"
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
                  : mediaFilter === "scene"
                    ? "场景底图"
                    : mediaFilter === "scene_layer"
                      ? "场景分层"
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
                {group.items.map((entry) => (
                  <AssetCard
                    key={entry.key}
                    entry={entry}
                    scene={sceneOfEntry(entry, scenesById)}
                    modelLabel={modelLabel(entryAsset(entry).generation.model_name, modelLabels)}
                    selectable={managing}
                    selected={entryImageIds(entry).every((id) => selected.has(id))}
                    onToggle={() => toggleEntry(entry)}
                    onOpen={() => openEntry(entry)}
                    onFavorite={() => actions.favorite(entryAsset(entry))}
                    onDownload={() => void actions.download(entryAsset(entry))}
                    onDelete={() => void actions.remove(entryAsset(entry))}
                    onEdit={() => actions.edit(entryAsset(entry))}
                  />
                ))}
              </div>
            </section>
          ))
        )}

        {assets.length > 0 && generations.length < total && limit < FEED_PAGE_LIMIT ? (
          <div className="flex justify-center py-3">
            <button
              type="button"
              onClick={() => setLimit((current) => Math.min(current + PAGE_SIZE, FEED_PAGE_LIMIT))}
              disabled={generationsQuery.isFetching}
              className="rounded-lg border border-edge bg-surface px-3 py-1.5 text-xs text-muted transition hover:text-ink disabled:opacity-50"
            >
              {generationsQuery.isFetching ? "加载中…" : "加载更多"}
            </button>
          </div>
        ) : null}
        {assets.length > 0 && generations.length < total && limit >= FEED_PAGE_LIMIT ? (
          <p className="py-3 text-center text-xs text-muted">
            只列出最近 {FEED_PAGE_LIMIT} 个批次 —— 用搜索、模型或日期筛选继续找更早的内容。
          </p>
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
            图片会从作品流移到<span className="text-ink">回收站</span>，30 天内都可以恢复；
            过期或被清空回收站时才真正从磁盘删除。对应的批次会留在作品流里，只是少了几张图。
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
            会把全部图片与生成记录移进<span className="text-ink">回收站</span>（当前视图里 {assets.length} 张 /{" "}
            {total} 个批次），30 天内都能恢复；只有清空回收站才会真正删掉文件。模型与工作流配置不受影响。
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
  entry,
  scene,
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
  entry: GalleryEntry;
  /** 分层卡片对应的场景：拿它的名字与底图当封面 */
  scene?: SceneRead | null;
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
  const stack = entry.kind === "layers" ? entry : null;
  const { image, generation } = entryAsset(entry);
  // 分层卡片用场景底图当封面：最新那张分层图常常是纯雾 / 纯背景，认不出是哪个场景
  const cover: { id: number; created_at?: string } =
    stack && scene?.cover_image_id
      ? { id: scene.cover_image_id, created_at: scene.cover_image_created_at ?? undefined }
      : image;
  const [loaded, setLoaded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const isVideo = image.media_type === "video";
  const isAsset = image.media_type === "asset";
  const isFrameSet = image.media_type === "frameset";
  const duration = image.duration_seconds;
  // 素材可能是图集 PNG，也可能是 ZIP / JSON —— 后两种没法当图渲染。帧集同理（整包 zip）。
  const isRaster =
    (!isAsset && !isFrameSet) || /\.(png|jpe?g|webp|gif)$/i.test(image.file_path);
  const suffix =
    isAsset || isFrameSet ? (image.file_path.split(".").pop() ?? "").toLowerCase() : "";
  // 素材与帧集的缩略图都由服务端从封面帧抽出来；JSON 没有缩略图，加载失败就退回文件牌。
  const canPreview = (!isAsset && !isFrameSet) || isRaster || !imageFailed;
  // 下游工具：帧集回抽帧台调偏移，视频 / 素材进序列帧工坊
  const studioHref = isFrameSet
    ? `/tools/frames?frameset=${image.id}`
    : isVideo
      ? `/tools/spriteforge?video=${image.id}`
      : isAsset
        ? `/tools/spriteforge?asset=${image.id}`
        : null;
  const studioLabel = isFrameSet ? "在抽帧台打开" : "在序列帧工坊打开";
  // 卡片顶部：左上角是名称、右上角是类型，图 / 视频 / 素材 / 序列帧都一个样式。
  // 素材里混着两类东西：工坊导出的精灵图（model_name = "spriteforge"）和本地编辑器存的图，
  // 所以类型不能只看 media_type，还要看是哪个工具产出的。
  const typeLabel = isFrameSet
    ? "序列帧"
    : isVideo
      ? "视频"
      : image.media_type === "scene_layer"
        ? "场景分层"
        : image.media_type === "scene"
          ? "场景"
          : isAsset
            ? generation.model_name === "spriteforge"
              ? "精灵图"
              : generation.model_name === "local_editor"
                ? "本地编辑"
                : "素材"
            : "图片";
  // 名称用批次名（工坊图集名 / 帧集名 / 用户改过的名字）；没起名就退回批次编号。
  // 场景产物例外：用场景名，比「批次 #11」有用得多。
  const batchName = (generation.name ?? "").trim() || `批次 #${generation.id}`;
  const sceneName = (scene?.name ?? "").trim();
  const cardName = stack
    ? `${sceneName || `场景 #${stack.sceneId}`} · 分层`
    : image.media_type === "scene" && sceneName
      ? sceneName
      : generation.images.length > 1
        ? `${batchName} · 第 ${generation.images.findIndex((item) => item.id === image.id) + 1} 个`
        : batchName;
  const typeBadge =
    "shrink-0 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white/90 backdrop-blur";
  const nameBadge =
    "min-w-0 truncate rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white/85 backdrop-blur";

  const card = (
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
      <div
        className="relative aspect-square w-full overflow-hidden bg-surface2"
        // 素材与帧集的封面常常是透明底 PNG：垫一层棋盘格，免得看着像加载失败。
        style={
          isAsset || isFrameSet
            ? {
                backgroundImage:
                  "repeating-conic-gradient(#181c23 0% 25%, #11141a 0% 50%)",
                backgroundSize: "18px 18px",
              }
            : undefined
        }
      >
        {canPreview ? (
          <>
            {!loaded ? <div className="absolute inset-0 animate-pulse bg-surface2" /> : null}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageThumbnailUrl(cover)}
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
              {isFrameSet ? "序列帧" : suffix || "file"}
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
          </>
        ) : null}

        {isFrameSet ? (
          <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-[10px] text-white/90 backdrop-blur">
            {image.frame_count ?? 0} 帧
          </span>
        ) : null}

        {stack ? (
          <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-[10px] text-white/90 backdrop-blur">
            {stack.items.length} 张分层图
          </span>
        ) : null}

        {/* 顶部一行：左边名称（管理模式下前面先放勾选框），右边类型 */}
        <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-nowrap items-start justify-between gap-1.5">
          <span className="flex min-w-0 flex-1 items-center gap-1">
            {selectable ? (
              <span
                className={[
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition",
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
              <span className="shrink-0 rounded bg-black/45 p-1 text-warn">
                <StarIcon filled />
              </span>
            ) : null}
            {cardName ? <span className={nameBadge} title={cardName}>{cardName}</span> : null}
          </span>
          <span className={typeBadge}>{typeLabel}</span>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/60 to-transparent opacity-0 transition group-hover:opacity-100" />
        <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-end justify-between gap-2 opacity-0 transition group-hover:opacity-100">
          <span className="truncate text-[10px] text-white/85">{modelLabel ?? generation.model_name}</span>
          <span className="shrink-0 text-[10px] text-white/70">{formatTime(image.created_at)}</span>
        </div>
      </div>

      {selectable ? null : (
        <div className="absolute right-2 top-2 flex flex-col gap-1 opacity-0 transition group-hover:opacity-100">
          <CellAction label={image.is_favorite ? "取消收藏" : "收藏"} onClick={onFavorite} active={image.is_favorite}>
            <StarIcon filled={image.is_favorite} />
          </CellAction>
          {stack ? null : (
            <>
              {isVideo || isAsset || isFrameSet ? null : (
                <CellAction label="继续编辑（AI）" onClick={onEdit}>
                  <EditIcon />
                </CellAction>
              )}
              {isVideo || isAsset || isFrameSet ? null : (
                <CellAction label="本地编辑（抠底 / 画布）" href={`/tools/editor?image=${image.id}`}>
                  <CropIcon />
                </CellAction>
              )}
              {studioHref ? (
                <CellAction label={studioLabel} href={studioHref}>
                  <GridIcon />
                </CellAction>
              ) : null}
            </>
          )}
          <CellAction label="下载" onClick={onDownload}>
            <DownloadIcon />
          </CellAction>
          {stack ? null : (
            <CellAction label="删除" onClick={onDelete} danger>
              <TrashIcon />
            </CellAction>
          )}
        </div>
      )}
    </div>
  );

  if (!stack) {
    return card;
  }

  // 多层卡片：主体后面垫两张错开的「纸」，看起来是一叠层图而不是单张图
  return (
    <div className="relative pt-3">
      <div className="pointer-events-none absolute inset-x-2 top-0 h-4 rounded-t-xl border border-edge/50 bg-surface2/50" />
      <div className="pointer-events-none absolute inset-x-4 top-1.5 h-3 rounded-t-xl border border-edge/70 bg-surface2/80" />
      {card}
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
