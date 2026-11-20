"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import ToastStack, { type ToastItem } from "@/components/ToastStack";
import { createScene, fetchScenes, imageThumbnailUrl } from "@/lib/api";
import type { SceneRead } from "@/types/api";

export default function ScenesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = (text: string) => {
    setToasts((current) => [...current, { id: Date.now() + Math.random(), text }]);
  };

  const scenesQuery = useQuery({ queryKey: ["scenes"], queryFn: fetchScenes });
  const scenes: SceneRead[] = scenesQuery.data?.items ?? [];

  const create = useMutation({
    mutationFn: createScene,
    onSuccess: (scene) => {
      void queryClient.invalidateQueries({ queryKey: ["scenes"] });
      setCreating(false);
      toast(`场景「${scene.name}」已创建`);
      router.push(`/scenes/${scene.id}`);
    },
    onError: (error: Error) => toast(error.message),
  });

  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <header className="flex items-center gap-3 border-b border-edge/70 px-5 py-2.5">
        <h1 className="shrink-0 whitespace-nowrap text-[13px] font-medium text-ink">场景</h1>
        <span className="truncate text-[11px] text-muted/70">
          一个场景一个图集，单独生成、单独分层
        </span>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="ml-auto h-8 shrink-0 rounded-lg bg-accent px-3 text-xs font-medium text-white transition hover:bg-accent/90"
        >
          + 新建场景
        </button>
      </header>

      {scenesQuery.isLoading ? (
        <p className="px-6 py-10 text-xs text-muted">正在读取场景…</p>
      ) : scenes.length === 0 ? (
        <section className="px-6 pt-14 text-center">
          <SceneGlyph className="mx-auto h-16 w-16 text-accentSoft/60" />
          <h2 className="mt-4 text-[15px] font-medium text-ink">还没有场景</h2>
          <p className="mx-auto mt-2 max-w-md text-[12px] leading-relaxed text-muted">
            一个场景就是一个地点或一段剧情的图集：生成满意的场景图后，再把它拆成一层一层，
            用来做视差背景。
          </p>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="mt-5 h-9 rounded-lg bg-accent px-4 text-xs font-medium text-white transition hover:bg-accent/90"
          >
            新建第一个场景
          </button>
        </section>
      ) : (
        <section className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-3.5 px-6 py-6">
          {scenes.map((scene) => (
            <SceneCard key={scene.id} scene={scene} />
          ))}
        </section>
      )}

      {creating ? (
        <NewSceneDialog
          busy={create.isPending}
          onCancel={() => setCreating(false)}
          onSubmit={(values) => create.mutate(values)}
        />
      ) : null}

      <ToastStack
        items={toasts}
        onDismiss={(id) => setToasts((current) => current.filter((item) => item.id !== id))}
      />
    </div>
  );
}

function SceneCard({ scene }: { scene: SceneRead }) {
  return (
    <Link
      href={`/scenes/${scene.id}`}
      className="group flex h-full flex-col overflow-hidden rounded-xl2 border border-edge bg-surface transition hover:border-accent/50"
    >
      <div className="relative flex h-[124px] items-center justify-center overflow-hidden border-b border-edge/60 bg-[radial-gradient(circle_at_30%_20%,#241f3a,transparent_60%),radial-gradient(circle_at_75%_80%,#1b2a2f,transparent_55%)]">
        {scene.cover_image_id ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageThumbnailUrl({
              id: scene.cover_image_id,
              created_at: scene.cover_image_created_at ?? undefined,
            })}
            alt=""
            className="h-full w-full object-cover opacity-90 transition group-hover:opacity-100"
          />
        ) : (
          <div className="flex flex-col items-center gap-1.5 text-muted/70">
            <SceneGlyph className="h-10 w-10 text-accentSoft/60" />
            <span className="text-[10.5px]">还没有场景图</span>
          </div>
        )}
        <span className="absolute right-2 top-2 rounded-full bg-black/45 px-2 py-0.5 text-[10px] text-ink/90">
          {scene.generation_count} 批 · {scene.image_count} 图
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1.5 px-3.5 pb-3.5 pt-3">
        <h3 className="truncate text-[13px] font-medium text-ink">{scene.name}</h3>
        <p className="line-clamp-2 min-h-[32px] text-[11.5px] leading-relaxed text-muted">
          {scene.description || "还没有场景说明"}
        </p>
        <span className="mt-auto pt-2 text-[11.5px] text-accentSoft group-hover:underline">
          进入场景 →
        </span>
      </div>
    </Link>
  );
}

function NewSceneDialog({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: { name: string; description: string | null }) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const canSubmit = name.trim().length > 0 && !busy;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-[460px] rounded-xl2 border border-edge bg-surface p-5 shadow-pop">
        <h2 className="text-sm font-medium text-ink">新建场景</h2>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
          建好之后，先在这里生成满意的场景图，再把它拆成一层一层。
        </p>

        <label className="mt-4 block text-[11.5px] text-muted">
          场景名
          <input
            autoFocus
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：入口遗迹 / 神像殿"
            className="mt-1 h-9 w-full rounded-lg border border-edge bg-surface2 px-2.5 text-xs text-ink outline-none focus:border-accent/60"
          />
        </label>

        <label className="mt-3 block text-[11.5px] text-muted">
          场景说明（可选）
          <textarea
            value={description}
            rows={3}
            maxLength={4000}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="这个场景是什么地方、什么光线、要出现哪些元素"
            className="mt-1 w-full resize-none rounded-lg border border-edge bg-surface2 px-2.5 py-2 text-xs leading-relaxed text-ink outline-none focus:border-accent/60"
          />
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-9 rounded-lg border border-edge bg-surface2 px-3 text-xs text-ink/90 transition hover:border-accent/40 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => onSubmit({ name: name.trim(), description: description.trim() || null })}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-white transition hover:bg-accent/90 disabled:opacity-50"
          >
            {busy ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border border-white/40 border-t-white" />
            ) : null}
            创建场景
          </button>
        </div>
      </div>
    </div>
  );
}

function SceneGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} fill="none" aria-hidden>
      <rect x="8" y="20" width="20" height="24" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="32" y="26" width="24" height="18" rx="2" stroke="currentColor" strokeWidth="1.6" opacity="0.7" />
      <path d="M12 44h44" stroke="currentColor" strokeWidth="1.2" opacity="0.4" />
      <circle cx="45" cy="16" r="5" stroke="currentColor" strokeWidth="1.4" opacity="0.6" />
    </svg>
  );
}
