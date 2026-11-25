"use client";

import type { ReactNode } from "react";

/**
 * 固定的参考图：分层用源场景图，元素用场景底图。
 *
 * 和图片编辑不一样，这里的参考图是后端固定好的，不给换、不给删，
 * 只提供「点开看大图」；遮罩入口挂在图块下面一行（和场景编辑一样）。
 */
export default function PinnedReference({
  url,
  label,
  caption,
  title,
  onPreview,
  action,
}: {
  url?: string | null;
  /** 图块底部的小标签，例如「原图」「参考」 */
  label: string;
  /** 图块下面一行说明，例如「结构」 */
  caption?: string;
  title?: string;
  onPreview?: () => void;
  /** 说明行里的附加动作（遮罩入口） */
  action?: ReactNode;
}) {
  const tile = (
    <span className="relative block h-[52px] w-[52px] overflow-hidden rounded-lg border border-edge bg-surface2/60">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={label} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-[10px] text-muted/60">
          底图
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 bg-black/55 py-[1px] text-center text-[9px] leading-none text-white/80">
        {label}
      </span>
    </span>
  );

  return (
    <div className="group/slot flex shrink-0 flex-col items-center gap-1" data-slot>
      {url && onPreview ? (
        <button
          type="button"
          onClick={onPreview}
          title={title ?? "点开看大图（参考图是固定的，不能换）"}
          className="cursor-zoom-in"
        >
          {tile}
        </button>
      ) : (
        <div title={title}>{tile}</div>
      )}
      <span className="flex h-[14px] items-center justify-center gap-1 whitespace-nowrap text-[9px] leading-none text-muted/70">
        {caption ? <span>{caption}</span> : null}
        {action}
      </span>
    </div>
  );
}
