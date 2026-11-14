"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useTaskEvents } from "@/hooks/useTaskEvents";
import {
  cancelTask,
  fetchGeneration,
  fetchGenerations,
  fetchImages,
  imageFileUrl,
  referenceImageUrl,
  retryTask,
} from "@/lib/api";
import type { GenerationRead, GenerationSummary } from "@/types/api";

const STATUS_STYLE: Record<string, string> = {
  pending: "border-slate-600 text-slate-400",
  queued: "border-sky-700 text-sky-400",
  running: "border-amber-600 text-amber-400",
  completed: "border-emerald-700 text-emerald-400",
  failed: "border-rose-700 text-rose-400",
  cancelled: "border-slate-700 text-slate-500",
};

const ACTIVE = new Set(["pending", "queued", "running"]);

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function Bar({ value, className = "" }: { value: number; className?: string }) {
  return (
    <div className={`h-1 w-full overflow-hidden rounded-full bg-white/10 ${className}`}>
      <div
        className="h-full rounded-full bg-sky-500/80 transition-[width] duration-500"
        style={{ width: `${Math.max(2, Math.min(100, value))}%` }}
      />
    </div>
  );
}

function TaskRow({
  task,
  busy,
  onCancel,
  onRetry,
}: {
  task: GenerationRead["tasks"][number];
  busy: boolean;
  onCancel: (taskId: number) => void;
  onRetry: (taskId: number) => void;
}) {
  const cancellable = ACTIVE.has(task.status);
  const retryable = task.status === "failed" || task.status === "cancelled";

  return (
    <li className="rounded-md border border-edge/50 bg-black/30 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-slate-500">
        <span>
          task #{task.id} · seed {task.seed}
        </span>
        <div className="flex items-center gap-1.5">
          {cancellable && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onCancel(task.id)}
              className="rounded border border-edge px-1.5 py-px text-[10px] text-slate-400 transition hover:border-rose-600 hover:text-rose-300 disabled:opacity-40"
            >
              取消
            </button>
          )}
          {retryable && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onRetry(task.id)}
              className="rounded border border-edge px-1.5 py-px text-[10px] text-slate-400 transition hover:border-sky-600 hover:text-sky-300 disabled:opacity-40"
            >
              重试
            </button>
          )}
          <span
            className={`rounded-full border px-1.5 py-px ${
              STATUS_STYLE[task.status] ?? "border-edge text-slate-400"
            }`}
          >
            {task.status}
            {ACTIVE.has(task.status) ? ` ${task.progress}%` : ""}
          </span>
        </div>
      </div>
      {ACTIVE.has(task.status) && <Bar value={task.progress} className="mt-1.5" />}
      {task.error_message && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-rose-300/90">{task.error_message}</p>
      )}
    </li>
  );
}

function Detail({ generation }: { generation: GenerationRead }) {
  const active = ACTIVE.has(generation.status);
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<number | null>(null);

  const images = useQuery({
    queryKey: ["images", "generation", generation.id],
    queryFn: () => fetchImages({ generationId: generation.id, limit: 100 }),
    enabled: !active,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["generation", generation.id] });
    void queryClient.invalidateQueries({ queryKey: ["generations"] });
  };

  const cancel = useMutation({
    mutationFn: (taskId: number) => cancelTask(taskId),
    onMutate: (taskId) => setBusyId(taskId),
    onSettled: () => {
      setBusyId(null);
      refresh();
    },
  });

  const retry = useMutation({
    mutationFn: (taskId: number) => retryTask(taskId),
    onMutate: (taskId) => setBusyId(taskId),
    onSettled: () => {
      setBusyId(null);
      refresh();
    },
  });

  const failure = cancel.error ?? retry.error;

  return (
    <div className="mt-3 space-y-2 border-t border-edge/50 pt-3">
      <ul className="space-y-1.5">
        {generation.tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            busy={busyId === task.id}
            onCancel={(taskId) => cancel.mutate(taskId)}
            onRetry={(taskId) => retry.mutate(taskId)}
          />
        ))}
      </ul>

      {failure instanceof Error && (
        <p className="text-[11px] text-rose-400">{failure.message}</p>
      )}

      {generation.reference_image_path && (
        <div className="flex items-center gap-2.5 rounded-md border border-edge/50 bg-black/30 p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={referenceImageUrl(generation.id)}
            alt="参考图"
            loading="lazy"
            className="h-14 w-14 shrink-0 rounded object-cover"
          />
          <div className="text-[11px] leading-relaxed text-slate-500">
            <p className="text-slate-400">参考图</p>
            <p className="mt-0.5">按这张图做编辑，输出比例跟随它，尺寸只决定像素量级</p>
          </div>
        </div>
      )}

      {images.data && images.data.items.length > 0 && (
        <div className="grid grid-cols-4 gap-2 pt-1">
          {images.data.items.map((image) => (
            <a
              key={image.id}
              href={imageFileUrl(image.id)}
              target="_blank"
              rel="noreferrer"
              className="group relative overflow-hidden rounded-md border border-edge/60"
              title={`${image.width}×${image.height} · ${Math.round(image.file_size / 1024)} KB`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageFileUrl(image.id)}
                alt={`generation ${generation.id} image ${image.id}`}
                loading="lazy"
                className="aspect-square w-full object-cover transition group-hover:scale-[1.03]"
              />
            </a>
          ))}
        </div>
      )}
      {images.data && images.data.items.length === 0 && !active && (
        <p className="text-[11px] text-slate-500">这次生成没有产物。</p>
      )}
    </div>
  );
}

function GenerationItem({ item }: { item: GenerationSummary }) {
  const [expanded, setExpanded] = useState(false);
  const active = ACTIVE.has(item.status);

  const detail = useQuery({
    queryKey: ["generation", item.id],
    queryFn: () => fetchGeneration(item.id),
    enabled: expanded,
    refetchInterval: (query) =>
      query.state.data && ACTIVE.has(query.state.data.status) ? 1_000 : false,
  });

  return (
    <li className="rounded-lg border border-edge/70 bg-black/20 p-3">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="block w-full text-left"
      >
        <div className="flex items-start justify-between gap-3">
          <p className="line-clamp-2 text-xs leading-relaxed text-slate-300">{item.prompt}</p>
          <span
            className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase ${
              STATUS_STYLE[item.status] ?? "border-edge text-slate-400"
            }`}
          >
            {item.status}
            {active ? ` ${item.progress}%` : ""}
          </span>
        </div>
        {active && <Bar value={item.progress} className="mt-2" />}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-slate-500">
          <span>#{item.id}</span>
          <span>{item.model_name}</span>
          <span>{item.generation_type === "image_edit" ? "编辑" : "文生图"}</span>
          <span>
            {item.width && item.height ? `${item.width}×${item.height}` : "跟随参考图"}
          </span>
          <span>{item.task_count} 任务</span>
          <span>{formatTime(item.created_at)}</span>
          <span className="text-slate-600">{expanded ? "收起" : "详情"}</span>
        </div>
      </button>

      {expanded && detail.data && <Detail generation={detail.data} />}
      {expanded && detail.isLoading && <p className="mt-2 text-[11px] text-slate-500">加载详情…</p>}
    </li>
  );
}

export function GenerationList() {
  useTaskEvents();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["generations"],
    queryFn: () => fetchGenerations(20),
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => ACTIVE.has(item.status)) ? 1_500 : 5_000,
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
          <GenerationItem key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}
