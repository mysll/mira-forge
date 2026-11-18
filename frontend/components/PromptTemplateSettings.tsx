"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  createPromptTemplate,
  deletePromptTemplate,
  fetchPromptTemplates,
  resetPromptTemplates,
  updatePromptTemplate,
  type PromptTemplate,
} from "@/lib/api";

/** 设置页里的「视频提示词模板」：视频创作框下面那排动作按钮的数据源。 */
export default function PromptTemplateSettings() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["prompt-templates"],
    queryFn: fetchPromptTemplates,
  });
  const templates = data ?? [];

  const [drafts, setDrafts] = useState<Record<number, { label: string; prompt: string }>>({});
  const [draftLabel, setDraftLabel] = useState("");
  const [draftPrompt, setDraftPrompt] = useState("");
  const [note, setNote] = useState<string | null>(null);

  // 列表刷新后丢掉已不存在的编辑草稿
  useEffect(() => {
    if (!data) {
      return;
    }
    setDrafts((current) => {
      const next: Record<number, { label: string; prompt: string }> = {};
      for (const item of data) {
        if (current[item.id]) {
          next[item.id] = current[item.id];
        }
      }
      return next;
    });
  }, [data]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["prompt-templates"] });
  };

  const save = useMutation({
    mutationFn: (payload: { id: number; label: string; prompt: string }) =>
      updatePromptTemplate(payload.id, { label: payload.label, prompt: payload.prompt }),
    onSuccess: (item) => {
      setNote(`已保存「${item.label}」`);
      setDrafts((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      refresh();
    },
    onError: (issue: Error) => setNote(`保存失败：${issue.message}`),
  });

  const remove = useMutation({
    mutationFn: (id: number) => deletePromptTemplate(id),
    onSuccess: () => {
      setNote("模板已删除");
      refresh();
    },
    onError: (issue: Error) => setNote(`删除失败：${issue.message}`),
  });

  const create = useMutation({
    mutationFn: () => createPromptTemplate({ label: draftLabel, prompt: draftPrompt }),
    onSuccess: (item) => {
      setNote(`已添加「${item.label}」`);
      setDraftLabel("");
      setDraftPrompt("");
      refresh();
    },
    onError: (issue: Error) => setNote(`添加失败：${issue.message}`),
  });

  const reset = useMutation({
    mutationFn: resetPromptTemplates,
    onSuccess: () => {
      setNote("已恢复默认模板");
      setDrafts({});
      refresh();
    },
    onError: (issue: Error) => setNote(`恢复失败：${issue.message}`),
  });

  const valueOf = (item: PromptTemplate) => drafts[item.id] ?? { label: item.label, prompt: item.prompt };

  const change = (item: PromptTemplate, patch: Partial<{ label: string; prompt: string }>) => {
    setDrafts((current) => ({
      ...current,
      [item.id]: { ...valueOf(item), ...patch },
    }));
  };

  return (
    <section className="panel p-4">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm text-ink">视频提示词模板</h2>
        <span className="text-[11px] text-muted">
          视频创作框下面那排按钮 · 一条 = 一个动作
        </span>
      </header>

      {isLoading ? <p className="text-xs text-muted">读取中…</p> : null}
      {error ? <p className="text-xs text-bad">读取失败：{(error as Error).message}</p> : null}

      <ul className="flex flex-col gap-2">
        {templates.map((item) => {
          const value = valueOf(item);
          const dirty = value.label !== item.label || value.prompt !== item.prompt;
          return (
            <li key={item.id} className="rounded-lg border border-edge/60 bg-surface2/40 p-2.5" data-template-row>
              <div className="flex items-center gap-2">
                <input
                  value={value.label}
                  onChange={(event) => change(item, { label: event.target.value })}
                  maxLength={40}
                  aria-label={`模板 ${item.label} 的名字`}
                  className="h-7 w-28 rounded border border-edge bg-surface px-2 text-xs text-ink outline-none focus:border-accent/50"
                />
                <span className="text-[10px] text-muted/60">#{item.id}</span>
                <div className="ml-auto flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => save.mutate({ id: item.id, ...value })}
                    disabled={!dirty || save.isPending}
                    className="rounded border border-edge bg-surface px-2 py-1 text-[11px] text-ink transition hover:border-accent/50 hover:text-accentSoft disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`删除模板「${item.label}」？视频创作框里这个按钮会一起消失。`)) {
                        remove.mutate(item.id);
                      }
                    }}
                    disabled={remove.isPending}
                    className="rounded border border-edge bg-surface px-2 py-1 text-[11px] text-muted transition hover:border-bad/50 hover:text-bad disabled:opacity-40"
                  >
                    删除
                  </button>
                </div>
              </div>
              <textarea
                value={value.prompt}
                onChange={(event) => change(item, { prompt: event.target.value })}
                rows={2}
                aria-label={`模板 ${item.label} 的提示词`}
                className="mt-1.5 w-full resize-y rounded border border-edge bg-surface px-2 py-1.5 text-[11px] leading-relaxed text-ink/85 outline-none focus:border-accent/50"
              />
            </li>
          );
        })}
      </ul>

      {templates.length === 0 && !isLoading ? (
        <p className="mb-2 text-[11px] text-muted">
          没有模板了。可以在下面加一条，或者点「恢复默认」把自带的动作按钮找回来。
        </p>
      ) : null}

      <div className="mt-3 rounded-lg border border-dashed border-edge/70 p-2.5">
        <div className="flex items-center gap-2">
          <input
            value={draftLabel}
            onChange={(event) => setDraftLabel(event.target.value)}
            maxLength={40}
            placeholder="名字（例如 施法）"
            aria-label="新模板的名字"
            className="h-7 w-32 rounded border border-edge bg-surface px-2 text-xs text-ink outline-none placeholder:text-muted/50 focus:border-accent/50"
          />
          <button
            type="button"
            onClick={() => create.mutate()}
            disabled={!draftLabel.trim() || !draftPrompt.trim() || create.isPending}
            className="rounded border border-edge bg-surface px-2.5 py-1 text-[11px] text-ink transition hover:border-accent/50 hover:text-accentSoft disabled:cursor-not-allowed disabled:opacity-40"
          >
            添加模板
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm("恢复默认模板？现在这些模板会被清掉，换成自带的 9 个动作。")) {
                reset.mutate();
              }
            }}
            disabled={reset.isPending}
            className="ml-auto rounded border border-edge bg-surface px-2.5 py-1 text-[11px] text-muted transition hover:border-accent/50 hover:text-ink disabled:opacity-40"
          >
            恢复默认
          </button>
        </div>
        <textarea
          value={draftPrompt}
          onChange={(event) => setDraftPrompt(event.target.value)}
          rows={2}
          placeholder="提示词：动作 + 侧视朝右 / 定点 / 镜头不动这几条约束"
          aria-label="新模板的提示词"
          className="mt-1.5 w-full resize-y rounded border border-edge bg-surface px-2 py-1.5 text-[11px] leading-relaxed text-ink/85 outline-none placeholder:text-muted/40 focus:border-accent/50"
        />
      </div>

      {note ? <p className="mt-2 text-[11px] text-muted">{note}</p> : null}
    </section>
  );
}
