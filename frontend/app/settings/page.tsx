"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import ElementPromptSettings from "@/components/ElementPromptSettings";
import LayerPromptSettings from "@/components/LayerPromptSettings";
import LLMSettings from "@/components/LLMSettings";
import PromptTemplateSettings from "@/components/PromptTemplateSettings";
import { fetchHealth, unloadComfyModels } from "@/lib/api";
import { formatBytes } from "@/lib/date";

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

function Card({
  title,
  hint,
  rows,
  footer,
}: {
  title: string;
  hint?: string;
  rows: Row[];
  footer?: React.ReactNode;
}) {
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
      {footer ? <div className="mt-3 border-t border-edge/50 pt-3">{footer}</div> : null}
    </section>
  );
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const health = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 5000,
  });

  const unload = useMutation({
    mutationFn: unloadComfyModels,
    onSuccess: (result) => {
      // 显存变了，让健康检查立刻重读一次
      void queryClient.invalidateQueries({ queryKey: ["health"] });
      if (result.ok && result.vram_free_after != null && result.vram_total != null) {
        setNote(`已卸载模型：空闲显存 ${formatBytes(result.vram_free_after)} / ${formatBytes(result.vram_total)}`);
      } else if (result.ok) {
        setNote("已发出卸载指令（没读到显存，可能刚启动）");
      } else {
        setNote(`卸载失败：${result.detail ?? "未知原因"}`);
      }
    },
    onError: (error: Error) => setNote(`请求失败：${error.message}`),
  });

  const data = health.data;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto px-6 py-6">
      <div className="mx-auto flex max-w-[900px] flex-col gap-4">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-base text-ink">设置</h1>
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
          title="当前项目"
          hint="每个项目一个独立文件夹"
          rows={[
            { label: "名称", value: data?.project_name ?? "—" },
            { label: "标识", value: data?.project_id ?? "—" },
            { label: "目录", value: data?.project_path ?? "—" },
            { label: "结构", value: "app.db · storage/images · storage/thumbnails · storage/uploads" },
          ]}
        />

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
            {
              label: "显存",
              value:
                data?.comfyui.vram_total != null ? (
                  <span>
                    空闲 {formatBytes(data.comfyui.vram_free ?? 0)} / 共{" "}
                    {formatBytes(data.comfyui.vram_total)}
                    {data.comfyui.vram_free != null ? (
                      <span className="ml-1 text-muted">
                        （{Math.round(((data.comfyui.vram_total - data.comfyui.vram_free) / data.comfyui.vram_total) * 100)}
                        % 占用）
                      </span>
                    ) : null}
                  </span>
                ) : (
                  "—"
                ),
            },
            ...(data?.comfyui.error ? [{ label: "错误", value: data.comfyui.error }] : []),
          ]}
          footer={
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setNote(null);
                  unload.mutate();
                }}
                disabled={unload.isPending || !data?.comfyui.reachable}
                className="btn border border-edge bg-surface2 px-3 py-1.5 text-xs text-ink transition hover:border-accent/50 hover:text-accentSoft disabled:cursor-not-allowed disabled:opacity-50"
                title="调用 ComfyUI 的 /free：卸载已加载的模型，把显存还回来（下次生成会重新加载，首张会慢一些）"
              >
                {unload.isPending ? (
                  <span className="flex items-center gap-1.5">
                    <span className="h-3 w-3 animate-spin rounded-full border border-muted/40 border-t-accentSoft" />
                    正在卸载…
                  </span>
                ) : (
                  "卸载模型 · 释放显存"
                )}
              </button>
              <span className="text-[11px] text-muted">
                切到大模型或跑视频前腾显存用；不影响已生成的图片。
              </span>
            </div>
          }
        />
        {note ? <p className="-mt-2 px-1 text-[11px] text-muted">{note}</p> : null}

        <LLMSettings />

        <LayerPromptSettings />

        <ElementPromptSettings />

        <Card
          title="存储"
          rows={[
            { label: "状态", value: <span className="flex items-center gap-1.5"><StatusDot status={data?.storage.status ?? "unknown"} />{statusText(data?.storage.status)}</span> },
            { label: "目录", value: data?.storage_path ?? "—" },
            { label: "结构", value: "images/<批次>/ 原图 · thumbnails/ 缩略图 · uploads/ 参考图" },
          ]}
        />

        <PromptTemplateSettings />

        <section className="panel p-4 text-xs leading-relaxed text-muted">
          <h2 className="mb-2 text-sm text-ink">关于</h2>
          <p>
            MiraForge：本地 AI 图片与视频生成。所有推理走本机 ComfyUI（Qwen Image 2.1 / Turbo、MiniMax
            H3），任务串行执行，产物落在本机磁盘，一个项目一个文件夹。
          </p>
        </section>
      </div>
    </div>
  );
}
