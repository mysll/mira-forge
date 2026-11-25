"use client";

import type { ReactNode } from "react";

/**
 * 输入框标题行：徽标 + 名称 + 副标题 + 模型名 + 折叠。
 *
 * 三个输入框共用这一行，保证「同样的东西长在同样的位置」；
 * 遮罩入口不在这里，而是挂在参考图下面（和场景编辑一致）。
 */
export default function ComposerHeader({
  badge,
  badgeMono = false,
  title,
  subtitle,
  modelLabel,
  collapsed,
  onToggleCollapse,
  children,
}: {
  badge: string;
  /** 层号用等宽字体（L1/L2），元素分类不用 */
  badgeMono?: boolean;
  title: string;
  subtitle?: string;
  modelLabel?: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** 标题行右侧、模型名之前的自定义动作 */
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1">
      <span
        className={[
          "rounded-md bg-accent/15 px-2 py-1 text-[10px] text-accentSoft",
          badgeMono ? "font-mono" : "",
        ].join(" ")}
      >
        {badge}
      </span>
      <span className="truncate px-1 text-xs text-ink" title={title}>
        {title}
      </span>
      {subtitle ? (
        <span className="hidden truncate rounded-md px-2 py-1 text-[10px] text-muted sm:inline">
          {subtitle}
        </span>
      ) : null}

      {children}

      {modelLabel ? (
        <span className="ml-auto truncate pl-2 text-[11px] text-muted/60">{modelLabel}</span>
      ) : (
        <span className="ml-auto" />
      )}

      {onToggleCollapse ? (
        <button
          type="button"
          onClick={onToggleCollapse}
          className="ml-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-surface2 hover:text-ink"
          title={collapsed ? "展开输入框" : "收起输入框"}
          aria-label={collapsed ? "展开输入框" : "收起输入框"}
          aria-expanded={!collapsed}
        >
          <svg
            viewBox="0 0 24 24"
            className={["h-3.5 w-3.5 transition-transform", collapsed ? "" : "rotate-180"].join(" ")}
            fill="none"
            aria-hidden
          >
            <path
              d="m6 15 6-6 6 6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
