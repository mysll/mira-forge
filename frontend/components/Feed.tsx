"use client";

import { bucketOf, formatTime, type DateBucket } from "@/lib/date";
import type { FeedSlot, GenerationRead } from "@/types/api";

import FeedCard, { ACTIVE_STATUS, statusLabel } from "./FeedCard";

const BUCKETS: DateBucket[] = ["今天", "昨天", "更早"];

const CARD = 200; // 网格卡宽度（px）

type Props = {
  items: FeedSlot[];
  view: "grid" | "list";
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onOpen: (item: FeedSlot) => void;
  onFavorite: (item: FeedSlot) => void;
  onDownload: (item: FeedSlot) => void;
  onDelete: (item: FeedSlot) => void;
  onEdit: (item: FeedSlot) => void;
  modelLabels?: Record<string, string>;
  emptyHint?: string;
  /** 网格卡宽度（视频比图片宽，留出 16:9 的空间） */
  cardWidth?: number;
  /** 计数单位：图片用「张」，视频用「条」 */
  unit?: string;
};

type Batch = { generation: GenerationRead; items: FeedSlot[] };

// 同一批次的多张图必须连成一组，所以按 generation 聚合，而不是逐张平铺。
function byBatch(list: FeedSlot[]): Batch[] {
  const groups = new Map<number, Batch>();
  for (const item of list) {
    const existing = groups.get(item.generation.id);
    if (existing) {
      existing.items.push(item);
    } else {
      groups.set(item.generation.id, { generation: item.generation, items: [item] });
    }
  }
  return [...groups.values()];
}

const STATUS_TONE: Record<string, string> = {
  completed: "text-ok",
  failed: "text-bad",
  cancelled: "text-muted",
  running: "text-accent",
  queued: "text-warn",
  pending: "text-warn",
};

function BatchHeader({ batch, unit }: { batch: Batch; unit: string }) {
  const { generation, items } = batch;
  const done = items.filter((item) => item.image !== null).length;
  const active = ACTIVE_STATUS.has(generation.status);
  const finished = generation.status === "completed";

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-baseline gap-2 text-[11px]">
        <span className="shrink-0 text-muted">批次 #{generation.id}</span>
        <span className="shrink-0 text-muted/60">
          · {done}/{items.length} {unit}
        </span>
        {finished ? null : (
          <span className={`shrink-0 ${STATUS_TONE[generation.status] ?? "text-muted"}`}>
            · {statusLabel(generation.status)}
            {active && generation.progress > 0 ? ` ${generation.progress}%` : ""}
          </span>
        )}
        <span className="shrink-0 text-muted/50">· {formatTime(generation.created_at)}</span>
        <span className="min-w-0 flex-1 truncate text-ink/50" title={generation.prompt}>
          · {generation.prompt}
        </span>
      </div>
    </div>
  );
}
export default function Feed({
  items,
  view,
  loading,
  hasMore,
  onLoadMore,
  modelLabels,
  emptyHint,
  cardWidth = CARD,
  unit = "张",
  ...actions
}: Props) {
  if (!loading && items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-edge bg-surface">
          <svg viewBox="0 0 24 24" className="h-6 w-6 text-muted" fill="none" aria-hidden>
            <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="9" cy="10" r="1.6" fill="currentColor" />
            <path d="m4.5 17 4.4-4.2 3.1 3 2.6-2.4 5 4.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <p className="text-sm text-ink/80">这里还没有作品</p>
        <p className="max-w-xs text-xs leading-relaxed text-muted">
          {emptyHint ?? "在下方输入提示词，选好比例和数量，点「生成」即可开始。"}
        </p>
      </div>
    );
  }

  // 日期分组按批次的创建时间算：一个批次有 4 张图时不会被拆到「今天」「昨天」两边。
  const grouped = BUCKETS.map((bucket) => {
    const inBucket = items.filter((item) => bucketOf(item.generation.created_at) === bucket);
    return { bucket, total: inBucket.length, batches: byBatch(inBucket) };
  }).filter((group) => group.batches.length > 0);

  return (
    <div className="flex flex-col gap-6 pb-4">
      {grouped.map((group) => (
        <section key={group.bucket} className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-xs font-medium text-ink/80">{group.bucket}</h2>
            <span className="text-[11px] text-muted/60">
              {group.batches.length} 个批次 · {group.total} {unit}
            </span>
            <span className="h-px flex-1 bg-edge/60" />
          </div>

          {view === "list" ? (
            <div className="flex flex-col gap-4">
              {group.batches.map((batch) => (
                <div key={batch.generation.id} className="flex flex-col gap-0.5 px-2">
                  <BatchHeader batch={batch} unit={unit} />
                  {batch.items.map((item) => (
                    <FeedCard key={item.key} item={item} view="list" modelLabels={modelLabels} {...actions} />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {group.batches.map((batch) => (
                <div key={batch.generation.id} className="flex flex-col gap-2">
                  <BatchHeader batch={batch} unit={unit} />
                  <div className="flex flex-wrap gap-3">
                    {batch.items.map((item) => (
                      <div key={item.key} style={{ width: cardWidth }}>
                        <FeedCard item={item} view="grid" modelLabels={modelLabels} {...actions} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      ))}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted">
          <span className="h-3 w-3 animate-spin rounded-full border border-muted border-t-transparent" />
          加载中
        </div>
      ) : null}

      {!loading && hasMore ? (
        <button type="button" onClick={onLoadMore} className="btn-ghost mx-auto">
          加载更多
        </button>
      ) : null}
    </div>
  );
}
