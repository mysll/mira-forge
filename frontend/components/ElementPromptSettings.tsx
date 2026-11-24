"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { fetchElementPrompt, resetElementPrompt, saveElementPrompt } from "@/lib/api";

/**
 * 设置页里的「元素提取提示词」卡：把一张场景图拆成可复用件时发给模型的规则。
 *
 * 这份规则同时决定模型怎么给每件写绘图提示词（提取对象 / 完整结构 / 完整性重建 /
 * 风格一致 / 独立物件 / 透明背景 六段）。和「分层提示词」是两份独立的文本，
 * 各自有默认值，改一个不影响另一个。
 */
export default function ElementPromptSettings() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["element-prompt"], queryFn: fetchElementPrompt });

  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [noteTone, setNoteTone] = useState<"ok" | "bad" | "muted">("muted");

  const data = query.data;

  useEffect(() => {
    if (data) setDraft(data.prompt);
  }, [data]);

  const dirty = Boolean(data) && draft !== data!.prompt;
  const empty = draft.trim().length === 0;
  const tooLong = draft.length > (data?.max_length ?? 20000);

  const save = useMutation({
    mutationFn: () => saveElementPrompt(draft),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["element-prompt"] });
      setNoteTone("ok");
      setNote(`已保存（${saved.prompt.length} 字），下次「提取元素」立刻用它`);
    },
    onError: (error: Error) => {
      setNoteTone("bad");
      setNote(error.message);
    },
  });

  const reset = useMutation({
    mutationFn: resetElementPrompt,
    onSuccess: (saved) => {
      setDraft(saved.prompt);
      void queryClient.invalidateQueries({ queryKey: ["element-prompt"] });
      setNoteTone("muted");
      setNote("已恢复默认提示词");
    },
    onError: (error: Error) => {
      setNoteTone("bad");
      setNote(error.message);
    },
  });

  return (
    <section className="panel p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm text-ink">元素提取提示词</h2>
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          <span
            className={[
              "inline-block h-1.5 w-1.5 rounded-full",
              data?.is_default ? "bg-muted" : "bg-ok",
            ].join(" ")}
          />
          {data?.is_default ? "默认" : "已自定义"}
        </span>
      </header>

      <p className="mb-3 text-[11.5px] leading-relaxed text-muted">
        提取时发给模型的规则：拆什么、怎么框、框多大。改完保存，下一次提取就用新版。
      </p>

      <textarea
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setNote(null);
        }}
        spellCheck={false}
        rows={12}
        className="scroll-thin w-full resize-y rounded-lg border border-edge bg-surface2 p-2.5 font-mono text-[11.5px] leading-relaxed text-ink outline-none focus:border-accent/60"
      />

      <div className="mt-2 flex flex-wrap items-center gap-3 text-[10.5px] text-muted/70">
        <span>
          {draft.length} / {data?.max_length ?? 20000} 字
        </span>
        {empty ? <span className="text-bad">不能是空的</span> : null}
        {tooLong ? <span className="text-bad">太长了，保存不了</span> : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-edge/50 pt-3">
        <button
          type="button"
          onClick={() => {
            setNote(null);
            save.mutate();
          }}
          disabled={save.isPending || !dirty || empty || tooLong}
          className="h-8 rounded-lg bg-accent px-3 text-[11.5px] font-medium text-white transition hover:bg-accent/90 disabled:opacity-50"
        >
          {save.isPending ? "保存中…" : "保存"}
        </button>
        <button
          type="button"
          onClick={() => {
            setNote(null);
            reset.mutate();
          }}
          disabled={reset.isPending || Boolean(data?.is_default)}
          className="h-8 rounded-lg border border-edge bg-surface2 px-3 text-[11.5px] text-ink transition hover:border-accent/50 hover:text-accentSoft disabled:opacity-50"
        >
          恢复默认
        </button>
        {dirty ? (
          <button
            type="button"
            onClick={() => setDraft(data?.prompt ?? "")}
            className="h-8 rounded-lg px-2 text-[11px] text-muted transition hover:text-ink"
          >
            撤销改动
          </button>
        ) : null}
      </div>

      {note ? (
        <p
          className={[
            "mt-2 px-0.5 text-[11px]",
            noteTone === "bad" ? "text-bad" : noteTone === "ok" ? "text-ok" : "text-muted",
          ].join(" ")}
        >
          {note}
        </p>
      ) : null}
    </section>
  );
}
