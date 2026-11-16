/** 作品流的时间分组与筛选区间。 */

export type DateFilter = "all" | "today" | "yesterday" | "week";

export type DateBucket = "今天" | "昨天" | "更早";

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/**
 * 后端存的是 UTC，但 SQLite/Pydantic 出来的字符串常常不带时区后缀
 * （例如 "2026-11-16T03:52:44"）。直接 new Date() 会按本地时间解析，
 * 于是东八区的时间会凭空早 8 小时、还会把「今天」分到「昨天」。缺时区就补 Z。
 */
const HAS_ZONE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

export function parseIso(iso: string): Date {
  return new Date(HAS_ZONE.test(iso) ? iso : `${iso}Z`);
}

export function bucketOf(iso: string): DateBucket {
  const value = parseIso(iso);
  const today = startOfDay(new Date());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (value >= today) {
    return "今天";
  }
  if (value >= yesterday) {
    return "昨天";
  }
  return "更早";
}

/** 顶部「按日期」筛选 → 后端需要的 ISO 区间。 */
export function dateRangeFor(filter: DateFilter): { from?: string; to?: string } {
  const today = startOfDay(new Date());
  if (filter === "today") {
    return { from: today.toISOString() };
  }
  if (filter === "yesterday") {
    const from = new Date(today);
    from.setDate(today.getDate() - 1);
    return { from: from.toISOString(), to: today.toISOString() };
  }
  if (filter === "week") {
    const from = new Date(today);
    from.setDate(today.getDate() - 6);
    return { from: from.toISOString() };
  }
  return {};
}

export function formatTime(iso: string): string {
  return parseIso(iso).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
