"use client";

/**
 * 已画遮罩的缩略块：和场景编辑里的「遮罩」格子一样，挂在参考图旁边。
 *
 * 点图块重新画，右上角 × 清掉遮罩（清掉后恢复整张重画）。
 */
export default function MaskTile({
  url,
  title,
  onEdit,
  onClear,
}: {
  url: string;
  /** 语义文案由调用方给：分层是「层的覆盖范围」，元素是「定位框」 */
  title?: string;
  onEdit: () => void;
  onClear?: () => void;
}) {
  return (
    <div className="group/slot flex shrink-0 flex-col items-center gap-1" data-slot>
      <div className="group relative h-[52px] w-[52px] overflow-hidden rounded-lg border border-accent/60">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="遮罩" className="h-full w-full object-cover" />
        <button
          type="button"
          onClick={onEdit}
          title={title ?? "重新画遮罩"}
          className="absolute inset-0 flex items-center justify-center bg-black/55 text-white opacity-0 transition group-hover:opacity-100"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
            <path
              d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20Z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {onClear ? (
          <button
            type="button"
            onClick={onClear}
            title="清掉遮罩，恢复整张重画"
            className="absolute right-0.5 top-0.5 hidden h-4 w-4 items-center justify-center rounded bg-black/70 text-[10px] text-white group-hover:flex"
          >
            ×
          </button>
        ) : null}
      </div>
      <div className="flex h-[14px] items-center whitespace-nowrap text-[9px] leading-none text-accentSoft/80">
        遮罩
      </div>
    </div>
  );
}
