"use client";

import { useEffect } from "react";

import { imageFileUrl, referenceImageUrl } from "@/lib/api";
import { formatBytes, formatTime } from "@/lib/date";
import type { FeedItem } from "@/types/api";

type Props = {
  item: FeedItem;
  onClose: () => void;
  onFavorite: (item: FeedItem) => void;
  onDownload: (item: FeedItem) => void;
  onDelete: (item: FeedItem) => void;
  onEdit: (item: FeedItem) => void;
  onRegenerate: (item: FeedItem) => void;
  onToast: (message: string) => void;
  modelLabels?: Record<string, string>;
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5 text-xs">
      <span className="w-16 shrink-0 text-muted">{label}</span>
      <span className="min-w-0 flex-1 break-words text-ink/90">{value}</span>
    </div>
  );
}

export default function ImageDetail({
  item,
  onClose,
  onFavorite,
  onDownload,
  onDelete,
  onEdit,
  onRegenerate,
  onToast,
  modelLabels,
}: Props) {
  const { image, generation, seed } = item;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast(`${label}已复制`);
    } catch {
      onToast("复制失败，请手动选择文本");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[86vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-edge bg-surface shadow-pop"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex min-w-0 flex-1 items-center justify-center bg-black/40 p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageFileUrl(image)}
            alt={generation.prompt}
            className="max-h-[80vh] w-auto max-w-full rounded-lg object-contain"
          />
        </div>

        <div className="flex w-[330px] shrink-0 flex-col border-l border-edge">
          <div className="flex items-start justify-between gap-2 px-4 pb-2 pt-4">
            <div>
              <p className="text-[11px] text-muted">批次 #{generation.id}</p>
              <p className="text-sm font-medium text-ink">图片详情</p>
            </div>
            <button type="button" onClick={onClose} className="icon-btn" title="关闭">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
                <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 pb-3">
            <div className="rounded-xl border border-edge/70 bg-surface2/60 p-2.5">
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink/90">{generation.prompt}</p>
              <button
                type="button"
                onClick={() => copy(generation.prompt, "提示词")}
                className="mt-2 text-[11px] text-accentSoft hover:underline"
              >
                复制提示词
              </button>
            </div>

            {generation.negative_prompt ? (
              <div className="mt-2 rounded-xl border border-edge/70 bg-surface2/60 p-2.5">
                <p className="label mb-1">负面提示词</p>
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink/80">
                  {generation.negative_prompt}
                </p>
              </div>
            ) : null}

            {generation.reference_images?.length ? (
              <div className="mt-2 rounded-xl border border-edge/70 bg-surface2/60 p-2.5">
                <p className="label mb-1.5">
                  参考图 {generation.reference_images.length} 张
                  <span className="ml-1 font-normal text-muted/60">（只参考构图）</span>
                </p>
                <div className="flex gap-1.5">
                  {generation.reference_images.map((_, index) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={index}
                      src={referenceImageUrl(generation.id, generation.created_at, index)}
                      alt={`参考图 ${index + 1}`}
                      className="h-16 w-16 rounded-lg border border-edge object-cover"
                    />
                  ))}
                </div>
              </div>
            ) : null}

            <div className="mt-3">
              <Row label="模型" value={modelLabels?.[generation.model_name] ?? generation.model_name} />
              <Row
                label="类型"
                value={
                  generation.generation_type === "image_edit"
                    ? "图片编辑"
                    : generation.generation_type === "image_to_image"
                      ? "参考图生成"
                      : "文生图"
                }
              />
              <Row
                label="Seed"
                value={
                  <span className="flex items-center gap-2">
                    <span className="font-mono">{seed ?? "—"}</span>
                    {seed !== null ? (
                      <button
                        type="button"
                        onClick={() => copy(String(seed), "Seed ")}
                        className="text-[11px] text-accentSoft hover:underline"
                      >
                        复制
                      </button>
                    ) : null}
                  </span>
                }
              />
              <Row label="尺寸" value={`${image.width} × ${image.height}`} />
              <Row label="大小" value={formatBytes(image.file_size)} />
              <Row label="生成时间" value={formatTime(image.created_at)} />
              {generation.steps ? <Row label="步数" value={generation.steps} /> : null}
              {generation.cfg !== null ? <Row label="CFG" value={generation.cfg} /> : null}
              {generation.sampler ? <Row label="采样器" value={generation.sampler} /> : null}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 border-t border-edge px-4 py-3">
            <button type="button" onClick={() => onDownload(item)} className="btn-ghost">
              下载
            </button>
            <button type="button" onClick={() => onFavorite(item)} className="btn-ghost">
              {image.is_favorite ? "取消收藏" : "收藏"}
            </button>
            <button type="button" onClick={() => onEdit(item)} className="btn-ghost">
              继续编辑
            </button>
            <button type="button" onClick={() => onRegenerate(item)} className="btn-ghost">
              重新生成
            </button>
            <button
              type="button"
              onClick={() => onDelete(item)}
              className="btn-ghost col-span-2 !text-bad hover:!border-bad/50"
            >
              删除这张图
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
