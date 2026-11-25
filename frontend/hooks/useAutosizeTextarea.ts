"use client";

import { useEffect } from "react";

/**
 * 让 textarea 随内容长高，超过 maxHeight 之后内部滚动。
 *
 * value 变了要重算；resetKey 用来覆盖「换了内容但 value 恰好相同」的情况，
 * 例如切换层/元素、收起再展开（此时 textarea 是重新挂载的）。
 */
export function useAutosizeTextarea(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
  options: { maxHeight?: number; resetKey?: string | number | null } = {},
) {
  const { maxHeight = 200, resetKey } = options;

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, maxHeight)}px`;
  }, [ref, value, maxHeight, resetKey]);
}
