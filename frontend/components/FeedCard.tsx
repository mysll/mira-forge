"use client";

import { imageThumbnailUrl } from "@/lib/api";
import { formatBytes, formatTime } from "@/lib/date";
import { modelLabel } from "@/lib/models";
import type { FeedSlot, ImageBrief } from "@/types/api";

export const ACTIVE_STATUS = new Set(["pending", "queued", "running"]);

const STATUS_TEXT: Record<string, string> = {
  pending: "等待中",
  queued: "排队中",
  running: "生成中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export function statusLabel(status: string): string {
  return STATUS_TEXT[status] ?? status;
}

type Props = {
  item: FeedSlot;
  view: "grid" | "list";
  busy?: boolean;
  onOpen: (item: FeedSlot) => void;
  onFavorite: (item: FeedSlot) => void;
  onDownload: (item: FeedSlot) => void;
  onDelete: (item: FeedSlot) => void;
  onEdit: (item: FeedSlot) => void;
  /** 只有「没有产物的任务」会用到：把这条任务从批次里删掉 */
  onDeleteTask?: (item: FeedSlot) => void;
  modelLabels?: Record<string, string>;
};

/** 已经有产物的格子：操作栏只在图存在时出现。 */
type FilledSlot = FeedSlot & { image: ImageBrief };

function IconStar({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
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

function IconDownload() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
      <path d="M12 4v10m0 0 3.6-3.6M12 14l-3.6-3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 17.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
      <path d="M5 7h14M9.5 7V5.5h5V7M7 7l.8 12.1a1 1 0 0 0 1 .9h6.4a1 1 0 0 0 1-.9L17 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconEdit() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
      <path d="M4 20h4.2l9.4-9.4a2.3 2.3 0 0 0 0-3.2l-1-1a2.3 2.3 0 0 0-3.2 0L4 15.8V20Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function IconExpand() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
      <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <span
      className={`inline-block animate-spin rounded-full border border-muted/30 border-t-accentSoft ${className}`}
      aria-hidden
    />
  );
}

function ActionBar({
  item,
  busy,
  onFavorite,
  onDownload,
  onDelete,
  onEdit,
  onOpen,
}: Omit<Props, "item"> & { item: FilledSlot; busy?: boolean }) {
  const buttons = [
    { key: "open", title: "查看大图", icon: <IconExpand />, run: () => onOpen(item) },
    {
      key: "fav",
      title: item.image.is_favorite ? "取消收藏" : "收藏",
      icon: <IconStar filled={item.image.is_favorite} />,
      run: () => onFavorite(item),
    },
    { key: "edit", title: "继续编辑", icon: <IconEdit />, run: () => onEdit(item) },
    { key: "download", title: "下载", icon: <IconDownload />, run: () => onDownload(item) },
    { key: "delete", title: "删除", icon: <IconTrash />, run: () => onDelete(item) },
  ];

  return (
    <div className="absolute right-2 top-2 flex gap-1 rounded-lg bg-black/55 p-1 opacity-0 backdrop-blur transition group-hover:opacity-100">
      {buttons.map((button) => (
        <button
          key={button.key}
          type="button"
          title={button.title}
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            button.run();
          }}
          className={[
            "flex h-7 w-7 items-center justify-center rounded-md transition disabled:opacity-40",
            button.key === "fav" && item.image.is_favorite
              ? "text-warn hover:bg-white/10"
              : "text-white/85 hover:bg-white/10 hover:text-white",
          ].join(" ")}
        >
          {button.icon}
        </button>
      ))}
    </div>
  );
}

// 视频产物用封面帧当缩略图，时长直接标在角上（不需要读视频元数据）
function lengthLabel(image: ImageBrief): string | null {
  if (image.media_type !== "video" || !image.duration_seconds) {
    return null;
  }
  return `${image.duration_seconds.toFixed(1)} 秒`;
}

function PlayBadge({ small = false }: { small?: boolean }) {
  return (
    <span
      className={`flex items-center justify-center rounded-full bg-black/55 text-white backdrop-blur ${
        small ? "h-6 w-6" : "h-9 w-9"
      }`}
    >
      <svg width={small ? 10 : 13} height={small ? 10 : 13} viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 5v14l11-7z" />
      </svg>
    </span>
  );
}

function toneOf(status: string): string {
  if (status === "running") {
    return "text-accentSoft";
  }
  if (status === "failed") {
    return "text-bad";
  }
  if (status === "cancelled") {
    return "text-muted/70";
  }
  return "text-warn";
}

/** 还没有产物的格子：排队中直接说排队，生成中给进度条，失败给原因。 */
function Placeholder({
  item,
  view,
  onDeleteTask,
}: {
  item: FeedSlot;
  view: "grid" | "list";
  onDeleteTask?: (item: FeedSlot) => void;
}) {
  const { generation, task, index, total } = item;
  const status = task?.status ?? generation.status;
  const progress = task?.progress ?? 0;
  const running = status === "running";
  const failed = status === "failed";
  const reason = task?.error_message ?? null;
  // 任务还在排队/生成时才叫「排队中」；已经结束却没有产物就是「无产物」——
  // 这种格子给一个删除按钮，否则图删光了任务还会一直占着一格。
  const active = status === "pending" || status === "queued" || running;
  const empty = !active;
  const label = empty ? "无产物" : status === "pending" ? "排队中" : statusLabel(status);
  const tone = empty ? "text-muted/70" : toneOf(status);
  const deletable = empty && Boolean(task) && Boolean(onDeleteTask);
  const remove = (event: React.MouseEvent) => {
    event.stopPropagation();
    onDeleteTask?.(item);
  };

  const isVideo =
    generation.generation_type === "text_to_video" || generation.generation_type === "image_to_video";
  const unit = isVideo ? "条" : "张";

  if (view === "list") {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-dashed border-edge/70 px-1 py-1">
        <div className="grid h-[54px] w-[54px] shrink-0 place-items-center rounded-lg border border-dashed border-edge/70 bg-surface2/60">
          {running ? <Spinner className="h-3.5 w-3.5" /> : <span className="text-[10px] text-muted/50">·</span>}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-ink/75">第 {index} / {total} {unit}</p>
          <p className="mt-0.5 truncate text-[11px] text-muted/70">{reason ?? (running ? `${label} ${progress}%` : label)}</p>
        </div>
        <span className={`shrink-0 text-[11px] ${tone}`}>{label}</span>
        {deletable ? (
          <button
            type="button"
            onClick={remove}
            title="删除这个任务"
            aria-label="删除这个任务"
            className="shrink-0 rounded-md border border-edge/70 p-1 text-muted/70 transition hover:border-bad/50 hover:text-bad"
          >
            <IconTrash />
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="relative flex flex-col overflow-hidden rounded-xl border border-dashed border-edge/70 bg-surface/30">
      {deletable ? (
        <button
          type="button"
          onClick={remove}
          title="删除这个任务"
          aria-label="删除这个任务"
          className="absolute right-2 top-2 z-10 rounded-md border border-edge/70 bg-bg/80 p-1 text-muted/70 transition hover:border-bad/50 hover:text-bad"
        >
          <IconTrash />
        </button>
      ) : null}
      <div
        className={`relative flex flex-col items-center justify-center gap-2 text-[11px] ${
          isVideo ? "aspect-video" : "aspect-square"
        }`}
      >
        {running ? (
          <Spinner className="h-5 w-5" />
        ) : empty ? (
          <span className="text-[10px] text-muted/40">图已被删除</span>
        ) : (
          <span className="h-5 w-5 rounded-full border border-dashed border-muted/30" />
        )}
        <span className={tone}>{running ? `${label} ${progress}%` : label}</span>
        {failed && reason ? (
          <p className="line-clamp-2 px-3 text-center text-[10px] leading-snug text-bad/70">{reason}</p>
        ) : null}
        {running ? (
          <div className="absolute inset-x-3 bottom-3 h-0.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.max(3, progress)}%` }} />
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2 px-2.5 py-2">
        <span className="truncate text-[11px] text-muted/60">第 {index} / {total} {unit}</span>
        <span className={`shrink-0 text-[10px] ${tone}`}>{label}</span>
      </div>
    </div>
  );
}

export default function FeedCard(props: Props) {
  const { item, view } = props;
  const { image, generation, task } = item;

  if (!image) {
    return <Placeholder item={item} view={view} onDeleteTask={props.onDeleteTask} />;
  }

  const filled: FilledSlot = { ...item, image };
  const status = task?.status ?? generation.status;
  const active = ACTIVE_STATUS.has(status);
  const progress = task?.progress ?? generation.progress;
  const position = item.index;

  if (view === "list") {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => props.onOpen(filled)}
        onKeyDown={(event) => event.key === "Enter" && props.onOpen(filled)}
        className="group flex cursor-pointer items-center gap-2 rounded-xl border border-transparent px-1 py-1 transition hover:border-edge hover:bg-surface"
      >
        <div className="relative h-[54px] w-[54px] shrink-0 overflow-hidden rounded-lg border border-edge/70 bg-surface2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageThumbnailUrl(image)} alt={generation.prompt} loading="lazy" className="h-full w-full object-cover" />
          {image.media_type === "video" ? (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <PlayBadge small />
            </span>
          ) : null}
          {active ? (
            <span className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" style={{ width: `${progress}%` }} />
          ) : null}
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-ink/90">
            第 {position} {props.item.image?.media_type === "video" ? "条" : "张"} · {modelLabel(generation.model_name, props.modelLabels)}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-muted">
            {image.width}×{image.height} · {formatBytes(image.file_size)} · {formatTime(image.created_at)}
            {lengthLabel(image) ? ` · ${lengthLabel(image)}` : ""}
          </p>
        </div>

        <span className="shrink-0 text-[11px] text-muted">
          {active ? `${statusLabel(status)} ${progress}%` : statusLabel(status)}
        </span>

        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            title={image.is_favorite ? "取消收藏" : "收藏"}
            onClick={(event) => {
              event.stopPropagation();
              props.onFavorite(filled);
            }}
            className={["icon-btn", image.is_favorite ? "text-warn" : ""].join(" ")}
          >
            <IconStar filled={image.is_favorite} />
          </button>
          <button
            type="button"
            title="下载"
            onClick={(event) => {
              event.stopPropagation();
              props.onDownload(filled);
            }}
            className="icon-btn"
          >
            <IconDownload />
          </button>
          <button
            type="button"
            title="删除"
            onClick={(event) => {
              event.stopPropagation();
              props.onDelete(filled);
            }}
            className="icon-btn hover:!text-bad"
          >
            <IconTrash />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => props.onOpen(filled)}
      onKeyDown={(event) => event.key === "Enter" && props.onOpen(filled)}
      className="group relative cursor-pointer overflow-hidden rounded-xl border border-edge/60 bg-surface2 transition hover:border-accent/40 hover:shadow-pop"
    >
      <div className={`relative overflow-hidden ${image.media_type === "video" ? "aspect-video" : "aspect-square"}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageThumbnailUrl(image)}
          alt={generation.prompt}
          loading="lazy"
          className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]"
        />

        <div className="absolute left-2 top-2 flex items-center gap-1">
          {image.is_favorite ? (
            <span className="rounded-md bg-black/55 p-1 text-warn backdrop-blur">
              <IconStar filled />
            </span>
          ) : null}
        </div>

        {image.media_type === "video" ? (
          <>
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <PlayBadge />
            </div>
            <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white/90 backdrop-blur">
              {lengthLabel(image) ?? "视频"}
            </span>
          </>
        ) : null}

        {active ? (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2">
            <div className="mb-1 flex items-center justify-between text-[10px] text-white/85">
              <span>{statusLabel(status)}</span>
              <span>{progress}%</span>
            </div>
            <div className="h-0.5 w-full overflow-hidden rounded-full bg-white/20">
              <div className="h-full rounded-full bg-accentSoft" style={{ width: `${progress}%` }} />
            </div>
          </div>
        ) : (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-2 bg-gradient-to-t from-black/75 via-black/35 to-transparent p-2.5 opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100">
            <p className="line-clamp-2 text-[11px] leading-snug text-white/90">{generation.prompt}</p>
          </div>
        )}

        <ActionBar {...props} item={filled} />
      </div>

      <div className="flex items-center justify-between gap-2 px-2.5 py-2">
        <span className="truncate text-[11px] text-muted">
          {image.width}×{image.height}
          {image.media_type === "video" ? (
            <span className="ml-1.5 rounded bg-white/10 px-1 py-px text-[10px] text-ink/80">
              {image.fps ? `${Math.round(image.fps)}fps` : "视频"}
            </span>
          ) : null}
          {generation.reference_images?.length && image.media_type !== "video" ? (
            <span
              className="ml-1.5 rounded bg-accent/15 px-1 py-px text-[10px] text-accentSoft"
              title={`使用了 ${generation.reference_images.length} 张参考图`}
            >
              参×{generation.reference_images.length}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 text-[10px] text-muted/70">{formatTime(image.created_at)}</span>
      </div>
    </div>
  );
}

