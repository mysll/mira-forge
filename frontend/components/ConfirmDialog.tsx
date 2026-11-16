"use client";

import { useEffect } from "react";

type Props = {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** 危险操作：确认按钮用红色，标题带警示色 */
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * 破坏性操作的确认框。刻意不用 window.confirm：
 * 需要把「会删多少张、删了能不能恢复」写清楚，原生弹窗做不到。
 */
export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "取消",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onCancel]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onCancel();
        }
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-[420px] rounded-xl2 border border-edge bg-surface p-5 shadow-pop">
        <div className="flex items-start gap-3">
          <span
            className={[
              "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
              danger ? "bg-bad/15 text-bad" : "bg-accent/15 text-accentSoft",
            ].join(" ")}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
              <path
                d="M12 8v5m0 3.2v.1M10.3 4.3 3.6 16.4A2 2 0 0 0 5.3 19.5h13.4a2 2 0 0 0 1.7-3.1L13.7 4.3a2 2 0 0 0-3.4 0Z"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-ink">{title}</h2>
            <div className="mt-1.5 text-xs leading-relaxed text-muted">{description}</div>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-9 rounded-lg border border-edge bg-surface2 px-3 text-xs text-ink/90 transition hover:border-accent/40 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={[
              "inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition disabled:opacity-60",
              danger
                ? "bg-bad text-white hover:bg-bad/90"
                : "bg-accent text-white hover:bg-accent/90",
            ].join(" ")}
          >
            {busy ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border border-white/40 border-t-white" />
            ) : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
