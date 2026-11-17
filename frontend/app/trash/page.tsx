"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import ConfirmDialog from "@/components/ConfirmDialog";
import ProjectSwitcher from "@/components/ProjectSwitcher";
import ToastStack, { type ToastItem } from "@/components/ToastStack";
import {
  clearRecycleBin,
  deleteRecycleItem,
  fetchRecycleBin,
  imageThumbnailUrl,
  restoreRecycleItems,
  type RecycleItem,
} from "@/lib/api";
import { formatTime } from "@/lib/date";

type MediaFilter = "all" | "image" | "video" | "asset";

const MEDIA_FILTERS: { value: MediaFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "asset", label: "素材" },
];

const TYPE_LABELS: Record<string, string> = {
  text_to_image: "文生图",
  image_to_image: "参考图生成",
  image_edit: "图片编辑",
  local_edit: "本地编辑",
  local_asset: "素材",
  text_to_video: "文生视频",
  image_to_video: "图生视频",
};

/**
 * 回收站：删掉的产物在这里躺 30 天。
 *
 * 删除本身是软删除（打 `deleted_at`），文件还在盘上；只有「彻底删除」「清空回收站」
 * 与过期清理才真的删文件。恢复时所属任务与批次一起解冻，产物立刻回到作品流。
 */
export default function TrashPage() {
  const queryClient = useQueryClient();
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: "clear" } | { kind: "one"; item: RecycleItem } | null>(
    null,
  );

  const toast = (text: string) => {
    setToasts((current) => [...current, { id: Date.now() + Math.random(), text }]);
  };
  const dismissToast = (id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  };

  const binQuery = useQuery({
    queryKey: ["recycle-bin", mediaFilter],
    queryFn: () => fetchRecycleBin({ media: mediaFilter === "all" ? undefined : mediaFilter }),
  });

  const items = binQuery.data?.items ?? [];
  const retentionDays = binQuery.data?.retention_days ?? 30;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["recycle-bin"] });
    // 恢复会影响作品流与资产库，一起刷新
    void queryClient.invalidateQueries({ queryKey: ["generations"] });
    void queryClient.invalidateQueries({ queryKey: ["images"] });
  };

  const restore = async (ids: number[]) => {
    if (ids.length === 0) {
      return;
    }
    setBusy(true);
    try {
      const result = await restoreRecycleItems(ids);
      refresh();
      const restored = result.restored.length;
      const missing = result.missing.length;
      toast(
        restored > 0
          ? missing > 0
            ? `已恢复 ${restored} 件，另有 ${missing} 件找不到了`
            : `已恢复 ${restored} 件`
          : "这些产物已经不在了",
      );
    } catch (error) {
      toast((error as Error).message || "恢复失败");
    } finally {
      setBusy(false);
    }
  };

  const deleteForever = async (imageId: number) => {
    setBusy(true);
    try {
      await deleteRecycleItem(imageId);
      setConfirm(null);
      refresh();
      toast("已彻底删除");
    } catch (error) {
      toast((error as Error).message || "删除失败");
    } finally {
      setBusy(false);
    }
  };

  const wipe = async () => {
    setBusy(true);
    try {
      const result = await clearRecycleBin();
      setConfirm(null);
      refresh();
      toast(result.deleted > 0 ? `已彻底删除 ${result.deleted} 件` : "回收站本来就是空的");
    } catch (error) {
      toast((error as Error).message || "清空失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-edge/70 px-5">
        <ProjectSwitcher onToast={toast} />
        <h1 className="shrink-0 whitespace-nowrap text-sm font-medium text-ink">回收站</h1>
        <span className="hidden text-xs text-muted sm:inline">
          {items.length} 件 · {retentionDays} 天后自动彻底删除
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          {MEDIA_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setMediaFilter(option.value)}
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
          <button
            type="button"
            onClick={() => setConfirm({ kind: "clear" })}
            disabled={items.length === 0}
            className="ml-2 inline-flex h-8 items-center gap-1.5 rounded-lg border border-bad/40 bg-bad/10 px-2.5 text-xs text-bad transition hover:bg-bad/15 disabled:opacity-40"
            title="立刻删除回收站里的全部文件，不可恢复"
          >
            <TrashIcon />
            清空回收站
          </button>
        </div>
      </header>

      <div className="scroll-thin flex-1 overflow-y-auto px-5 pb-10 pt-4">
        {binQuery.isLoading ? (
          <p className="text-xs text-muted">正在读取回收站…</p>
        ) : items.length === 0 ? (
          <div className="mt-24 flex flex-col items-center gap-2 text-center">
            <p className="text-sm text-ink/80">回收站是空的</p>
            <p className="max-w-md text-xs leading-relaxed text-muted">
              删掉的图片、视频与素材会先放到这里，{retentionDays} 天内都能恢复；
              过了期限或点了「清空回收站」才会真的从磁盘删掉。
            </p>
          </div>
        ) : (
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(178px, 1fr))" }}
          >
            {items.map((item) => (
              <TrashCard
                key={item.id}
                item={item}
                busy={busy}
                onRestore={() => void restore([item.id])}
                onDelete={() => setConfirm({ kind: "one", item })}
              />
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirm?.kind === "clear"}
        title="清空回收站？"
        description={
          <>
            回收站里的 {items.length} 件产物会被<span className="text-bad">立刻从磁盘删除</span>，
            不能恢复。模型与工作流配置不受影响。
          </>
        }
        confirmLabel="清空回收站"
        danger
        busy={busy}
        onConfirm={() => void wipe()}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm?.kind === "one"}
        title="彻底删除这件产物？"
        description={
          <>
            文件会从磁盘删掉，<span className="text-bad">无法恢复</span>。如果只是想让它离开作品流，
            现在它已经不在流里了。
          </>
        }
        confirmLabel="彻底删除"
        danger
        busy={busy}
        onConfirm={() => confirm?.kind === "one" && void deleteForever(confirm.item.id)}
        onCancel={() => setConfirm(null)}
      />

      <ToastStack items={toasts} onDismiss={dismissToast} />
    </>
  );
}

function TrashCard({
  item,
  busy,
  onRestore,
  onDelete,
}: {
  item: RecycleItem;
  busy: boolean;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const isVideo = item.media_type === "video";
  const isAsset = item.media_type === "asset";
  const suffix = item.file_path.split(".").pop()?.toLowerCase() ?? "";
  const rasterLike = !isAsset || /^(png|jpe?g|webp|gif)$/.test(suffix);
  const canPreview = rasterLike && !failed;
  const typeLabel = TYPE_LABELS[item.generation_type] ?? item.generation_type ?? "";
  const left = item.days_left;

  return (
    <div className="group relative overflow-hidden rounded-xl border border-edge/70 bg-surface">
      <div className="relative aspect-square w-full overflow-hidden bg-surface2">
        {canPreview ? (
          <>
            {!loaded ? <div className="absolute inset-0 animate-pulse bg-surface2" /> : null}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageThumbnailUrl(item)}
              alt={item.prompt.slice(0, 60)}
              loading="lazy"
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
              className={["h-full w-full object-cover opacity-80", isVideo ? "grayscale-[35%]" : ""].join(
                " ",
              )}
            />
          </>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-3 text-center">
            <span className="rounded-md border border-edge bg-surface px-2 py-1 text-[10px] uppercase tracking-wide text-muted">
              {suffix || "file"}
            </span>
            <span className="line-clamp-2 text-[10px] text-muted/80">{item.prompt}</span>
          </div>
        )}

        <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white/90 backdrop-blur">
          {isVideo ? "视频" : isAsset ? `素材 · ${suffix || "file"}` : typeLabel || "图片"}
        </span>
        <span
          className={[
            "pointer-events-none absolute right-2 top-2 rounded px-1.5 py-0.5 text-[10px] backdrop-blur",
            left <= 3 ? "bg-bad/80 text-white" : "bg-black/55 text-white/90",
          ].join(" ")}
        >
          {left > 0 ? `还剩 ${left} 天` : "即将清理"}
        </span>
      </div>

      <div className="flex flex-col gap-1 px-2.5 pb-2 pt-2">
        <p className="line-clamp-1 text-[11px] text-ink/85" title={item.prompt}>
          {item.prompt || "（无提示词）"}
        </p>
        <p className="text-[10px] text-muted">
          {formatTime(item.deleted_at ?? item.created_at)} 删除 · {item.width}×{item.height}
        </p>
        <div className="mt-1 flex items-center gap-1.5">
          <button
            type="button"
            onClick={onRestore}
            disabled={busy}
            className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-edge bg-surface2 text-[11px] text-ink/90 transition hover:border-accent/50 hover:text-accentSoft disabled:opacity-40"
            title="恢复到作品流"
          >
            <RestoreIcon />
            恢复
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="inline-flex h-7 items-center justify-center gap-1 rounded-md border border-edge bg-surface2 px-2 text-[11px] text-muted transition hover:border-bad/50 hover:text-bad disabled:opacity-40"
            title="从磁盘彻底删除，不可恢复"
          >
            <TrashIcon />
            彻底删除
          </button>
        </div>
      </div>
    </div>
  );
}

function RestoreIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <path
        d="M4.5 9.5A8 8 0 1 1 4 12"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M4.2 4.6v5.2h5.2"
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
