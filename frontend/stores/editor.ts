"use client";

import { create } from "zustand";

/**
 * 本地编辑器的状态。
 *
 * 只存「可序列化的参数」+ 两张已解码的图（原图 / 抠底后的主体）。
 * 撤销栈只覆盖参数（画布、位置、缩放、底色、抠底设置），
 * 不覆盖抠底结果本身——那一步有独立的「还原原图」。
 */

export type RemovalMode = "edge" | "color";

export type EditorParams = {
  canvasWidth: number;
  canvasHeight: number;
  heightPct: number;
  bottom: number;
  offsetX: number;
  background: string;
  mode: RemovalMode;
  tolerance: number;
  feather: number;
};

export type SourceImage = {
  name: string;
  image: HTMLImageElement;
  width: number;
  height: number;
};

type EditorState = {
  source: SourceImage | null;
  /** 抠底 / 裁边之后真正用来排版的那张图；没处理过时与 source 相同 */
  subject: HTMLImageElement | null;
  subjectName: string;
  cut: boolean;

  canvasWidth: number;
  canvasHeight: number;
  heightPct: number;
  bottom: number;
  offsetX: number;
  background: string;
  mode: RemovalMode;
  tolerance: number;
  feather: number;
  /** 导出倍率：1 / 2 / 4，只影响输出像素密度，不改构图（不进撤销栈） */
  exportScale: number;

  past: EditorParams[];
  future: EditorParams[];

  load: (source: SourceImage) => void;
  clear: () => void;
  setSubject: (image: HTMLImageElement, options?: { cut?: boolean }) => void;
  resetSubject: () => void;

  setCanvas: (width: number, height: number, options?: { quiet?: boolean }) => void;
  setParams: (patch: Partial<EditorParams>, options?: { quiet?: boolean }) => void;
  setExportScale: (scale: number) => void;
  undo: () => void;
  redo: () => void;
  reset: () => void;
};

const DEFAULT_TOLERANCE = 22;
const DEFAULT_FEATHER = 1;
const HISTORY_LIMIT = 40;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function snapshot(state: EditorState): EditorParams {
  return {
    canvasWidth: state.canvasWidth,
    canvasHeight: state.canvasHeight,
    heightPct: state.heightPct,
    bottom: state.bottom,
    offsetX: state.offsetX,
    background: state.background,
    mode: state.mode,
    tolerance: state.tolerance,
    feather: state.feather,
  };
}

export const useEditorStore = create<EditorState>((set, get) => ({
  source: null,
  subject: null,
  subjectName: "",
  cut: false,

  canvasWidth: 1024,
  canvasHeight: 1024,
  heightPct: 90,
  bottom: 20,
  offsetX: 0,
  background: "transparent",
  mode: "edge",
  tolerance: DEFAULT_TOLERANCE,
  feather: DEFAULT_FEATHER,
  exportScale: 1,

  past: [],
  future: [],

  load: (source) => {
    const canvasHeight = Math.max(256, Math.min(2048, source.height));
    const canvasWidth = Math.max(64, Math.round((canvasHeight * source.width) / source.height));
    set({
      source,
      subject: source.image,
      subjectName: source.name,
      cut: false,
      canvasWidth,
      canvasHeight,
      heightPct: 90,
      bottom: 20,
      offsetX: 0,
      background: "transparent",
      mode: "edge",
      tolerance: DEFAULT_TOLERANCE,
      feather: DEFAULT_FEATHER,
      past: [],
      future: [],
    });
  },

  clear: () =>
    set({
      source: null,
      subject: null,
      subjectName: "",
      cut: false,
      past: [],
      future: [],
    }),

  setSubject: (image, options) =>
    set((state) => ({
      subject: image,
      subjectName: state.subjectName,
      cut: options?.cut ?? state.cut,
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
    })),

  resetSubject: () =>
    set((state) => ({
      subject: state.source?.image ?? null,
      cut: false,
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
    })),

  setCanvas: (width, height, options) =>
    set((state) => {
      const canvasWidth = clamp(Math.round(width) || 1, 16, 4096);
      const canvasHeight = clamp(Math.round(height) || 1, 16, 4096);
      const history = options?.quiet
        ? { past: state.past, future: state.future }
        : { past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT), future: [] as EditorParams[] };
      return { canvasWidth, canvasHeight, ...history };
    }),

  setParams: (patch, options) =>
    set((state) => {
      const next: Partial<EditorParams> = { ...patch };
      if (patch.canvasWidth !== undefined) {
        next.canvasWidth = clamp(Math.round(patch.canvasWidth) || 1, 16, 4096);
      }
      if (patch.canvasHeight !== undefined) {
        next.canvasHeight = clamp(Math.round(patch.canvasHeight) || 1, 16, 4096);
      }
      if (patch.heightPct !== undefined) {
        next.heightPct = clamp(patch.heightPct, 5, 200);
      }
      if (patch.tolerance !== undefined) {
        next.tolerance = clamp(Math.round(patch.tolerance), 0, 255);
      }
      if (patch.feather !== undefined) {
        next.feather = clamp(Math.round(patch.feather), 0, 12);
      }
      if (patch.offsetX !== undefined) {
        next.offsetX = Math.round(patch.offsetX);
      }
      if (patch.bottom !== undefined) {
        next.bottom = Math.round(patch.bottom);
      }
      const history = options?.quiet
        ? { past: state.past, future: state.future }
        : { past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT), future: [] as EditorParams[] };
      return { ...next, ...history };
    }),

  setExportScale: (scale) =>
    set({ exportScale: clamp(Math.round(scale) || 1, 1, 8) }),

  undo: () => {
    const state = get();
    const previous = state.past.at(-1);
    if (!previous) {
      return;
    }
    set({
      ...previous,
      past: state.past.slice(0, -1),
      future: [snapshot(state), ...state.future].slice(0, HISTORY_LIMIT),
    });
  },

  redo: () => {
    const state = get();
    const next = state.future[0];
    if (!next) {
      return;
    }
    set({
      ...next,
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: state.future.slice(1),
    });
  },

  reset: () =>
    set((state) => ({
      canvasWidth: 1024,
      canvasHeight: 1024,
      heightPct: 90,
      bottom: 20,
      offsetX: 0,
      background: "transparent",
      mode: "edge",
      tolerance: DEFAULT_TOLERANCE,
      feather: DEFAULT_FEATHER,
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
    })),
}));

export const canUndo = (state: EditorState): boolean => state.past.length > 0;
export const canRedo = (state: EditorState): boolean => state.future.length > 0;
