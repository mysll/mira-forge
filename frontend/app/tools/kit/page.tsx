"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createKit, deleteKit, fetchKits } from "@/lib/api";
import type { KitRead } from "@/types/api";

export default function KitListPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [padding, setPadding] = useState(6);
  const [maxWidth, setMaxWidth] = useState(2048);
  const [error, setError] = useState<string | null>(null);

  const kits = useQuery({ queryKey: ["kits"], queryFn: fetchKits });

  const create = useMutation({
    mutationFn: () => createKit({ name: name.trim(), padding, max_width: maxWidth }),
    onSuccess: (kit: KitRead) => {
      setCreating(false);
      setName("");
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["kits"] });
      router.push(`/tools/kit/${kit.id}`);
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : "新建失败"),
  });

  const remove = useMutation({
    mutationFn: (kitId: number) => deleteKit(kitId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["kits"] }),
  });

  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <header className="flex items-center gap-3 border-b border-edge/70 px-5 py-3">
        <Link href="/tools" className="text-xs text-muted hover:text-ink">
          ← 工具
        </Link>
        <h1 className="text-sm font-medium">图集</h1>
        <span className="text-xs text-muted">
          把透明的模块图装成一张 atlas，导出 atlas.png + kit.json
        </span>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="btn-primary ml-auto px-3 py-1.5 text-xs"
        >
          + 新建图集
        </button>
      </header>

      <div className="px-5 py-5">
        {kits.data && kits.data.items.length === 0 ? (
          <div className="rounded-xl2 border border-dashed border-edge/70 px-6 py-16 text-center">
            <p className="text-sm text-ink">还没有图集</p>
            <p className="mt-1 text-xs text-muted">
              新建一个，把平台、柱子、拱门这些透明图放进去，一键打包。
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {kits.data?.items.map((kit) => (
              <div
                key={kit.id}
                className="group/card rounded-xl2 border border-edge bg-surface p-3 transition hover:border-accent/40"
              >
                <Link href={`/tools/kit/${kit.id}`} className="block">
                  <p className="truncate text-sm text-ink group-hover/card:text-accentSoft">
                    {kit.name}
                  </p>
                  <p className="mt-1 text-xs text-muted">{kit.item_count} 个件</p>
                  {kit.description ? (
                    <p className="mt-1 line-clamp-2 text-xs text-muted/80">{kit.description}</p>
                  ) : null}
                </Link>
                <div className="mt-2 flex items-center gap-2 text-[11px] text-muted">
                  <span>边距 {kit.padding}px</span>
                  <span>宽 {kit.max_width}px</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`删除图集「${kit.name}」？`)) {
                        remove.mutate(kit.id);
                      }
                    }}
                    className="ml-auto hover:text-red-400"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {creating ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl2 border border-edge bg-surface p-4 shadow-pop">
            <h2 className="text-sm font-medium">新建图集</h2>
            <label className="mt-3 block text-xs text-muted">
              名字
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="矿道模块"
                className="mt-1 w-full rounded-lg border border-edge bg-surface2 px-2 py-1.5 text-sm text-ink"
              />
            </label>
            <div className="mt-3 flex gap-2">
              <label className="flex-1 text-xs text-muted">
                件间距
                <input
                  type="number"
                  min={0}
                  max={64}
                  value={padding}
                  onChange={(event) => setPadding(Number(event.target.value))}
                  className="mt-1 w-full rounded-lg border border-edge bg-surface2 px-2 py-1.5 text-sm text-ink"
                />
              </label>
              <label className="flex-1 text-xs text-muted">
                图集宽度
                <input
                  type="number"
                  min={512}
                  max={8192}
                  step={256}
                  value={maxWidth}
                  onChange={(event) => setMaxWidth(Number(event.target.value))}
                  className="mt-1 w-full rounded-lg border border-edge bg-surface2 px-2 py-1.5 text-sm text-ink"
                />
              </label>
            </div>
            {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="rounded-lg border border-edge px-3 py-1.5 text-xs text-muted hover:text-ink"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!name.trim() || create.isPending}
                onClick={() => create.mutate()}
                className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
              >
                {create.isPending ? "创建中…" : "创建"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
