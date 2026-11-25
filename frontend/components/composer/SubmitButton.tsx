"use client";

/** 创作框的提交按钮：主按钮 + 进行中转圈，三处共用同一套外观。 */
export default function SubmitButton({
  label,
  pending,
  pendingLabel = "提交中",
  disabled,
  onClick,
  minWidth = 104,
  className = "",
}: {
  label: string;
  pending: boolean;
  pendingLabel?: string;
  disabled: boolean;
  onClick: () => void;
  minWidth?: number;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || pending}
      className={["btn-primary ml-2", className].filter(Boolean).join(" ")}
      style={{ minWidth }}
    >
      {pending ? (
        <>
          <span className="h-3 w-3 animate-spin rounded-full border border-white/70 border-t-transparent" />
          {pendingLabel}
        </>
      ) : (
        <>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
            <path
              d="m5 12 5 5 9-10"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {label}
        </>
      )}
    </button>
  );
}
