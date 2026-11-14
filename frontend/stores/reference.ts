"use client";

import { create } from "zustand";

/** 参考图来源：用户刚上传的文件，或画廊里已有的图（取回成 File 再提交）。 */
export type ReferenceSource =
  | { kind: "file"; file: File }
  | { kind: "image"; id: number };

type ReferenceState = {
  source: ReferenceSource | null;
  /** 预览用：本地文件走 objectURL，画廊图直接指向 /images/{id}/file。 */
  previewUrl: string | null;
  fileName: string | null;
  /** 从画廊点「用作参考图」时置真，表单据此自动切到图片编辑。 */
  autoEdit: boolean;
  setFile: (file: File) => void;
  setImage: (image: { id: number; url: string }) => void;
  consumeAutoEdit: () => void;
  clear: () => void;
};

export const useReferenceStore = create<ReferenceState>((set, get) => ({
  source: null,
  previewUrl: null,
  fileName: null,
  autoEdit: false,

  setFile: (file) => {
    const previous = get().previewUrl;
    if (previous?.startsWith("blob:")) {
      URL.revokeObjectURL(previous);
    }
    set({
      source: { kind: "file", file },
      previewUrl: URL.createObjectURL(file),
      fileName: file.name,
    });
  },

  setImage: ({ id, url }) => {
    const previous = get().previewUrl;
    if (previous?.startsWith("blob:")) {
      URL.revokeObjectURL(previous);
    }
    set({
      source: { kind: "image", id },
      previewUrl: url,
      fileName: `画廊图片 #${id}`,
      autoEdit: true,
    });
  },

  consumeAutoEdit: () => set({ autoEdit: false }),

  clear: () => {
    const previous = get().previewUrl;
    if (previous?.startsWith("blob:")) {
      URL.revokeObjectURL(previous);
    }
    set({ source: null, previewUrl: null, fileName: null, autoEdit: false });
  },
}));
