"use client";

import { create } from "zustand";

import { sizeFor } from "@/lib/size";

export type ComposerMode = "text_to_image" | "image_edit";

type ComposerState = {
  mode: ComposerMode;
  /** 两种模式各自保留未提交的提示词 */
  prompts: Record<ComposerMode, string>;
  modelId: string | null;
  ratioKey: string;
  longEdge: number;
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
  setMode: (mode: ComposerMode) => void;
  setPrompt: (prompt: string) => void;
  setModelId: (modelId: string) => void;
  setSize: (ratioKey: string, longEdge: number) => void;
  setCustomSize: (width: number, height: number) => void;
  setCount: (count: number) => void;
  setSeedMode: (mode: "random" | "fixed") => void;
  setSeed: (seed: string) => void;
  setNegative: (value: string) => void;
  setSteps: (value: string) => void;
  setCfg: (value: string) => void;
  setSampler: (value: string) => void;
  setAdvancedOpen: (open: boolean) => void;
};

const initial = sizeFor("1:1", 1024);

export const useComposerStore = create<ComposerState>((set) => ({
  mode: "text_to_image",
  prompts: { text_to_image: "", image_edit: "" },
  modelId: null,
  ratioKey: "1:1",
  longEdge: 1024,
  width: initial.width,
  height: initial.height,
  count: 1,
  seedMode: "random",
  seed: "",
  negative: "",
  steps: "",
  cfg: "",
  sampler: "",
  advancedOpen: false,

  setMode: (mode) => set({ mode }),
  setPrompt: (prompt) =>
    set((state) => ({ prompts: { ...state.prompts, [state.mode]: prompt } })),
  setModelId: (modelId) => set({ modelId }),
  setSize: (ratioKey, longEdge) => {
    const { width, height } = sizeFor(ratioKey, longEdge);
    set({ ratioKey, longEdge, width, height });
  },
  setCustomSize: (width, height) => set({ ratioKey: "custom", longEdge: 0, width, height }),
  setCount: (count) => set({ count }),
  setSeedMode: (seedMode) => set({ seedMode }),
  setSeed: (seed) => set({ seed }),
  setNegative: (negative) => set({ negative }),
  setSteps: (steps) => set({ steps }),
  setCfg: (cfg) => set({ cfg }),
  setSampler: (sampler) => set({ sampler }),
  setAdvancedOpen: (advancedOpen) => set({ advancedOpen }),
}));
