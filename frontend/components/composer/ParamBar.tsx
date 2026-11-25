"use client";

import type { ReactNode } from "react";

import CountPicker from "@/components/composer/CountPicker";
import ModelPicker from "@/components/composer/ModelPicker";
import SubmitButton from "@/components/composer/SubmitButton";
import type { ModelInfo } from "@/types/api";

/**
 * 参数栏：模型 / 尺寸 / 数量 / 高级 / 提示 / 提交。
 *
 * 尺寸在这里是只读 pill —— 分层和元素都锁定源图尺寸，不能改。
 */
export default function ParamBar({
  model,
  sizeLabel,
  sizeTitle = "尺寸跟随原图，不能改",
  count,
  advancedOpen,
  onToggleAdvanced,
  hint,
  submit,
}: {
  model?: {
    label: string;
    options?: ModelInfo[];
    value?: string;
    onChange?: (id: string) => void;
  };
  sizeLabel: string;
  sizeTitle?: string;
  count: {
    value: number;
    options: number[];
    unit: string;
    onChange: (value: number) => void;
    title?: string;
  };
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  hint?: ReactNode;
  submit: {
    label: string;
    pending: boolean;
    disabled: boolean;
    onClick: () => void;
    minWidth?: number;
  };
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {model ? (
        <ModelPicker
          label={model.label}
          options={model.options}
          value={model.value}
          onChange={model.onChange}
        />
      ) : null}

      <span className="pill cursor-default" title={sizeTitle}>
        {sizeLabel}
      </span>

      <CountPicker
        value={count.value}
        options={count.options}
        unit={count.unit}
        onChange={count.onChange}
        title={count.title}
      />

      <button
        type="button"
        onClick={onToggleAdvanced}
        className={["pill", advancedOpen ? "border-accent/50 bg-accent/12 text-accentSoft" : ""].join(" ")}
        title="高级设置"
        aria-expanded={advancedOpen}
      >
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" aria-hidden>
          <path d="M5 7h14M8 12h8M11 17h2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        高级
      </button>

      <span className="ml-auto text-[11px] text-muted/60">{hint}</span>

      <SubmitButton
        label={submit.label}
        pending={submit.pending}
        disabled={submit.disabled}
        onClick={submit.onClick}
        minWidth={submit.minWidth ?? 124}
      />
    </div>
  );
}
