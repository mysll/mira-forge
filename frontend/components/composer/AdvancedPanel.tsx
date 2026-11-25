"use client";

import type { ModelCapabilities } from "@/types/api";
import type { EditAdvanced } from "@/types/composer";

/**
 * 高级设置：Seed / 步数 / CFG / 采样器 / 负面提示词。
 *
 * 字段显隐完全由模型的 capabilities 决定（registry 驱动，别在前端写死）。
 */
export default function AdvancedPanel({
  values,
  onChange,
  onCommit,
  capabilities,
  defaults,
}: {
  values: EditAdvanced;
  onChange: (patch: Partial<EditAdvanced>) => void;
  /** 负面词失焦时把提示词一起交回去保存 */
  onCommit?: () => void;
  capabilities?: ModelCapabilities;
  defaults?: Record<string, unknown>;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 rounded-lg border border-edge/70 bg-surface2/50 p-2.5 sm:grid-cols-2 lg:grid-cols-4">
      <label className="flex flex-col gap-1">
        <span className="label">Seed</span>
        <div className="flex items-center gap-1">
          <div className="flex rounded-md border border-edge bg-surface p-0.5">
            {(
              [
                { key: "random", label: "随机" },
                { key: "fixed", label: "固定" },
              ] as const
            ).map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => {
                  onChange({ seedMode: option.key, seed: option.key === "random" ? "" : values.seed });
                }}
                className={[
                  "rounded px-2 py-0.5 text-[11px] transition",
                  values.seedMode === option.key
                    ? "bg-accent/20 text-accentSoft"
                    : "text-muted hover:text-ink",
                ].join(" ")}
              >
                {option.label}
              </button>
            ))}
          </div>
          <input
            value={values.seed}
            onChange={(event) => onChange({ seed: event.target.value.replace(/[^\d]/g, ""), seedMode: "fixed" })}
            placeholder="固定 seed"
            inputMode="numeric"
            className="field h-7 flex-1 px-2 py-0 text-[11px]"
            disabled={values.seedMode !== "fixed"}
          />
        </div>
      </label>

      {capabilities?.exposes_steps ? (
        <label className="flex flex-col gap-1">
          <span className="label">步数</span>
          <input
            value={values.steps}
            onChange={(event) => onChange({ steps: event.target.value.replace(/[^\d]/g, "") })}
            placeholder={String(defaults?.steps ?? 25)}
            inputMode="numeric"
            className="field h-7 px-2 py-0 text-[11px]"
          />
        </label>
      ) : null}

      {capabilities?.exposes_cfg ? (
        <label className="flex flex-col gap-1">
          <span className="label">CFG</span>
          <input
            value={values.cfg}
            onChange={(event) => onChange({ cfg: event.target.value.replace(/[^\d.]/g, "") })}
            placeholder={String(defaults?.cfg ?? 1)}
            inputMode="decimal"
            className="field h-7 px-2 py-0 text-[11px]"
          />
        </label>
      ) : null}

      {capabilities?.exposes_sampler ? (
        <label className="flex flex-col gap-1">
          <span className="label">采样器</span>
          <select
            value={values.sampler}
            onChange={(event) => onChange({ sampler: event.target.value })}
            className="field h-7 px-2 py-0 text-[11px]"
          >
            <option value="">默认（{String(defaults?.sampler ?? "euler")}）</option>
            {(capabilities.sampler_options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {capabilities?.exposes_negative_prompt ? (
        <label className="col-span-1 flex flex-col gap-1 sm:col-span-2 lg:col-span-4">
          <span className="label">负面提示词</span>
          <input
            value={values.negative}
            onChange={(event) => onChange({ negative: event.target.value })}
            onBlur={() => onCommit?.()}
            placeholder="不希望出现的元素，例如 悬空、棋盘格、白底、缺角"
            className="field h-7 px-2 py-0 text-[11px]"
          />
        </label>
      ) : null}
    </div>
  );
}
