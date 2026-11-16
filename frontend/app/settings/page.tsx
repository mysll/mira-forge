"use client";

import { useQuery } from "@tanstack/react-query";

import { fetchHealth } from "@/lib/api";

type Row = { label: string; value: React.ReactNode };

const STATUS_TEXT: Record<string, string> = {
  ok: "正常",
  degraded: "降级",
  error: "异常",
  unknown: "读取中",
};

function statusText(status: string | undefined | null): string {
  return STATUS_TEXT[status ?? "unknown"] ?? status ?? "—";
}

function StatusDot({ status }: { status: string }) {
  const tone =
    status === "ok"
      ? "bg-ok"
      : status === "degraded"
        ? "bg-warn"
        : status === "error"
          ? "bg-bad"
          : "bg-muted";
  return <span className={["inline-block h-1.5 w-1.5 rounded-full", tone].join(" ")} />;
}

function Card({ title, hint, rows }: { title: string; hint?: string; rows: Row[] }) {
  return (
    <section className="panel p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm text-ink">{title}</h2>
        {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
      </header>
      <dl className="flex flex-col">
        {rows.map((row) => (
          <div key={row.label} className="flex gap-3 border-t border-edge/50 py-2 text-xs first:border-0">
            <dt className="w-24 shrink-0 text-muted">{row.label}</dt>
            <dd className="min-w-0 flex-1 break-all text-ink/90">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default function SettingsPage() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 5000,
  });

  const data = health.data;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto px-6 py-6">
      <div className="mx-auto flex max-w-[900px] flex-col gap-4">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-base text-ink">设置</h1>
            <p className="mt-1 text-xs text-muted">
              系统状态只在设置里展示，首页保持干净的创作视图。
            </p>
          </div>
          <span className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface px-2.5 py-1 text-[11px] text-muted">
            <StatusDot status={data?.status ?? "unknown"} />
            {data?.status === "ok"
              ? "全部正常"
              : data?.status === "degraded"
                ? "部分异常"
                : data?.status === "error"
                  ? "不可用"
                  : "读取中"}
          </span>
        </header>

        {health.isError ? (
          <div className="panel border-bad/40 p-4 text-xs text-bad">
            无法连接后端：{(health.error as Error)?.message ?? "未知错误"}
          </div>
        ) : null}

        <Card
          title="后端服务"
          hint={data ? `v${data.version}` : undefined}
          rows={[
            { label: "状态", value: <span className="flex items-center gap-1.5"><StatusDot status={data?.status ?? "unknown"} />{statusText(data?.status)}</span> },
            { label: "版本", value: data?.version ?? "—" },
            { label: "生成上限", value: data ? `每批最多 ${data.max_generation_count} 张` : "—" },
          ]}
        />

        <Card
          title="数据库"
          rows={[
            { label: "状态", value: <span className="flex items-center gap-1.5"><StatusDot status={data?.database.status ?? "unknown"} />{statusText(data?.database.status)}</span> },
            { label: "文件", value: data?.database.path ?? "—" },
            { label: "类型", value: "SQLite（本地单文件）" },
          ]}
        />

        <Card
          title="ComfyUI"
          hint={data?.comfyui.reachable ? "已连接" : "未连接"}
          rows={[
            {
              label: "状态",
              value: (
                <span className="flex items-center gap-1.5">
                  <StatusDot status={data?.comfyui.status ?? "unknown"} />
                  {data?.comfyui.reachable ? "可访问" : "不可访问"}
                </span>
              ),
            },
            { label: "地址", value: data?.comfyui.url ?? "—" },
            { label: "版本", value: data?.comfyui.version ?? "—" },
            { label: "GPU", value: data?.comfyui.device ?? "—" },
            ...(data?.comfyui.error ? [{ label: "错误", value: data.comfyui.error }] : []),
          ]}
        />

        <Card
          title="存储"
          rows={[
            { label: "状态", value: <span className="flex items-center gap-1.5"><StatusDot status={data?.storage.status ?? "unknown"} />{statusText(data?.storage.status)}</span> },
            { label: "目录", value: data?.storage_path ?? "—" },
            { label: "结构", value: "images/<批次>/ 原图 · thumbnails/ 缩略图 · uploads/ 参考图" },
          ]}
        />

        <section className="panel p-4 text-xs leading-relaxed text-muted">
          <h2 className="mb-2 text-sm text-ink">关于</h2>
          <p>
            MiraForge 一期：本地文生图与图片编辑。所有推理走本机 ComfyUI（Qwen Image 2.1 / Turbo），
            任务串行执行，图片落在本机磁盘。视频生成属于二期，入口先留位置。
          </p>
        </section>
      </div>
    </div>
  );
}
