"use client";

import { useQuery } from "@tanstack/react-query";

import { fetchHealth } from "@/lib/api";

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${
        ok ? "bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/60" : "bg-rose-500"
      }`}
    />
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-edge/60 py-2 last:border-0">
      <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
      <span className="max-w-[70%] break-all text-right font-mono text-xs text-slate-300">
        {value}
      </span>
    </div>
  );
}

export function HealthCard() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 10_000,
  });

  return (
    <section className="card">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-slate-200">环境状态</h2>
        {data && (
          <span className="rounded-full border border-edge px-2 py-0.5 text-[11px] uppercase text-slate-400">
            {data.status}
          </span>
        )}
      </header>

      {isLoading && <p className="text-xs text-slate-500">探测中…</p>}
      {isError && (
        <p className="text-xs text-rose-400">
          无法连接后端：{error instanceof Error ? error.message : "未知错误"}
        </p>
      )}

      {data && (
        <div>
          <Row
            label="后端"
            value={
              <span className="inline-flex items-center gap-2">
                <Dot ok={data.status !== "error"} /> {data.app} v{data.version}
              </span>
            }
          />
          <Row
            label="数据库"
            value={
              <span className="inline-flex items-center gap-2">
                <Dot ok={data.database.status === "ok"} /> {data.database.status}
              </span>
            }
          />
          <Row label="DB 路径" value={data.database.path ?? "—"} />
          <Row
            label="ComfyUI"
            value={
              <span className="inline-flex items-center gap-2">
                <Dot ok={data.comfyui.reachable} />
                {data.comfyui.reachable ? `v${data.comfyui.version ?? "?"}` : "不可达"}
              </span>
            }
          />
          <Row label="地址" value={data.comfyui.url} />
          <Row label="GPU" value={data.comfyui.device ?? "—"} />
          {data.comfyui.error && <Row label="错误" value={data.comfyui.error} />}
          <Row
            label="存储"
            value={
              <span className="inline-flex items-center gap-2">
                <Dot ok={data.storage.status === "ok"} /> {data.storage.detail ?? "—"}
              </span>
            }
          />
        </div>
      )}
    </section>
  );
}
