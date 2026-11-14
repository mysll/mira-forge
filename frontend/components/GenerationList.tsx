"use client";

import { useQuery } from "@tanstack/react-query";

import { fetchGenerations } from "@/lib/api";

const STATUS_STYLE: Record<string, string> = {
  pending: "border-slate-600 text-slate-400",
  queued: "border-sky-700 text-sky-400",
  running: "border-amber-600 text-amber-400",
  completed: "border-emerald-700 text-emerald-400",
  failed: "border-rose-700 text-rose-400",
  cancelled: "border-slate-700 text-slate-500",
};

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function GenerationList() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["generations"],
    queryFn: () => fetchGenerations(20),
    refetchInterval: 5_000,
  });

  return (
    <section className="card">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-slate-200">生成记录</h2>
        {data && <span className="text-[11px] text-slate-500">共 {data.total} 条</span>}
      </header>

      {isLoading && <p className="text-xs text-slate-500">加载中…</p>}
      {isError && (
        <p className="text-xs text-rose-400">
          {error instanceof Error ? error.message : "加载失败"}
        </p>
      )}
      {data && data.items.length === 0 && (
        <p className="text-xs text-slate-500">还没有记录。左侧提交一次生成试试。</p>
      )}

      <ul className="space-y-2">
        {data?.items.map((item) => (
          <li key={item.id} className="rounded-lg border border-edge/70 bg-black/20 p-3">
            <div className="flex items-start justify-between gap-3">
              <p className="line-clamp-2 text-xs leading-relaxed text-slate-300">{item.prompt}</p>
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase ${
                  STATUS_STYLE[item.status] ?? "border-edge text-slate-400"
                }`}
              >
                {item.status}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-slate-500">
              <span>#{item.id}</span>
              <span>{item.model_name}</span>
              <span>{item.generation_type === "image_edit" ? "编辑" : "文生图"}</span>
              <span>
                {item.width && item.height
                  ? `${item.width}×${item.height}`
                  : "跟随参考图"}
              </span>
              <span>{item.task_count} 任务</span>
              <span>{formatTime(item.created_at)}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
