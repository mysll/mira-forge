"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { fetchImages, imageThumbnailUrl } from "@/lib/api";
import type { ImageBrief } from "@/types/api";

/**
 * 从已生成的作品里挑一张图。
 *
 * 为什么要有它：视频的首帧 / 尾帧经常就是刚生成的那张图，让用户先下载到本地再上传
 * 是一步多余的操作。这里直接读 /images（过滤掉视频），点一下就选。
 */
export default function ImagePicker({
  open,
  title = "选择图片",
  hint,
  onClose,
  onPick,
  onUpload,
}: {
  open: boolean;
  title?: string;
  hint?: string;
  onClose: () => void;
  onPick: (image: ImageBrief) => void;
  onUpload?: () => void;
}) {
  const images = useQuery({
    queryKey: ["images", "picker"],
    queryFn: () => fetchImages({ limit: 60 }),
    enabled: open,
    staleTime: 10_000,
  });

  // 创作框带 backdrop-filter，会把它变成 fixed 子元素的包含块；
  // 用 portal 挂到 body，弹层才是相对视口居中，不会跑到屏幕外。
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const items = (images.data?.items ?? []).filter((item) => item.media_type !== "video");

  if (!mounted) {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl2 border border-edge bg-surface shadow-pop"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge/70 px-4 py-3">
          <div>
            <h3 className="text-sm text-ink">{title}</h3>
            {hint ? <p className="mt-0.5 text-[11px] text-muted">{hint}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="icon-btn h-7 w-7"
            title="关闭"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="scroll-thin flex-1 overflow-y-auto p-4">
          {images.isPending ? (
            <p className="py-10 text-center text-xs text-muted">正在读取作品…</p>
          ) : items.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted">
              还没有生成过图片，先用「图片」工作台生成一张，或者直接上传本机图片。
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
              {items.map((image) => (
                <button
                  key={image.id}
                  type="button"
                  onClick={() => onPick(image)}
                  title={`${image.width} × ${image.height}`}
                  className="group relative aspect-square overflow-hidden rounded-lg border border-edge/70 transition hover:border-accent/60 hover:ring-2 hover:ring-accent/30"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageThumbnailUrl(image)}
                    alt={`作品 ${image.id}`}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                  <span className="absolute inset-x-0 bottom-0 bg-black/55 py-0.5 text-[10px] text-white/80">
                    {image.width}×{image.height}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-edge/70 px-4 py-3">
          <p className="text-[11px] text-muted">共 {items.length} 张图片，点一下就选为画面</p>
          <div className="flex items-center gap-2">
            {onUpload ? (
              <button type="button" className="btn btn-ghost h-8" onClick={onUpload}>
                从本机上传
              </button>
            ) : null}
            <button type="button" className="btn btn-primary h-8" onClick={onClose}>
              取消
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
