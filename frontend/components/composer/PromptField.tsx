"use client";

import { useRef } from "react";

import { useAutosizeTextarea } from "@/hooks/useAutosizeTextarea";

/**
 * 提示词输入框：无边框、透明底、随内容长高。
 *
 * 交互和其它创作框一致：Ctrl/⌘+Enter 提交，失焦时把内容交回去保存。
 */
export default function PromptField({
  value,
  onChange,
  onSubmit,
  onCommit,
  placeholder,
  maxLength = 8000,
  autoFocus = false,
  resetKey,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Ctrl/⌘+Enter */
  onSubmit: () => void;
  /** 失焦时保存 */
  onCommit?: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  autoFocus?: boolean;
  /** 换层/换元素时强制重算高度 */
  resetKey?: string | number | null;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useAutosizeTextarea(ref, value, { maxHeight: 200, resetKey });

  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      autoFocus={autoFocus}
      maxLength={maxLength}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          onSubmit();
        }
      }}
      onBlur={() => onCommit?.(value)}
      className="scroll-thin min-h-[52px] flex-1 resize-none bg-transparent px-1 py-2 text-sm leading-relaxed text-ink outline-none placeholder:text-muted/60 disabled:opacity-60"
    />
  );
}
