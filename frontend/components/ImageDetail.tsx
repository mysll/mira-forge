"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { imageFileUrl, imageThumbnailUrl, maskImageUrl, referenceImageUrl } from "@/lib/api";
import { formatBytes, formatTime } from "@/lib/date";
import { modelLabel } from "@/lib/models";
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

  // 参考图 / 遮罩点开看大图：详情里的缩略图只有 64px，想确认细节就得放大。
  const [zoom, setZoom] = useState<{ kind: "reference"; index: number } | { kind: "mask" } | null>(
    null,
  );

  const isVideo = image.media_type === "video";
  const isAsset = image.media_type === "asset";
  const isFrameSet = image.media_type === "frameset";
  const isLocalEdit = generation.generation_type === "local_edit";
  // 一张图能做什么，取决于它是谁生的：AI 编辑要重新走 ComfyUI，本地编辑只要浏览器，
  // 素材、帧集与视频则只有下游动作（拿去工坊 / 下载整包）。
  const canAiEdit = !isVideo && !isAsset && !isFrameSet && !isLocalEdit;
  const canLocalEdit = !isVideo && !isAsset && !isFrameSet;
  const canRegenerate = !isAsset && !isFrameSet && !isLocalEdit;
  const studioHref = isAsset
    ? `/tools/spriteforge?asset=${image.id}`
    : isVideo
      ? `/tools/spriteforge?video=${image.id}`
      : null;
  const typeLabel = isAsset
    ? "素材"
    : isFrameSet
      ? "帧集"
      : isVideo
      ? generation.generation_type === "text_to_video"
        ? "文生视频"
        : "图生视频"
      : generation.generation_type === "image_inpaint"
        ? "局部编辑"
        : generation.generation_type === "image_edit"
          ? "图片编辑"
        : generation.generation_type === "image_to_image"
          ? "参考图生成"
          : generation.generation_type === "local_edit"
            ? "本地编辑"
            : "文生图";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      // 大图打开时 Esc 先关大图，再按一次才关详情。
      if (zoom !== null) {
        setZoom(null);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, zoom]);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast(`${label}已复制`);
    } catch {
      onToast("复制失败，请手动选择文本");
    }
  };

  const assetSuffix =
    image.media_type === "asset" || image.media_type === "frameset"
      ? (image.file_path.split(".").pop() ?? "").toLowerCase()
      : "";
  const isRasterAsset = !assetSuffix || /^(png|jpe?g|webp|gif)$/.test(assetSuffix);

  return (
    <>
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
          {image.media_type === "video" ? (
            <video
              src={imageFileUrl(image)}
              poster={imageThumbnailUrl(image)}
              controls
              autoPlay
              loop
              playsInline
              className="max-h-[80vh] w-auto max-w-full rounded-lg bg-black"
            />
          ) : (image.media_type === "asset" || image.media_type === "frameset") && !isRasterAsset ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="rounded-lg border border-edge bg-surface px-3 py-2 text-xs uppercase tracking-wide text-muted">
                {assetSuffix || "file"}
              </span>
              <p className="max-w-xs text-xs leading-relaxed text-muted">
                素材文件没法在浏览器里预览，下载后到序列帧工坊或游戏引擎里使用。
              </p>
              <button type="button" onClick={() => onDownload(item)} className="btn-primary">
                下载{assetSuffix ? ` .${assetSuffix}` : "文件"}
              </button>
            </div>
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={imageFileUrl(image)}
              alt={generation.prompt}
              className="max-h-[80vh] w-auto max-w-full rounded-lg object-contain"
            />
          )}
        </div>

        <div className="flex w-[330px] shrink-0 flex-col border-l border-edge">
          <div className="flex items-start justify-between gap-2 px-4 pb-2 pt-4">
            <div>
              <p className="text-[11px] text-muted">批次 #{generation.id}</p>
              <p className="text-sm font-medium text-ink">{image.media_type === "video"
                ? "视频详情"
                : image.media_type === "asset"
                  ? "素材详情"
                  : image.media_type === "frameset"
                    ? "帧集详情"
                    : "图片详情"}</p>
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
                    <button
                      key={index}
                      type="button"
                      onClick={() => setZoom({ kind: "reference", index })}
                      title="点击看大图"
                      className="relative overflow-hidden rounded-lg border border-edge transition hover:border-accent/60 focus-visible:border-accent/60"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={referenceImageUrl(generation.id, generation.created_at, index)}
                        alt={`参考图 ${index + 1}`}
                        className="h-16 w-16 cursor-zoom-in object-cover transition hover:scale-[1.04]"
                      />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {generation.has_mask ? (
              <div className="mt-2 rounded-xl border border-accent/30 bg-accent/5 p-2.5">
                <p className="label mb-1.5">
                  遮罩
                  <span className="ml-1 font-normal text-muted/60">（只重绘涂到的地方）</span>
                </p>
                <button
                  type="button"
                  onClick={() => setZoom({ kind: "mask" })}
                  title="点击看大图"
                  className="relative overflow-hidden rounded-lg border border-edge transition hover:border-accent/60 focus-visible:border-accent/60"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={maskImageUrl(generation.id, generation.created_at)}
                    alt="遮罩"
                    className="h-16 w-16 cursor-zoom-in object-cover transition hover:scale-[1.04]"
                  />
                </button>
              </div>
            ) : null}

            <div className="mt-3">
              <Row label="模型" value={modelLabel(generation.model_name, modelLabels)} />
              <Row label="类型" value={typeLabel} />
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
              {image.media_type === "video" ? (
                <>
                  <Row
                    label="时长"
                    value={
                      image.duration_seconds
                        ? `${image.duration_seconds.toFixed(1)} 秒${image.fps ? ` · ${Math.round(image.fps)}fps` : ""}`
                        : "—"
                    }
                  />
                  {image.frame_count ? <Row label="帧数" value={`${image.frame_count} 帧`} /> : null}
                </>
              ) : null}
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
            {studioHref ? (
              <Link href={studioHref} onClick={onClose} className="btn-ghost">
                在序列帧工坊打开
              </Link>
            ) : null}
            {canAiEdit ? (
              <button type="button" onClick={() => onEdit(item)} className="btn-ghost">
                AI 编辑
              </button>
            ) : null}
            {canLocalEdit ? (
              <Link href={`/tools/editor?image=${image.id}`} onClick={onClose} className="btn-ghost">
                本地编辑
              </Link>
            ) : null}
            {canRegenerate ? (
              <button type="button" onClick={() => onRegenerate(item)} className="btn-ghost">
                重新生成
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onDelete(item)}
              className="btn-ghost col-span-2 !text-bad hover:!border-bad/50"
            >
              {isVideo
              ? "删除这条视频"
              : isAsset
                ? "删除这个素材"
                : isFrameSet
                  ? "删除这个帧集"
                  : "删除这张图"}
            </button>
          </div>
        </div>
      </div>
    </div>

    {zoom !== null ? (
      <div
        className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/90 p-8"
        onClick={() => setZoom(null)}
        role="presentation"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={
            zoom.kind === "mask"
              ? maskImageUrl(generation.id, generation.created_at)
              : referenceImageUrl(generation.id, generation.created_at, zoom.index)
          }
          alt={zoom.kind === "mask" ? "遮罩" : `参考图 ${zoom.index + 1}`}
          className="max-h-[82vh] max-w-full rounded-lg object-contain shadow-pop"
        />
        <p className="text-[11px] text-white/60">
          {zoom.kind === "mask"
            ? "遮罩（白色区域会被重绘）"
            : `参考图 ${zoom.index + 1}${
                generation.reference_images && generation.reference_images.length > 1
                  ? ` / ${generation.reference_images.length}`
                  : ""
              }`}
          {" · 点任意处关闭"}
        </p>
      </div>
    ) : null}
    </>
  );
}
