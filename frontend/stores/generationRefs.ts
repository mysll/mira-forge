"use client";

import { create } from "zustand";

/** 图生图一次最多几张参考图（与后端 MAX_REFERENCE_IMAGES 对应）。 */
export const MAX_GENERATION_REFS = 2;

export type GenerationRef = {
  key: string;
  name: string;
  /** 本地预览地址，移除时统一回收 */
  previewUrl: string;
  file: File;
};

type GenerationRefState = {
  items: GenerationRef[];
  /** 返回真正加入的数量，调用方据此提示「被截掉了」。 */
  addFiles: (files: File[]) => number;
  remove: (key: string) => void;
  clear: () => void;
};

let sequence = 0;

export const useGenerationRefStore = create<GenerationRefState>((set, get) => ({
  items: [],

  addFiles: (files) => {
    const room = MAX_GENERATION_REFS - get().items.length;
    if (room <= 0) {
      return 0;
    }
    const accepted = files.slice(0, room).map((file) => {
      sequence += 1;
      return {
        key: `ref-${sequence}`,
        name: file.name,
        previewUrl: URL.createObjectURL(file),
        file,
      };
    });
    set({ items: [...get().items, ...accepted] });
    return accepted.length;
  },

  remove: (key) => {
    const target = get().items.find((item) => item.key === key);
    if (target) {
      URL.revokeObjectURL(target.previewUrl);
    }
    set({ items: get().items.filter((item) => item.key !== key) });
  },

  clear: () => {
    get().items.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    set({ items: [] });
  },
}));
