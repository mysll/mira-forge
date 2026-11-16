"use client";

import { bucketOf, type DateBucket } from "@/lib/date";
import type { FeedItem } from "@/types/api";

import FeedCard from "./FeedCard";

const BUCKETS: DateBucket[] = ["今天", "昨天", "更早"];

type Props = {
  items: FeedItem[];
  view: "grid" | "list";
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onOpen: (item: FeedItem) => void;
  onFavorite: (item: FeedItem) => void;
  onDownload: (item: FeedItem) => void;
  onDelete: (item: FeedItem) => void;
  onEdit: (item: FeedItem) => void;
  modelLabels?: Record<string, string>;
  emptyHint?: string;
};

export default function Feed({
  items,
  view,
  loading,
  hasMore,
  onLoadMore,
  emptyHint,
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

  const grouped = BUCKETS.map((bucket) => ({
    bucket,
    items: items.filter((item) => bucketOf(item.image.created_at) === bucket),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="flex flex-col gap-6 pb-4">
      {grouped.map((group) => (
        <section key={group.bucket} className="flex flex-col gap-2.5">
          <div className="flex items-center gap-3">
            <h2 className="text-xs font-medium text-ink/80">{group.bucket}</h2>
            <span className="text-[11px] text-muted/60">{group.items.length}</span>
            <span className="h-px flex-1 bg-edge/60" />
          </div>

          {view === "grid" ? (
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}
            >
              {group.items.map((item) => (
                <FeedCard key={item.key} item={item} view="grid" {...actions} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <FeedCard key={item.key} item={item} view="list" {...actions} />
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
