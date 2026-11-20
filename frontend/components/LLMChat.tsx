"use client";

import type { LLMExchangeEntry } from "@/types/api";

type Props = {
  exchange: LLMExchangeEntry[];
  /** 还在等回包：最后一轮没有应答时显示「等待应答…」 */
  waiting?: boolean;
  model?: string;
  /** 外面已经有标题了（比如页签上的折叠条），就不再重复一层 */
  compact?: boolean;
};

function duration(ms: number | null | undefined): string {
  if (!ms) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** 应答大多是 JSON：能解析就缩进一下，读起来比一整段强；解析不了原样返回。 */
function prettyJson(text: string): string {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

/**
 * 分层分析时的「与模型的对话」：系统提示词 + 这次的要求 + 原始应答。
 *
 * 只读展示，每轮一张卡；系统提示词默认折叠（它很长，而且设置页里能改）。
 */
export default function LLMChat({ exchange, waiting = false, model, compact = false }: Props) {
  if (!exchange.length) {
    return (
      <div className="mx-auto w-full max-w-3xl rounded-xl2 border border-edge/60 bg-surface2/40 px-4 py-3 text-[11.5px] text-muted">
        <div className="mb-1 flex items-center gap-2 text-ink/80">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accentSoft" />
          与模型的对话
        </div>
        已发出，正在等模型回答…
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      {compact ? null : (
        <div className="mb-2 flex items-center justify-between text-[11px] text-muted">
          <span className="text-ink/80">与模型的对话</span>
          <span>
            {model ? `${model} · ` : ""}
            {exchange.length} 轮
          </span>
        </div>
      )}

      <div className="flex flex-col gap-2.5">
        {exchange.map((entry, index) => {
          const pending = waiting && !entry.response && !entry.error;
          return (
            <article
              key={`${entry.attempt}-${index}`}
              className="overflow-hidden rounded-xl2 border border-edge/60 bg-surface2/40"
            >
              <header className="flex items-center justify-between gap-2 border-b border-edge/40 px-3 py-1.5">
                <span className="flex items-center gap-2 text-[11px] text-ink/80">
                  第 {entry.attempt} 轮
                  {entry.error ? (
                    <span className="rounded bg-bad/15 px-1.5 py-0.5 text-[10px] text-bad">有问题</span>
                  ) : pending ? (
                    <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accentSoft">
                      等待应答
                    </span>
                  ) : (
                    <span className="rounded bg-ok/15 px-1.5 py-0.5 text-[10px] text-ok">已应答</span>
                  )}
                </span>
                <span className="font-mono text-[10px] text-muted/70">{duration(entry.duration_ms)}</span>
              </header>

              <div className="flex flex-col gap-2 px-3 py-2.5">
                <details className="group">
                  <summary className="cursor-pointer list-none text-[11px] text-muted transition hover:text-ink/80">
                    <span className="mr-1 inline-block transition group-open:rotate-90">▸</span>
                    分层规则 · {entry.system.length} 字
                  </summary>
                  <pre className="scroll-thin mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface/70 p-2.5 font-mono text-[10.5px] leading-relaxed text-muted/85">
                    {entry.system}
                  </pre>
                </details>

                <div>
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
                    这次的要求
                    {entry.has_image ? (
                      <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-muted/80">
                        已附场景图
                      </span>
                    ) : null}
                  </div>
                  <pre className="scroll-thin max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface/70 p-2.5 font-mono text-[10.5px] leading-relaxed text-ink/80">
                    {entry.user}
                  </pre>
                </div>

                <div>
                  <div className="mb-1 text-[11px] text-muted">模型的回答</div>
                  {entry.response ? (
                    <pre className="scroll-thin max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-surface/70 p-2.5 font-mono text-[10.5px] leading-relaxed text-ink/75">
                      {prettyJson(entry.response)}
                    </pre>
                  ) : pending ? (
                    <p className="text-[11px] text-muted/70">等待应答…</p>
                  ) : (
                    <p className="text-[11px] text-muted/70">这一轮没有返回内容。</p>
                  )}
                  {entry.error ? (
                    <p className="mt-1.5 rounded-lg bg-bad/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-bad">
                      {entry.error}
                    </p>
                  ) : null}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
