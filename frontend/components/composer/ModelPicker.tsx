"use client";

import Popover from "@/components/Popover";
import type { ModelInfo } from "@/types/api";

/**
 * 参数栏里的模型选择。
 *
 * 同一个组件两种形态：能换模型的页面传 options + onChange；不能换的（元素提取
 * 固定用提取模型）只传 label，渲染成一个不可点的 pill。
 */
export default function ModelPicker({
  label,
  options,
  value,
  onChange,
  title = "选择模型",
}: {
  label: string;
  options?: ModelInfo[];
  value?: string;
  onChange?: (id: string) => void;
  title?: string;
}) {
  if (!options || options.length === 0 || !onChange) {
    return (
      <span className="pill cursor-default" title={title}>
        {label}
      </span>
    );
  }

  const active = options.find((model) => model.id === value) ?? null;

  return (
    <Popover label={<span>{active?.label ?? label}</span>} title={title} width={250} active={Boolean(value)}>
      {(close) => (
        <div className="flex flex-col">
          {options.map((model) => (
            <button
              key={model.id}
              type="button"
              onClick={() => {
                onChange(model.id);
                close();
              }}
              className={[
                "flex flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left transition",
                active?.id === model.id ? "bg-accent/12" : "hover:bg-surface2",
              ].join(" ")}
            >
              <span className="text-xs text-ink">{model.label}</span>
              <span className="text-[10px] text-muted">{model.description || model.id}</span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}
