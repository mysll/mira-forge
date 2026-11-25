"use client";

import { useEffect, useState } from "react";

import ComposerCard from "@/components/composer/ComposerCard";
import ComposerHeader from "@/components/composer/ComposerHeader";
import MaskTile from "@/components/composer/MaskTile";
import PinnedReference from "@/components/composer/PinnedReference";
import PromptField from "@/components/composer/PromptField";
import AdvancedPanel from "@/components/composer/AdvancedPanel";
import ParamBar from "@/components/composer/ParamBar";
import SubmitButton from "@/components/composer/SubmitButton";
import type { ModelCapabilities, ModelInfo } from "@/types/api";
import type { EditAdvanced, MaskAction } from "@/types/composer";

export type { EditAdvanced, MaskAction } from "@/types/composer";
export { DEFAULT_EDIT_ADVANCED } from "@/types/composer";

export type EditComposerProps = {
  /** 标题行左侧徽标："L1"（层）或 "地形"（元素） */
  badge: string;
  badgeMono?: boolean;
  title: string;
  subtitle?: string;
  /** 固定参考图：分层是源场景图，元素是场景底图 */
  reference?: { url?: string | null; label?: string; caption?: string; title?: string };
  onPreviewReference?: () => void;
  /** 遮罩入口挂在参考图下面；has 为真时旁边显示遮罩缩略块 */
  mask?: MaskAction;
  /** 已画遮罩的缩略图地址（has 为真时显示） */
  maskUrl?: string;
  prompt: string;
  promptPlaceholder?: string;
  promptMaxLength?: number;
  onPromptChange: (value: string) => void;
  /** 提示词 / 负面词失焦：页面负责落库 */
  onCommit: (values: { prompt: string; negative: string }) => void;
  model?: {
    label: string;
    options?: ModelInfo[];
    value?: string;
    onChange?: (id: string) => void;
  };
  /** 只读尺寸文案，例如 "1536×864" */
  sizeLabel: string;
  count: number;
  countOptions?: number[];
  countUnit?: string;
  onCountChange: (value: number) => void;
  capabilities?: ModelCapabilities;
  defaults?: Record<string, unknown>;
  advanced: EditAdvanced;
  onAdvancedChange: (patch: Partial<EditAdvanced>) => void;
  submit: {
    label: string;
    pending: boolean;
    onClick: () => void;
    disabled?: boolean;
    minWidth?: number;
  };
  /** 上游还在忙（分析中 / 这一件在排队），先不让提交 */
  busy?: boolean;
  /** 参数栏右侧的说明，例如「输出比例跟随源图」 */
  hint?: string;
  /** 变化时强制展开（工作台里点「继续编辑」） */
  expandToken?: number;
  onCollapsedChange?: (collapsed: boolean) => void;
};

const COUNT_OPTIONS = [1, 2, 3, 4];

/**
 * 分层 / 元素共用的图片编辑输入框。
 *
 * 版式与「场景编辑」一致：标题行 → 固定参考图 + 提示词 → 高级设置 → 参数栏 + 提交。
 * 两处差别只有文案和「模型能不能换」，所以不要为了某一页再复制一份。
 */
export default function EditComposer({
  badge,
  badgeMono,
  title,
  subtitle,
  reference,
  onPreviewReference,
  mask,
  maskUrl,
  prompt,
  promptPlaceholder,
  promptMaxLength,
  onPromptChange,
  onCommit,
  model,
  sizeLabel,
  count,
  countOptions = COUNT_OPTIONS,
  countUnit = "张",
  onCountChange,
  capabilities,
  defaults,
  advanced,
  onAdvancedChange,
  submit,
  busy = false,
  hint,
  expandToken,
  onCollapsedChange,
}: EditComposerProps) {
  // 悬浮在信息流上，默认收起只留一行
  const [collapsed, setCollapsed] = useState(true);
  // 和场景编辑一致：高级默认收起
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    if (expandToken) {
      setCollapsed(false);
    }
  }, [expandToken]);

  useEffect(() => {
    onCollapsedChange?.(collapsed);
  }, [collapsed, onCollapsedChange]);

  const canSubmit = prompt.trim().length > 0 && !busy && !submit.pending && !submit.disabled;

  const doSubmit = () => {
    if (!canSubmit) {
      return;
    }
    onCommit({ prompt, negative: advanced.negative });
    submit.onClick();
  };

  return (
    <ComposerCard>
      <ComposerHeader
        badge={badge}
        badgeMono={badgeMono}
        title={title}
        subtitle={subtitle}
        modelLabel={model?.label}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((value) => !value)}
      />

      {collapsed ? (
        <div className="flex items-center gap-2">
          <span
            className={[
              "truncate text-[11px]",
              prompt.trim() ? "text-muted/70" : "text-muted/40",
            ].join(" ")}
            title={prompt.trim() || undefined}
          >
            {prompt.trim() || "还没写提示词"}
          </span>
          <span className="ml-auto shrink-0 text-[11px] text-muted/50">
            {count} {countUnit} · {sizeLabel}
          </span>
          <SubmitButton
            label={submit.label}
            pending={submit.pending}
            disabled={!canSubmit}
            onClick={doSubmit}
            minWidth={96}
            className="shrink-0"
          />
        </div>
      ) : (
        <>
          <div className="flex items-start gap-2">
            <div className="flex shrink-0 items-start gap-1.5">
              <PinnedReference
                url={reference?.url}
                label={reference?.label ?? "参考"}
                caption={reference?.caption}
                title={reference?.title}
                onPreview={onPreviewReference}
                action={
                  mask && !mask.has ? (
                    <button
                      type="button"
                      onClick={mask.onEdit}
                      title={mask.title ?? "画遮罩：只有涂到的地方会被重画"}
                      className="inline-flex items-center gap-0.5 rounded bg-surface2 px-1 py-[1px] text-[9px] leading-none text-accentSoft transition hover:bg-accent/15"
                    >
                      <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" aria-hidden>
                        <path
                          d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20Z"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinejoin="round"
                        />
                      </svg>
                      遮罩
                    </button>
                  ) : undefined
                }
              />
              {mask?.has && maskUrl ? (
                <MaskTile
                  url={maskUrl}
                  title={mask.title}
                  onEdit={mask.onEdit}
                  onClear={mask.onClear}
                />
              ) : null}
            </div>
            <PromptField
              value={prompt}
              onChange={onPromptChange}
              onSubmit={doSubmit}
              onCommit={() => onCommit({ prompt, negative: advanced.negative })}
              placeholder={promptPlaceholder}
              maxLength={promptMaxLength}
              resetKey={`${title}-${collapsed}`}
            />
          </div>

          {advancedOpen ? (
            <AdvancedPanel
              values={advanced}
              onChange={onAdvancedChange}
              onCommit={() => onCommit({ prompt, negative: advanced.negative })}
              capabilities={capabilities}
              defaults={defaults}
            />
          ) : null}

          <ParamBar
            model={model}
            sizeLabel={sizeLabel}
            count={{
              value: count,
              options: countOptions,
              unit: countUnit,
              onChange: onCountChange,
            }}
            advancedOpen={advancedOpen}
            onToggleAdvanced={() => setAdvancedOpen((open) => !open)}
            hint={hint}
            submit={{
              label: submit.label,
              pending: submit.pending,
              disabled: !canSubmit,
              onClick: doSubmit,
              minWidth: submit.minWidth,
            }}
          />
        </>
      )}
    </ComposerCard>
  );
}
