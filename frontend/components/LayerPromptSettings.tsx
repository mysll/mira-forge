"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { fetchLayerPrompt, resetLayerPrompt, saveLayerPrompt } from "@/lib/api";

/**
 * 设置页里的「分层提示词」卡：发给 LLM 的系统提示词。
 *
 * 它和「视频提示词模板」不是一类东西——模板可以有很多条、能删；
 * 这条只有一份，分层分析永远用它，所以放这里单独编辑，不进模板列表。
 */
export default function LayerPromptSettings() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["layer-prompt"], queryFn: fetchLayerPrompt });

  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [noteTone, setNoteTone] = useState<"ok" | "bad" | "muted">("muted");

  const data = query.data;

  // 只有「用户没改过」时才把服务端的值灌进输入框：保存后的重新拉取
  // （以及别处的失效）不能把正在输入的内容盖掉。
  const savedRef = useRef("");
  useEffect(() => {
    if (!data) return;
    setDraft((current) => (current === savedRef.current ? data.prompt : current));
    savedRef.current = data.prompt;
  }, [data]);

  const dirty = Boolean(data) && draft !== data!.prompt;
  const missingRule = draft.length > 0 && !draft.includes("{layer_rule}");
  const tooLong = draft.length > (data?.max_length ?? 20000);

  const save = useMutation({
    mutationFn: () => saveLayerPrompt(draft),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["layer-prompt"] });
      setNoteTone("ok");
      setNote(`已保存（${saved.prompt.length} 字），下次「分析分层」立刻用它`);
    },
    onError: (error: Error) => {
      setNoteTone("bad");
      setNote(error.message);
    },
  });

  const reset = useMutation({
    mutationFn: resetLayerPrompt,
    onSuccess: (saved) => {
      savedRef.current = saved.prompt;
      setDraft(saved.prompt);
      void queryClient.invalidateQueries({ queryKey: ["layer-prompt"] });
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
        <h2 className="text-sm text-ink">分层提示词</h2>
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
        每次分层发给模型的规则：怎么分层、每层怎么写提示词都在这里。改完保存，下一次分层就用新版。
      </p>

      <textarea
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setNote(null);
        }}
        spellCheck={false}
        rows={16}
        className="scroll-thin w-full resize-y rounded-lg border border-edge bg-surface2 p-2.5 font-mono text-[11.5px] leading-relaxed text-ink outline-none focus:border-accent/60"
      />

      <div className="mt-2 flex flex-wrap items-center gap-3 text-[10.5px] text-muted/70">
        <span>
          {draft.length} / {data?.max_length ?? 20000} 字
        </span>
        {missingRule ? (
          <span className="text-warn">
            缺少 {"{layer_rule}"} 占位符：层数规则会替换到那里，保存会失败
          </span>
        ) : null}
        {tooLong ? <span className="text-bad">太长了，保存不了</span> : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-edge/50 pt-3">
        <button
          type="button"
          onClick={() => {
            setNote(null);
            save.mutate();
          }}
          disabled={save.isPending || !dirty || missingRule || tooLong}
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
