"use client";

import { imageFileUrl, imageThumbnailUrl } from "@/lib/api";
import { formatBytes, formatTime } from "@/lib/date";
import type { FeedItem } from "@/types/api";

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
  item: FeedItem;
  view: "grid" | "list";
  busy?: boolean;
  onOpen: (item: FeedItem) => void;
  onFavorite: (item: FeedItem) => void;
  onDownload: (item: FeedItem) => void;
  onDelete: (item: FeedItem) => void;
  onEdit: (item: FeedItem) => void;
  modelLabels?: Record<string, string>;
};

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

function ActionBar({
  item,
  busy,
  onFavorite,
  onDownload,
  onDelete,
  onEdit,
  onOpen,
}: Props & { busy?: boolean }) {
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

export default function FeedCard(props: Props) {
  const { item, view } = props;
  const { image, generation } = item;
  const active = ACTIVE_STATUS.has(generation.status);

  const position = generation.images.findIndex((candidate) => candidate.id === image.id) + 1;
  const batchBadge = (
    <span className="rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] text-white/85 backdrop-blur">
      批次 #{generation.id} · 第 {position} 张
    </span>
  );

  if (view === "list") {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => props.onOpen(item)}
        onKeyDown={(event) => event.key === "Enter" && props.onOpen(item)}
        className="group flex cursor-pointer items-center gap-2 rounded-xl border border-transparent px-1 py-1 transition hover:border-edge hover:bg-surface"
      >
        <div className="relative h-[54px] w-[54px] shrink-0 overflow-hidden rounded-lg border border-edge/70 bg-surface2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageThumbnailUrl(image.id)}
            alt={generation.prompt}
            loading="lazy"
            className="h-full w-full object-cover"
          />
          {active ? (
            <span className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" style={{ width: `${generation.progress}%` }} />
          ) : null}
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-ink/90">{generation.prompt}</p>
          <p className="mt-0.5 truncate text-[11px] text-muted">
            #{generation.id} · {props.modelLabels?.[generation.model_name] ?? generation.model_name} · {image.width}×{image.height} · {formatBytes(image.file_size)} ·{" "}
            {formatTime(image.created_at)}
          </p>
        </div>

        <span className="shrink-0 text-[11px] text-muted">
          {active ? `${statusLabel(generation.status)} ${generation.progress}%` : statusLabel(generation.status)}
        </span>

        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            title={image.is_favorite ? "取消收藏" : "收藏"}
            onClick={(event) => {
              event.stopPropagation();
              props.onFavorite(item);
            }}
            className={[
              "icon-btn",
              image.is_favorite ? "text-warn" : "",
            ].join(" ")}
          >
            <IconStar filled={image.is_favorite} />
          </button>
          <button
            type="button"
            title="下载"
            onClick={(event) => {
              event.stopPropagation();
              props.onDownload(item);
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
              props.onDelete(item);
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
      onClick={() => props.onOpen(item)}
      onKeyDown={(event) => event.key === "Enter" && props.onOpen(item)}
      className="group relative cursor-pointer overflow-hidden rounded-xl border border-edge/60 bg-surface2 transition hover:border-accent/40 hover:shadow-pop"
    >
      <div className="relative aspect-square overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageThumbnailUrl(image.id)}
          alt={generation.prompt}
          loading="lazy"
          className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]"
        />

        <div className="absolute left-2 top-2 flex items-center gap-1">
          {batchBadge}
          {image.is_favorite ? (
            <span className="rounded-md bg-black/55 p-1 text-warn backdrop-blur">
              <IconStar filled />
            </span>
          ) : null}
        </div>

        {active ? (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2">
            <div className="mb-1 flex items-center justify-between text-[10px] text-white/85">
              <span>{statusLabel(generation.status)}</span>
              <span>{generation.progress}%</span>
            </div>
            <div className="h-0.5 w-full overflow-hidden rounded-full bg-white/20">
              <div className="h-full rounded-full bg-accentSoft" style={{ width: `${generation.progress}%` }} />
            </div>
          </div>
        ) : (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-2 bg-gradient-to-t from-black/75 via-black/35 to-transparent p-2.5 opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100">
            <p className="line-clamp-2 text-[11px] leading-snug text-white/90">{generation.prompt}</p>
          </div>
        )}

        <ActionBar {...props} />
      </div>

      <div className="flex items-center justify-between gap-2 px-2.5 py-2">
        <span className="truncate text-[11px] text-muted">
          {image.width}×{image.height}
        </span>
        <span className="shrink-0 text-[10px] text-muted/70">{formatTime(image.created_at)}</span>
      </div>
    </div>
  );
}
