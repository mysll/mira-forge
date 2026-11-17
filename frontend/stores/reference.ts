"use client";

import { create } from "zustand";

/** 参考图来源：用户刚上传的文件，或画廊里已有的图（取回成 File 再提交）。 */
export type ReferenceSource =
  | { kind: "file"; file: File }
  | { kind: "image"; id: number };

export type ReferenceItem = {
  key: string;
  source: ReferenceSource;
  /** 预览用：本地文件走 objectURL，画廊图直接指向 /images/{id}/file。 */
  previewUrl: string;
  name: string;
};

/** 图片编辑最多两张：第 1 张定结构，第 2 张可选（服装 / 材质参考）。 */
export const MAX_EDIT_REFS = 2;

let seq = 0;

const fileItem = (file: File): ReferenceItem => ({
  key: `f-${Date.now()}-${++seq}`,
  source: { kind: "file", file },
  previewUrl: URL.createObjectURL(file),
  name: file.name,
});

const imageItem = ({ id, url }: { id: number; url: string }): ReferenceItem => ({
  key: `i-${id}-${++seq}`,
  source: { kind: "image", id },
  previewUrl: url,
  name: `画廊图片 #${id}`,
});

const revoke = (item: ReferenceItem | undefined) => {
  if (item?.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(item.previewUrl);
  }
};

type ReferenceState = {
  items: ReferenceItem[];
  /** 从画廊点「继续编辑」时置真，表单据此自动切到图片编辑。 */
  autoEdit: boolean;
  /** 放进指定位置；不给 index 就补到第一个空位。返回实际放入的数量。 */
  putFiles: (files: File[], into?: number) => number;
  putImage: (image: { id: number; url: string }, into?: number) => void;
  removeAt: (index: number) => void;
  consumeAutoEdit: () => void;
  clear: () => void;
};

export const useReferenceStore = create<ReferenceState>((set, get) => ({
  items: [],
  autoEdit: false,

  putFiles: (files, into) => {
    const items = [...get().items];
    let placed = 0;
    const targets = into === undefined ? [] : [into];
    for (let index = 0; index < MAX_EDIT_REFS; index += 1) {
      if (index !== into) targets.push(index);
    }
    for (const slot of targets) {
      if (placed >= files.length) break;
      if (into === undefined && items[slot]) continue;
      revoke(items[slot]);
      items[slot] = fileItem(files[placed]);
      placed += 1;
    }
    set({ items });
    return placed;
  },

  putImage: ({ id, url }, into) => {
    const items = [...get().items];
    const slot = into ?? items.findIndex((item) => item === undefined);
    const index = slot === -1 || slot > MAX_EDIT_REFS - 1 ? MAX_EDIT_REFS - 1 : slot;
    revoke(items[index]);
    items[index] = imageItem({ id, url });
    set({ items: items.slice(0, MAX_EDIT_REFS), autoEdit: true });
  },

  removeAt: (index) => {
    const items = [...get().items];
    revoke(items[index]);
    items.splice(index, 1);
    set({ items });
  },

  consumeAutoEdit: () => set({ autoEdit: false }),

  clear: () => {
    get().items.forEach(revoke);
    set({ items: [], autoEdit: false });
  },
}));
