"use client";

import { useState } from "react";

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
  /** 后端单次最多返回 100 条；到上限了就不再显示「加载更多」，改成提示用筛选继续找 */
  capped?: boolean;
  onLoadMore: () => void;
  onOpen: (item: FeedSlot) => void;
  onFavorite: (item: FeedSlot) => void;
  onDownload: (item: FeedSlot) => void;
  onDelete: (item: FeedSlot) => void;
  onEdit: (item: FeedSlot) => void;
  /** 场景页专用：卡片悬浮时给出「场景分层」入口 */
  onLayers?: (item: FeedSlot) => void;
  /** 场景页专用：导出「这张场景图 + 它的分层」 */
  onExport?: (item: FeedSlot) => void;
  /** 场景页专用：把这张图里的结构拆成可复用的元素 */
  onExtract?: (item: FeedSlot) => void;
  /** 层页签专用：指定这一层导出用哪一张 */
  onPick?: (item: FeedSlot) => void;
  pickedImageId?: number | null;
  /** 场景页专用：按图片 id 给出「已分层」角标文案（null = 没分过层） */
  layerBadge?: (imageId: number) => string | null;
  /** 没有产物的任务：把这条任务删掉（批次空了连带删批次） */
  onDeleteTask?: (item: FeedSlot) => void;
  /** 整批删除：任务、产物、记录一起清掉 */
  onDeleteBatch?: (generation: GenerationRead) => void;
  onRenameBatch?: (generation: GenerationRead, name: string) => void;
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

function BatchHeader({
  batch,
  unit,
  onDeleteBatch,
  onRenameBatch,
}: {
  batch: Batch;
  unit: string;
  onDeleteBatch?: (generation: GenerationRead) => void;
  onRenameBatch?: (generation: GenerationRead, name: string) => void;
}) {
  const { generation, items } = batch;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(generation.name ?? "");
  const title = (generation.name ?? "").trim() || `批次 #${generation.id}`;

  const commit = () => {
    setEditing(false);
    onRenameBatch?.(generation, draft);
  };
  const done = items.filter((item) => item.image !== null).length;
  const active = ACTIVE_STATUS.has(generation.status);
  const finished = generation.status === "completed";

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-baseline gap-2 text-[11px]">
        {editing ? (
          <input
            autoFocus
            value={draft}
            maxLength={60}
            aria-label="批次名"
            placeholder={`批次 #${generation.id}`}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commit();
              } else if (event.key === "Escape") {
                setDraft(generation.name ?? "");
                setEditing(false);
              }
            }}
            className="h-5 w-32 shrink-0 rounded border border-accent/50 bg-surface px-1 text-[11px] text-ink outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              if (!onRenameBatch) {
                return;
              }
              setDraft(generation.name ?? "");
              setEditing(true);
            }}
            title={onRenameBatch ? "点击给这一批起个名字，产物会叫「名字 · 第 N 个」" : undefined}
            className={`shrink-0 rounded px-1 text-muted ${
              onRenameBatch ? "transition hover:bg-surface hover:text-ink" : "cursor-default"
            }`}
            data-batch-name={generation.name ?? ""}
          >
            {title}
            {onRenameBatch && !generation.name ? (
              <span className="ml-1 text-muted/40">起名</span>
            ) : null}
          </button>
        )}
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
        {onDeleteBatch ? (
          <button
            type="button"
            onClick={() => onDeleteBatch(generation)}
            title="删除这个批次（连同它的所有产物）"
            aria-label="删除这个批次"
            className="shrink-0 rounded p-1 text-muted/40 opacity-0 transition hover:bg-surface hover:text-bad group-hover/batch:opacity-100 focus-visible:opacity-100"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden>
              <path d="M4.5 6.5h15M9.5 6.5V4.8h5v1.7M7 6.5l.8 12a1.6 1.6 0 0 0 1.6 1.5h5.2a1.6 1.6 0 0 0 1.6-1.5l.8-12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : null}
      </div>
    </div>
  );
}
export default function Feed({
  items,
  view,
  loading,
  hasMore,
  capped = false,
  onLoadMore,
  modelLabels,
  emptyHint,
  cardWidth = CARD,
  unit = "张",
  layerBadge,
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
                <div key={batch.generation.id} className="group/batch flex flex-col gap-0.5 px-2">
                  <BatchHeader
                    batch={batch}
                    unit={unit}
                    onDeleteBatch={actions.onDeleteBatch}
                    onRenameBatch={actions.onRenameBatch}
                  />
                  {batch.items.map((item) => (
                    <FeedCard
                      key={item.key}
                      item={item}
                      view="list"
                      modelLabels={modelLabels}
                      layerBadge={item.image ? layerBadge?.(item.image.id) ?? null : null}
                      {...actions}
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {group.batches.map((batch) => (
                <div key={batch.generation.id} className="group/batch flex flex-col gap-2">
                  <BatchHeader
                    batch={batch}
                    unit={unit}
                    onDeleteBatch={actions.onDeleteBatch}
                    onRenameBatch={actions.onRenameBatch}
                  />
                  <div className="flex flex-wrap gap-3">
                    {batch.items.map((item) => (
                      <div key={item.key} style={{ width: cardWidth }}>
                        <FeedCard
                          item={item}
                          view="grid"
                          modelLabels={modelLabels}
                          layerBadge={item.image ? layerBadge?.(item.image.id) ?? null : null}
                          {...actions}
                        />
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
      {!loading && capped && !hasMore ? (
        <p className="pt-1 text-center text-xs text-muted">
          只列出最近 100 个批次 —— 用搜索、模型或日期筛选继续找更早的内容。
        </p>
      ) : null}
    </div>
  );
}
