"use client";

import Link from "next/link";

const TOOL_URL = "/tools/spriteforge/index.html";

export default function SpriteForgePage() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-edge/70 px-5 py-2.5">
        <Link
          href="/tools"
          className="shrink-0 rounded-lg border border-edge px-2 py-1 text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-ink"
        >
          ← 工具
        </Link>
        <h1 className="shrink-0 whitespace-nowrap text-[13px] font-medium text-ink">序列帧工坊</h1>
        <span className="hidden truncate text-[11px] text-muted/70 sm:inline">
          视频抽帧 · 抠透明背景 · 按行列打图集 · 导出 PNG + JSON
        </span>
        <a
          href={TOOL_URL}
          target="_blank"
          rel="noreferrer"
          className="ml-auto shrink-0 rounded-lg border border-edge px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-ink"
        >
          在新标签页打开 ↗
        </a>
      </header>

      <iframe
        src={TOOL_URL}
        title="序列帧工坊"
        className="min-h-0 w-full flex-1 border-0 bg-bg"
        allow="clipboard-write; fullscreen"
      />
    </div>
  );
}
