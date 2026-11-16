"use client";

/** 数量选择菜单：一列数字，选中项带底色和勾。
 *
 * 图片创作框（1–8 张）和视频创作框（1–4 条）共用同一个组件，保证两处样式一致；
 * 只画数字、不画「张/条」，单位由外层 pill 与 aria-label 表达。
 */
export default function CountMenu({
  options,
  value,
  onSelect,
  unit,
}: {
  options: number[];
  value: number;
  onSelect: (value: number) => void;
  /** 仅用于无障碍标签，例如「张」「条」 */
  unit: string;
}) {
  return (
    <div className="flex flex-col gap-0.5" role="listbox" aria-label={`数量（${unit}）`}>
      {options.map((option) => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            role="option"
            aria-selected={active}
            aria-label={`${option} ${unit}`}
            onClick={() => onSelect(option)}
            className={[
              "flex h-9 items-center justify-between rounded-lg px-2.5 text-sm tabular-nums transition",
              active ? "bg-white/[0.07] text-ink" : "text-muted hover:bg-white/[0.04] hover:text-ink",
            ].join(" ")}
          >
            <span>{option}</span>
            {active ? (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.4}
                className="h-3.5 w-3.5"
              >
                <path d="m5 13 4 4 10-10" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
