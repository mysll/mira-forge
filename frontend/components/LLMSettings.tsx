"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { fetchLLMSettings, saveLLMSettings, testLLMSettings } from "@/lib/api";

/**
 * 设置页里的 LLM 配置卡：分层分析用它读场景图、写每层提示词。
 * 密钥只存在后端（data/llm_config.json），这里只显示掩码；输入框留空 = 不改。
 */
export default function LLMSettings() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["llm-settings"], queryFn: fetchLLMSettings });

  const [enabled, setEnabled] = useState(true);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(120);
  const [note, setNote] = useState<string | null>(null);
  const [noteTone, setNoteTone] = useState<"ok" | "bad" | "muted">("muted");

  const data = settings.data;

  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled);
    setBaseUrl(data.base_url);
    setModel(data.model);
    setTimeoutSeconds(data.timeout_seconds);
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      saveLLMSettings({
        enabled,
        base_url: baseUrl,
        model,
        api_key: apiKey.trim() ? apiKey.trim() : undefined,
        timeout_seconds: timeoutSeconds,
      }),
    onSuccess: (saved) => {
      setApiKey("");
      void queryClient.invalidateQueries({ queryKey: ["llm-settings"] });
      setNoteTone("ok");
      setNote(
        saved.api_key_set
          ? `已保存：${saved.model} · 密钥 ${saved.api_key_masked}`
          : "已保存（还没有 API Key，部分供应商可免 key）",
      );
    },
    onError: (error: Error) => {
      setNoteTone("bad");
      setNote(error.message);
    },
  });

  const test = useMutation({
    mutationFn: testLLMSettings,
    onSuccess: (result) => {
      setNoteTone(result.ok ? "ok" : "bad");
      setNote(result.ok ? `连接正常 · ${result.detail}` : `连接失败：${result.detail}`);
    },
    onError: (error: Error) => {
      setNoteTone("bad");
      setNote(error.message);
    },
  });

  const clearKey = useMutation({
    mutationFn: () => saveLLMSettings({ clear_api_key: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["llm-settings"] });
      setNoteTone("muted");
      setNote("已清除 API Key");
    },
    onError: (error: Error) => {
      setNoteTone("bad");
      setNote(error.message);
    },
  });

  const configured = Boolean(enabled && baseUrl.trim() && model.trim());
  const dirty =
    Boolean(data) &&
    (enabled !== data!.enabled ||
      baseUrl !== data!.base_url ||
      model !== data!.model ||
      apiKey.trim() !== "" ||
      timeoutSeconds !== data!.timeout_seconds);

  return (
    <section className="panel p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm text-ink">LLM 分层分析</h2>
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          <span
            className={[
              "inline-block h-1.5 w-1.5 rounded-full",
              configured ? "bg-ok" : "bg-warn",
            ].join(" ")}
          />
          {configured ? "已配置" : "未配置"}
        </span>
      </header>

      <p className="mb-3 text-[11.5px] leading-relaxed text-muted">
        分层时由这个模型读场景图，写出每层的七段提示词。任何 OpenAI 兼容的
        <code className="mx-1 rounded bg-surface2 px-1 py-0.5 text-[10.5px]">/chat/completions</code>
        服务都行（通义、DeepSeek、OpenAI 等）。
      </p>

      <div className="flex flex-col gap-2.5">
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          Base URL
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
            className="h-9 rounded-lg border border-edge bg-surface2 px-2.5 text-xs text-ink outline-none focus:border-accent/60"
          />
        </label>

        <div className="grid gap-2.5 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            模型
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="qwen-vl-max"
              className="h-9 rounded-lg border border-edge bg-surface2 px-2.5 text-xs text-ink outline-none focus:border-accent/60"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            超时（秒）
            <input
              type="number"
              min={5}
              max={600}
              value={timeoutSeconds}
              onChange={(event) => setTimeoutSeconds(Number(event.target.value))}
              className="h-9 rounded-lg border border-edge bg-surface2 px-2.5 text-xs text-ink outline-none focus:border-accent/60"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-[11px] text-muted">
          API Key
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={apiKey}
              autoComplete="off"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                data?.api_key_set ? `已保存 ${data.api_key_masked}（留空不改）` : "sk-..."
              }
              className="h-9 min-w-0 flex-1 rounded-lg border border-edge bg-surface2 px-2.5 font-mono text-xs text-ink outline-none focus:border-accent/60"
            />
            {data?.api_key_set ? (
              <button
                type="button"
                onClick={() => clearKey.mutate()}
                disabled={clearKey.isPending}
                className="h-9 shrink-0 rounded-lg border border-edge px-2.5 text-[11px] text-muted transition hover:border-bad/50 hover:text-bad disabled:opacity-50"
              >
                清除
              </button>
            ) : null}
          </div>
          <span className="text-[10.5px] text-muted/70">
            密钥只写在本机 data/llm_config.json，接口只回掩码，不会出现在页面源码里。
          </span>
        </label>

        <label className="mt-0.5 flex items-center gap-2 text-[11.5px] text-ink/85">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--accent,#8b5cf6)]"
          />
          启用（关掉后「分析分层」会提示未配置）
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-edge/50 pt-3">
        <button
          type="button"
          onClick={() => {
            setNote(null);
            save.mutate();
          }}
          disabled={save.isPending || !dirty}
          className="h-8 rounded-lg bg-accent px-3 text-[11.5px] font-medium text-white transition hover:bg-accent/90 disabled:opacity-50"
        >
          {save.isPending ? "保存中…" : "保存"}
        </button>
        <button
          type="button"
          onClick={() => {
            setNote(null);
            test.mutate();
          }}
          disabled={test.isPending || !configured || dirty}
          title={dirty ? "先保存再测" : "用已保存的配置发一句最小请求"}
          className="h-8 rounded-lg border border-edge bg-surface2 px-3 text-[11.5px] text-ink transition hover:border-accent/50 hover:text-accentSoft disabled:opacity-50"
        >
          {test.isPending ? "测试中…" : "测试连接"}
        </button>
        <span className="text-[10.5px] text-muted/70">保存后立刻生效，不用重启后端。</span>
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
