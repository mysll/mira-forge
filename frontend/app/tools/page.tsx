"use client";

import Link from "next/link";

const TOOLS = [
  {
    key: "editor",
    title: "图片编辑器",
    description: "抠掉纯色背景、改画布尺寸、等比缩放主体、指定底部位置，导出 PNG。",
    badge: "本地处理",
    href: "/tools/editor",
    ready: true,
    tags: ["抠背景", "画布", "等比缩放", "导出"],
  },
  {
    key: "resize",
    title: "批量改尺寸",
    description: "把一批图统一到同一个画布与主体比例，适合做角色三视图与图标。",
    badge: "计划中",
    href: "",
    ready: false,
    tags: ["批量", "对齐"],
  },
  {
    key: "frames",
    title: "视频抽帧",
    description: "从生成的视频里挑一帧存成图片，方便继续做图或当参考图。",
    badge: "计划中",
    href: "",
    ready: false,
    tags: ["抽帧", "封面"],
  },
  {
    key: "grid",
    title: "九宫格切图",
    description: "把一张多宫格分镜切成单张，逐张送进编辑器或生成流程。",
    badge: "计划中",
    href: "",
    ready: false,
    tags: ["切图", "分镜"],
  },
];

export default function ToolsPage() {
  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <header className="flex items-center gap-3 border-b border-edge/70 px-5 py-2.5">
        <h1 className="shrink-0 whitespace-nowrap text-[13px] font-medium text-ink">工具</h1>
        <span className="text-[11px] text-muted/70">本地处理 · 不占用 GPU · 不改动原图</span>
      </header>

      <section className="px-6 pb-2 pt-8">
        <h2 className="text-[22px] font-semibold tracking-tight text-ink">创作之后，再修一修</h2>
        <p className="mt-2 max-w-xl text-[12.5px] leading-relaxed text-muted">
          这里的工具都在本机跑，不经过 ComfyUI，也不消耗显存。做好的图还能回到作品库，或者直接当参考图继续生成。
        </p>
      </section>

      <section className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-3.5 px-6 py-6">
        {TOOLS.map((tool) => (
          <ToolCard key={tool.key} tool={tool} />
        ))}
      </section>
      <section className="mx-6 mb-8 rounded-xl2 border border-edge/70 bg-surface/50 px-5 py-4">
        <h3 className="text-[12px] font-medium text-ink">三个小提示</h3>
        <ul className="mt-2 flex flex-col gap-1.5 text-[11.5px] leading-relaxed text-muted">
          <li>· 抠背景对纯色背景最准。容差调大一点会多删，调小会保留更多边缘，建议先点「采用」用估计值。</li>
          <li>· 主体只能按高度百分比等比缩放，宽度自动跟着比例走，所以永远不会变形。</li>
          <li>· 导出永远是当前画布尺寸（透明区域保留 alpha），不会覆盖作品库里的原图。</li>
        </ul>
      </section>
    </div>
  );
}

function ToolCard({ tool }: { tool: (typeof TOOLS)[number] }) {
  const body = (
    <div
      className={[
        "group flex h-full flex-col overflow-hidden rounded-xl2 border transition",
        tool.ready
          ? "border-edge bg-surface hover:border-accent/50"
          : "border-edge/60 bg-surface/50 opacity-70",
      ].join(" ")}
    >
      <div className="relative flex h-[124px] items-center justify-center border-b border-edge/60 bg-[radial-gradient(circle_at_30%_20%,#241f3a,transparent_60%),radial-gradient(circle_at_75%_80%,#1b2a2f,transparent_55%)]">
        <ToolGlyph kind={tool.key} />
        <span
          className={[
            "absolute right-2 top-2 rounded-full px-2 py-0.5 text-[10px]",
            tool.ready ? "bg-accent/20 text-accentSoft" : "bg-white/5 text-muted",
          ].join(" ")}
        >
          {tool.badge}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1.5 px-3.5 pb-3.5 pt-3">
        <h3 className="text-[13px] font-medium text-ink">{tool.title}</h3>
        <p className="text-[11.5px] leading-relaxed text-muted">{tool.description}</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {tool.tags.map((tag) => (
            <span key={tag} className="rounded border border-edge/80 px-1.5 py-0.5 text-[10px] text-muted/80">
              {tag}
            </span>
          ))}
        </div>
        <span
          className={[
            "mt-auto pt-2.5 text-[11.5px]",
            tool.ready ? "text-accentSoft group-hover:underline" : "text-muted/50",
          ].join(" ")}
        >
          {tool.ready ? "打开编辑器 →" : "敬请期待"}
        </span>
      </div>
    </div>
  );

  if (!tool.ready) {
    return <div aria-disabled className="cursor-not-allowed">{body}</div>;
  }
  return (
    <Link href={tool.href} className="block">
      {body}
    </Link>
  );
}

function ToolGlyph({ kind }: { kind: string }) {
  if (kind === "editor") {
    return (
      <svg viewBox="0 0 64 64" className="h-14 w-14 text-accentSoft" fill="none" aria-hidden>
        <rect x="8" y="10" width="30" height="24" rx="3" stroke="currentColor" strokeWidth="1.6" opacity="0.7" />
        <path d="M8 34 L22 22 L32 32 L38 26" stroke="currentColor" strokeWidth="1.4" opacity="0.45" />
        <rect x="30" y="26" width="26" height="28" rx="3" stroke="currentColor" strokeWidth="1.8" strokeDasharray="3 3" />
        <path d="M30 46 H56" stroke="currentColor" strokeWidth="1.2" opacity="0.4" />
      </svg>
    );
  }
  if (kind === "resize") {
    return (
      <svg viewBox="0 0 64 64" className="h-14 w-14 text-muted" fill="none" aria-hidden>
        <rect x="12" y="14" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <rect x="36" y="30" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 3" />
        <path d="M30 23 H44 V28" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 64 64" className="h-14 w-14 text-muted" fill="none" aria-hidden>
      <rect x="10" y="16" width="44" height="30" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M26 22 L40 31 L26 40 Z" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 52 H54" stroke="currentColor" strokeWidth="1.2" opacity="0.4" />
    </svg>
  );
}
