"use client";

import { create } from "zustand";

/**
 * 「重新生成」要把旧参数填回视频创作框：提示词、模型、时长、尺寸，以及首帧 / 尾帧。
 *
 * 创作框的状态都在组件内部（不需要跨页共享），只有这一条「从作品流回填」的通路，
 * 所以用一个一次性的 recall 载荷：作品流塞进来，创作框取走就清空。
 */
export type VideoRecall = {
  prompt: string;
  modelId: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  count: number;
  /** 参考图（首帧 / 尾帧）的地址，创作框自己取回字节 */
  firstUrl?: string;
  lastUrl?: string;
};

type VideoComposerState = {
  recall: VideoRecall | null;
  requestRecall: (recall: VideoRecall) => void;
  consumeRecall: () => void;
};

export const useVideoComposerStore = create<VideoComposerState>((set) => ({
  recall: null,
  requestRecall: (recall) => set({ recall }),
  consumeRecall: () => set({ recall: null }),
}));
