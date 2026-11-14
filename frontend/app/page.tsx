"use client";

import { useQuery } from "@tanstack/react-query";

import { GenerationForm } from "@/components/GenerationForm";
import { GenerationList } from "@/components/GenerationList";
import { HealthCard } from "@/components/HealthCard";
import { fetchModels } from "@/lib/api";

export default function HomePage() {
  const models = useQuery({ queryKey: ["models"], queryFn: fetchModels });

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-10">
      <header className="mb-8">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-slate-100">图片生成与编辑</h1>
          <span className="rounded-full border border-edge px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-500">
            一期
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          前端不直连 ComfyUI，所有生成请求经 FastAPI 排队后串行执行 · 画廊见顶部「画廊」页
        </p>
      </header>

      {models.isError && (
        <p className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">
          无法读取模型目录：
          {models.error instanceof Error ? models.error.message : "未知错误"}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-6">
          {models.data ? (
            <GenerationForm models={models.data} />
          ) : (
            <section className="card">
              <p className="text-xs text-slate-500">加载模型目录…</p>
            </section>
          )}
          <GenerationList />
        </div>
        <div className="space-y-6">
          <HealthCard />
          <section className="card">
            <h2 className="mb-3 text-sm font-semibold tracking-wide text-slate-200">阶段进度</h2>
            <ol className="space-y-1.5 text-[11px] text-slate-500">
              <li className="text-emerald-400">P1 初始化 · 完成</li>
              <li className="text-emerald-400">P2 ComfyUI 集成（真实出图）· 完成</li>
              <li className="text-emerald-400">P3 多图批量 · 完成</li>
              <li className="text-emerald-400">P4 图片编辑 · 完成</li>
              <li className="text-emerald-400">P5 前端画廊 / 历史 · 完成</li>
              <li className="text-emerald-400">P6 稳定性（取消 / 重试 / 崩溃恢复）· 完成</li>
              <li className="pt-1 text-slate-500">二期：视频生成与编辑</li>
            </ol>
          </section>
        </div>
      </div>
    </main>
  );
}
