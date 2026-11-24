"use client";

import { useEffect } from "react";

import { imageFileUrl } from "@/lib/api";
import type { ImageBrief } from "@/types/api";

type Props = {
  image: ImageBrief | null;
  onClose: () => void;
};

/** 点开看大图：棋盘格底、点空白或按 Esc 关闭。 */
export default function ImagePreview({ image, onClose }: Props) {
  useEffect(() => {
    if (!image) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [image, onClose]);

  if (!image) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-full max-w-[92vw] items-center justify-center rounded-xl2 border border-edge p-2"
        style={{
          backgroundImage:
            "linear-gradient(45deg,#141821 25%,transparent 25%),linear-gradient(-45deg,#141821 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#141821 75%),linear-gradient(-45deg,transparent 75%,#141821 75%)",
          backgroundSize: "24px 24px",
          backgroundPosition: "0 0,0 12px,12px -12px,-12px 0",
          backgroundColor: "#0b0d12",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageFileUrl(image)}
          alt=""
          className="max-h-[80vh] max-w-[86vw] object-contain"
        />
        <div className="absolute -bottom-9 left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] text-white/60">
          {image.width}×{image.height} · 点空白处或按 Esc 关闭
        </div>
      </div>
    </div>
  );
}
