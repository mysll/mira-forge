"use client";

import type { ReactNode } from "react";

/**
 * 创作页底部的悬浮输入框外壳。
 *
 * 三个创作页（图片/视频、分层、元素）都挂在同一个位置上，外壳、圆角、玻璃底
 * 必须一致，所以抽到这里；里面怎么排由各自的 Composer 决定。
 */
export default function ComposerCard({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-4 pb-4">
      <div className="pointer-events-auto relative mx-auto flex max-w-[1180px] flex-col gap-2.5 rounded-xl2 border border-edge/80 bg-surface/92 p-3 shadow-pop backdrop-blur-2xl">
        {children}
      </div>
    </div>
  );
}
