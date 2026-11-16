"use client";

import type { ModelInfo } from "@/types/api";
import type { DateFilter } from "@/lib/date";

type Props = {
  query: string;
  onQuery: (value: string) => void;
  models: ModelInfo[];
  modelFilter: string | null;
  onModelFilter: (value: string | null) => void;
  dateFilter: DateFilter;
  onDateFilter: (value: DateFilter) => void;
  favoriteOnly: boolean;
  onFavoriteOnly: (value: boolean) => void;
  view: "grid" | "list";
  onView: (value: "grid" | "list") => void;
  total: number;
};

const DATE_LABELS: Record<DateFilter, string> = {
  all: "全部时间",
  today: "今天",
  yesterday: "昨天",
  week: "最近 7 天",
};

const selectClass =
  "h-9 rounded-lg border border-edge bg-surface2 px-2.5 text-xs text-ink/90 outline-none transition hover:border-accent/40 focus:border-accent/60";

export default function TopBar({
  query,
  onQuery,
  models,
  modelFilter,
  onModelFilter,
  dateFilter,
  onDateFilter,
  favoriteOnly,
  onFavoriteOnly,
  view,
  onView,
  total,
}: Props) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-edge/70 px-5">
      <div
        className="flex h-9 items-center gap-1.5 rounded-lg border border-edge bg-surface2 px-2.5 text-xs text-ink/90"
        title="多项目切换在二期开放，目前所有作品都在默认项目里"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-muted" fill="none" aria-hidden>
          <path
            d="M4 8.5A2.5 2.5 0 0 1 6.5 6h3l1.6 1.8h6.4A2.5 2.5 0 0 1 20 10.3v6.2a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5v-8Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
        默认项目
        <svg viewBox="0 0 24 24" className="h-3 w-3 text-muted/50" fill="none" aria-hidden>
          <path d="m8 10 4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      <div className="flex items-baseline gap-2">
        <h1 className="text-sm font-medium text-ink">作品库</h1>
        <span className="text-xs text-muted">{total} 个批次</span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <div className="relative">
          <svg
            viewBox="0 0 24 24"
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
            fill="none"
            aria-hidden
          >
            <circle cx="11" cy="11" r="6.2" stroke="currentColor" strokeWidth="1.6" />
            <path d="m16 16 3.4 3.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="搜索提示词"
            className="h-9 w-56 rounded-lg border border-edge bg-surface2 pl-8 pr-3 text-xs text-ink outline-none transition placeholder:text-muted/70 hover:border-edge focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
          />
        </div>

        <select
          value={dateFilter}
          onChange={(event) => onDateFilter(event.target.value as DateFilter)}
          className={selectClass}
          title="按日期筛选"
        >
          {(Object.keys(DATE_LABELS) as DateFilter[]).map((key) => (
            <option key={key} value={key}>
              {DATE_LABELS[key]}
            </option>
          ))}
        </select>

        <select
          value={modelFilter ?? ""}
          onChange={(event) => onModelFilter(event.target.value || null)}
          className={selectClass}
          title="按模型筛选"
        >
          <option value="">全部模型</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => onFavoriteOnly(!favoriteOnly)}
          className={[
            "inline-flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition",
            favoriteOnly
              ? "border-accent/50 bg-accent/15 text-accentSoft"
              : "border-edge bg-surface2 text-muted hover:text-ink",
          ].join(" ")}
          title="只看收藏的图片"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden>
            <path
              d="m12 4.6 2.3 4.7 5.2.8-3.8 3.7.9 5.1-4.6-2.4-4.6 2.4.9-5.1L4.5 10l5.2-.8L12 4.6Z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
              fill={favoriteOnly ? "currentColor" : "none"}
            />
          </svg>
          收藏
        </button>

        <div className="ml-1 flex items-center rounded-lg border border-edge bg-surface2 p-0.5">
          {(["grid", "list"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onView(item)}
              title={item === "grid" ? "网格视图" : "列表视图"}
              className={[
                "flex h-7 w-7 items-center justify-center rounded-md transition",
                view === item ? "bg-accent/20 text-accentSoft" : "text-muted hover:text-ink",
              ].join(" ")}
            >
              {item === "grid" ? (
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
                  <rect x="4" y="4" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
                  <rect x="13" y="4" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
                  <rect x="4" y="13" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
                  <rect x="13" y="13" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
                  <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              )}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}
