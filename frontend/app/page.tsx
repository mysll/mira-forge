"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";

import ProjectSwitcher from "@/components/ProjectSwitcher";
import { fetchGenerations, fetchHealth, fetchModels, imageThumbnailUrl } from "@/lib/api";
import { formatBytes } from "@/lib/date";
import { useComposerStore } from "@/stores/composer";
import type { GenerationRead, ImageBrief, ModelInfo } from "@/types/api";

/**
 * 首页：进来先看到「能做什么」和「做过什么」。
 *
 * 不在这里塞创作框——创作界面有自己的两个页面（图片 / 视频），
 * 首页只负责两件事：把人送到该去的地方，以及让本机的状态一目了然。
 */

const IDEAS = [
  { label: "雨夜霓虹", prompt: "a ceramic fox in a rain-soaked neon alley, cinematic, 35mm film" },
  { label: "静物逆光", prompt: "a single ripe fig on a marble ledge, hard afternoon light, minimal still life" },
  { label: "晨光窗台", prompt: "a glass teapot steaming on a rainy windowsill, warm backlight, shallow depth of field" },
  { label: "纸感插画", prompt: "a paper-cut illustration of a lighthouse at dusk, layered depth, soft grain" },
  { label: "建筑几何", prompt: "a brutalist stairwell in morning haze, geometric shadows, muted concrete" },
  { label: "微距材质", prompt: "macro shot of frost melting on dark slate, crisp detail, cool highlights" },
];

export default function HomePage() {
  const router = useRouter();
  const setMode = useComposerStore((state) => state.setMode);
  const setPrompt = useComposerStore((state) => state.setPrompt);

  const healthQuery = useQuery({ queryKey: ["health"], queryFn: fetchHealth, refetchInterval: 10_000 });
  const modelsQuery = useQuery({ queryKey: ["models"], queryFn: fetchModels, staleTime: 60_000 });

  const recentQuery = useQuery({
    queryKey: ["generations", "home-recent"],
    queryFn: () => fetchGenerations({ limit: 8 }),
    staleTime: 5_000,
  });
  const imageCount = useQuery({
    queryKey: ["generations", "home-count-image"],
    queryFn: () => fetchGenerations({ limit: 1, media: "image" }),
    staleTime: 10_000,
  });
  const videoCount = useQuery({
    queryKey: ["generations", "home-count-video"],
    queryFn: () => fetchGenerations({ limit: 1, media: "video" }),
    staleTime: 10_000,
  });

  const health = healthQuery.data;
  const models = modelsQuery.data ?? [];
  const comfy = health?.comfyui;

  const recent: ImageBrief[] = useMemo(() => {
    const rows: GenerationRead[] = recentQuery.data?.items ?? [];
    const flat: ImageBrief[] = [];
    for (const row of rows) {
      for (const image of row.images) {
        flat.push(image);
      }
    }
    return flat.slice(0, 12);
  }, [recentQuery.data]);

  const vramTotal = comfy?.vram_total ?? null;
  const vramFree = comfy?.vram_free ?? null;
  const vramUsedPct =
    vramTotal && vramFree !== null && vramFree !== undefined
      ? Math.max(0, Math.min(100, Math.round(((vramTotal - vramFree) / vramTotal) * 100)))
      : null;

  const goCreate = (media: "image" | "video") => {
    if (media === "video") {
      router.push("/video");
      return;
    }
    setMode("text_to_image");
    router.push("/compose");
  };

  const useIdea = (prompt: string) => {
    setMode("text_to_image");
    setPrompt(prompt);
    router.push("/compose");
  };

  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-edge/60 px-5">
        <ProjectSwitcher />
        <span className="text-xs text-muted/60">首页</span>
        <span className="ml-auto flex items-center gap-2 text-[11px] text-muted">
          <span
            className={[
              "h-1.5 w-1.5 rounded-full",
              health?.status === "ok" ? "bg-ok" : health?.status === "degraded" ? "bg-warn" : "bg-bad",
            ].join(" ")}
          />
          本机 ComfyUI {comfy?.reachable ? `v${comfy.version ?? "?"}` : "未连接"}
        </span>
      </header>

      <main className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-5 py-6">
        {/* Hero */}
        <section className="relative overflow-hidden rounded-xl2 border border-edge/70 bg-surface/60 p-7">
          <div className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-accent/20 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-32 right-24 h-64 w-64 rounded-full bg-accentSoft/10 blur-3xl" />
          <div className="relative flex flex-col gap-7 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted/70">Local generation studio</p>
              <h1 className="mt-2 text-2xl font-semibold text-ink">今天想生成点什么？</h1>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
                所有推理都在本机跑：Qwen Image 2.1 出图，MiniMax H3 出带声音的视频。产物与参数全部落在本机，不上传任何地方。
              </p>

              <div className="mt-6 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => goCreate("image")}
                  className="group flex items-center gap-3 rounded-xl2 bg-accent px-5 py-3 text-left text-white transition hover:bg-accentSoft"
                >
                  <SparkIcon />
                  <span>
                    <span className="block text-sm font-medium leading-tight">生成图片</span>
                    <span className="block text-[11px] leading-tight text-white/70">文生图 · 参考图 · 图片编辑</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => goCreate("video")}
                  className="group flex items-center gap-3 rounded-xl2 border border-edge bg-surface2 px-5 py-3 text-left text-ink transition hover:border-accent/40 hover:bg-surface2/80"
                >
                  <FilmIcon />
                  <span>
                    <span className="block text-sm font-medium leading-tight">生成视频</span>
                    <span className="block text-[11px] leading-tight text-muted">首尾帧 · 1–15 秒 · 带音频</span>
                  </span>
                </button>
              </div>
            </div>

            {/* 右侧：把「这台机器现在什么状态」摆出来，hero 不至于空半边 */}
            <dl className="hidden w-[280px] shrink-0 flex-col gap-2.5 rounded-xl2 border border-edge/60 bg-bg/40 p-4 text-[11px] lg:flex">
              <HeroFact
                label="设备"
                value={comfy?.device ? comfy.device.split(" : ")[0].replace(/^cuda:\d+\s*/, "") : "未连接"}
                tone={comfy?.reachable ? "ok" : "bad"}
              />
              <HeroFact
                label="显存"
                value={
                  vramTotal && vramFree !== null && vramFree !== undefined
                    ? `占用 ${vramUsedPct}% · 空闲 ${formatBytes(vramFree)}`
                    : "—"
                }
              />
              <HeroFact label="队列" value={health?.comfyui?.reachable ? "串行执行 · 一次一任务" : "ComfyUI 未连接"} />
              <HeroFact
                label="项目"
                value={health?.project_name ? `${health.project_name} · 独立数据库与目录` : "—"}
              />
            </dl>
          </div>
        </section>

        {/* 概览 */}
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="图片" value={imageCount.data ? String(imageCount.data.total) : "—"} unit="张" hint="本机累计" />
          <Stat label="视频" value={videoCount.data ? String(videoCount.data.total) : "—"} unit="条" hint="本机累计" />
          <Stat label="可用模型" value={String(models.length)} unit="个" hint="来自 registry.yaml" />
          <Stat
            label="显存占用"
            value={vramUsedPct === null ? "—" : `${vramUsedPct}`}
            unit="%"
            hint={
              vramFree !== null && vramFree !== undefined && vramTotal
                ? `空闲 ${formatBytes(vramFree)} / ${formatBytes(vramTotal)}`
                : "ComfyUI 未连接"
            }
            accent={vramUsedPct !== null && vramUsedPct > 85}
          />
        </section>

        {/* 最近作品 */}
        <section className="rounded-xl2 border border-edge/70 bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-medium text-ink">最近作品</h2>
            <Link href="/gallery" className="text-[11px] text-muted transition hover:text-accentSoft">
              查看全部 →
            </Link>
          </div>

          {recent.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted/70">
              {recentQuery.isLoading ? "加载中…" : "这个项目还没有作品，先生成第一张吧"}
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {recent.map((image) => (
                <Link
                  key={image.id}
                  href="/gallery"
                  title={`${image.width}×${image.height}${image.media_type === "video" ? ` · ${image.duration_seconds?.toFixed(1) ?? "?"} 秒` : ""}`}
                  className="group relative aspect-square overflow-hidden rounded-lg border border-edge/60 bg-surface2"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageThumbnailUrl(image)}
                    alt=""
                    className="h-full w-full object-cover transition group-hover:scale-[1.03]"
                    loading="lazy"
                  />
                  {image.media_type === "video" ? (
                    <>
                      <span className="absolute inset-0 flex items-center justify-center">
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-black/55 ring-1 ring-white/25">
                          <svg viewBox="0 0 24 24" className="ml-0.5 h-3 w-3 text-white" fill="currentColor" aria-hidden>
                            <path d="M8 5.5v13l11-6.5-11-6.5Z" />
                          </svg>
                        </span>
                      </span>
                      <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 py-0.5 text-[10px] text-white/90">
                        {image.duration_seconds?.toFixed(1) ?? "?"} 秒
                      </span>
                    </>
                  ) : null}
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* 模型 */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-ink">本机模型</h2>
            <Link href="/settings" className="text-[11px] text-muted transition hover:text-accentSoft">
              系统状态 →
            </Link>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {models.map((model) => (
              <ModelCard key={model.id} model={model} onUse={() => goCreate(model.capabilities.media === "video" ? "video" : "image")} />
            ))}
            {models.length === 0 ? (
              <p className="text-xs text-muted/70">正在读取模型目录…</p>
            ) : null}
          </div>
        </section>

        {/* 灵感 */}
        <section className="rounded-xl2 border border-edge/70 bg-surface/40 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-ink">没想法？从这些开始</h2>
            <span className="text-[11px] text-muted/60">点一下会带进创作框</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {IDEAS.map((idea) => (
              <button
                key={idea.label}
                type="button"
                onClick={() => useIdea(idea.prompt)}
                className="rounded-full border border-edge bg-surface2 px-3 py-1.5 text-xs text-muted transition hover:border-accent/40 hover:text-ink"
              >
                {idea.label}
              </button>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

function HeroFact({ label, value, tone }: { label: string; value: string; tone?: "ok" | "bad" }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-8 shrink-0 text-muted/60">{label}</dt>
      <dd className={["min-w-0 truncate", tone === "bad" ? "text-bad" : tone === "ok" ? "text-ink" : "text-ink/90"].join(" ")}>
        {value}
      </dd>
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  hint,
  accent,
}: {
  label: string;
  value: string;
  unit: string;
  hint: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl2 border border-edge/70 bg-surface/50 p-4">
      <p className="text-[11px] text-muted/70">{label}</p>
      <p className="mt-1.5 flex items-baseline gap-1">
        <span className={["text-xl font-semibold", accent ? "text-warn" : "text-ink"].join(" ")}>{value}</span>
        <span className="text-[11px] text-muted">{unit}</span>
      </p>
      <p className="mt-1 truncate text-[11px] text-muted/60">{hint}</p>
    </div>
  );
}

function ModelCard({ model, onUse }: { model: ModelInfo; onUse: () => void }) {
  const isVideo = model.capabilities.media === "video";
  const facts = isVideo
    ? ["音视频同出", "1–15 秒", "首尾帧可选"]
    : [
        model.capabilities.exposes_steps ? "步数可调" : "8 步 turbo",
        "480 / 720 / 1K / 2K",
        "参考图最多 2 张",
      ];

  return (
    <div className="flex flex-col gap-3 rounded-xl2 border border-edge/70 bg-surface/50 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-ink">{model.label}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted/80">{model.description}</p>
        </div>
        <span
          className={[
            "shrink-0 rounded-full px-2 py-0.5 text-[10px]",
            isVideo ? "bg-accentSoft/15 text-accentSoft" : "bg-accent/15 text-accentSoft",
          ].join(" ")}
        >
          {isVideo ? "视频" : "图片"}
        </span>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {facts.map((fact) => (
          <li key={fact} className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-muted">
            {fact}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onUse}
        className="mt-auto self-start rounded-lg border border-edge px-2.5 py-1 text-[11px] text-muted transition hover:border-accent/40 hover:text-ink"
      >
        去生成 →
      </button>
    </div>
  );
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="none" aria-hidden>
      <path
        d="M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9L12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M18 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z" fill="currentColor" />
    </svg>
  );
}

function FilmIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="none" aria-hidden>
      <rect x="3" y="5.5" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="m16 11.2 4.2-2.6v6.8L16 12.8" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}
