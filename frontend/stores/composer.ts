"use client";

import { create } from "zustand";

import {
  DEFAULT_RATIO,
  DEFAULT_TIER,
  customSizeFor,
  imageSizeFor,
  type ImageTierKey,
} from "@/lib/size";

export type ComposerMode = "text_to_image" | "image_edit";

/** 图片编辑的遮罩：编辑一次就存这三个东西。 */
export type ComposerMask = {
  /** 交给后端的灰度 PNG，白色 = 要重绘的区域 */
  file: File;
  /** 叠在源图上的红色预览，用作槽位里的缩略图 */
  overlayUrl: string;
  /** 灰度遮罩本身，再次打开编辑器时载入 */
  maskUrl: string;
  width: number;
  height: number;
};

type ComposerState = {
  mode: ComposerMode;
  /** 两种模式各自保留未提交的提示词 */
  prompts: Record<ComposerMode, string>;
  modelId: string | null;
  /** "custom" 时用下面的 width/height，否则由比例 + 档位算出 */
  ratioKey: string;
  tierKey: ImageTierKey | "";
  width: number;
  height: number;
  count: number;
  seedMode: "random" | "fixed";
  seed: string;
  negative: string;
  steps: string;
  cfg: string;
  sampler: string;
  advancedOpen: boolean;
  /** 图片编辑的遮罩；有它这一单就走局部编辑 */
  mask: ComposerMask | null;
  setMode: (mode: ComposerMode) => void;
  setPrompt: (prompt: string) => void;
  setModelId: (modelId: string) => void;
  setRatio: (ratioKey: string) => void;
  setTier: (tierKey: ImageTierKey) => void;
  setCustomSize: (width: number, height: number) => void;
  setCount: (count: number) => void;
  setSeedMode: (mode: "random" | "fixed") => void;
  setSeed: (seed: string) => void;
  setNegative: (value: string) => void;
  setSteps: (value: string) => void;
  setCfg: (value: string) => void;
  setSampler: (value: string) => void;
  setAdvancedOpen: (open: boolean) => void;
  setMask: (mask: ComposerMask | null) => void;
  clearMask: () => void;
};

const initial = imageSizeFor(DEFAULT_RATIO, DEFAULT_TIER);

export const useComposerStore = create<ComposerState>((set) => ({
  mode: "text_to_image",
  prompts: { text_to_image: "", image_edit: "" },
  modelId: null,
  ratioKey: DEFAULT_RATIO,
  tierKey: DEFAULT_TIER,
  width: initial.width,
  height: initial.height,
  count: 4,
  seedMode: "random",
  seed: "",
  negative: "",
  steps: "",
  cfg: "",
  sampler: "",
  advancedOpen: false,
  mask: null,

  setMode: (mode) => set({ mode }),
  setPrompt: (prompt) =>
    set((state) => ({ prompts: { ...state.prompts, [state.mode]: prompt } })),
  setModelId: (modelId) => set({ modelId }),
  // 选比例时保留当前档位，选档位时保留当前比例：两者独立，和视频创作框一致
  setRatio: (ratioKey) =>
    set((state) => {
      const { width, height } = imageSizeFor(ratioKey, state.tierKey || DEFAULT_TIER);
      return { ratioKey, tierKey: state.tierKey || DEFAULT_TIER, width, height };
    }),
  setTier: (tierKey) =>
    set((state) => {
      const { width, height } = imageSizeFor(state.ratioKey === "custom" ? DEFAULT_RATIO : state.ratioKey, tierKey);
      return {
        tierKey,
        ratioKey: state.ratioKey === "custom" ? DEFAULT_RATIO : state.ratioKey,
        width,
        height,
      };
    }),
  setCustomSize: (width, height) => {
    const size = customSizeFor(width, height);
    set({ ratioKey: "custom", tierKey: "", width: size.width, height: size.height });
  },
  setCount: (count) => set({ count }),
  setSeedMode: (seedMode) => set({ seedMode }),
  setSeed: (seed) => set({ seed }),
  setNegative: (negative) => set({ negative }),
  setSteps: (steps) => set({ steps }),
  setCfg: (cfg) => set({ cfg }),
  setSampler: (sampler) => set({ sampler }),
  setAdvancedOpen: (advancedOpen) => set({ advancedOpen }),
  // 换遮罩时把旧的两个 blob URL 放掉，免得一直占内存
  setMask: (mask) =>
    set((state) => {
      if (state.mask && state.mask !== mask) {
        URL.revokeObjectURL(state.mask.overlayUrl);
        URL.revokeObjectURL(state.mask.maskUrl);
      }
      return { mask };
    }),
  clearMask: () =>
    set((state) => {
      if (state.mask) {
        URL.revokeObjectURL(state.mask.overlayUrl);
        URL.revokeObjectURL(state.mask.maskUrl);
      }
      return { mask: null };
    }),
}));
