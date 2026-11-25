"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 自定义宽高的两个输入框。
 *
 * 尺寸在 store 里是「对齐到 16 的倍数、长边不超过 2560」的最终值，
 * 所以不能把 input 直接绑到它上面：每敲一个字符就被 snap 回写，用户
 * 根本输不完（输 512 会经历 0 → 1024 → 512）。这里保留原始文本，
 * 失焦或回车时才提交给 store 收敛。
 */
export default function CustomSizeInputs({
  width,
  height,
  onCommit,
}: {
  width: number;
  height: number;
  onCommit: (width: number, height: number) => void;
}) {
  const [draft, setDraft] = useState({ width: String(width), height: String(height) });
  const focused = useRef(false);

  useEffect(() => {
    // 外部改尺寸（切比例、点档位）时同步回来；正在输入时不要抢用户的字符
    if (!focused.current) {
      setDraft({ width: String(width), height: String(height) });
    }
  }, [width, height]);

  const commit = () => {
    const nextWidth = Number(draft.width);
    const nextHeight = Number(draft.height);
    if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight)) {
      setDraft({ width: String(width), height: String(height) });
      return;
    }
    if (nextWidth < 1 || nextHeight < 1) {
      setDraft({ width: String(width), height: String(height) });
      return;
    }
    onCommit(nextWidth, nextHeight);
  };

  const bind = (key: "width" | "height") => ({
    value: draft[key],
    inputMode: "numeric" as const,
    onFocus: () => {
      focused.current = true;
    },
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      setDraft((current) => ({ ...current, [key]: event.target.value.replace(/[^\d]/g, "") }));
    },
    onBlur: () => {
      focused.current = false;
      commit();
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.currentTarget.blur();
      }
    },
    className: "field h-7 flex-1 px-2 py-0 text-[11px]",
  });

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <input {...bind("width")} aria-label="宽度" />
        <span className="text-muted">×</span>
        <input {...bind("height")} aria-label="高度" />
      </div>
      <p className="text-[10px] leading-tight text-muted/70">
        宽高在失焦或回车后对齐到 16 的倍数，长边上限 2560
      </p>
    </div>
  );
}
