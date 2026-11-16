/** 预设比例与分辨率：长边固定，短边按比例换算并对齐到 16 的倍数。 */

export type RatioPreset = {
  key: string;
  label: string;
  /** 比例分子/分母（宽 : 高） */
  w: number;
  h: number;
};

export const RATIOS: RatioPreset[] = [
  { key: "1:1", label: "1:1", w: 1, h: 1 },
  { key: "4:3", label: "4:3", w: 4, h: 3 },
  { key: "3:2", label: "3:2", w: 3, h: 2 },
  { key: "16:9", label: "16:9", w: 16, h: 9 },
  { key: "3:4", label: "3:4", w: 3, h: 4 },
  { key: "2:3", label: "2:3", w: 2, h: 3 },
  { key: "9:16", label: "9:16", w: 9, h: 16 },
];

export const LONG_EDGES = [768, 1024, 1328, 1536];

export function snap(value: number): number {
  return Math.max(64, Math.round(value / 16) * 16);
}

export function sizeFor(ratioKey: string, longEdge: number): { width: number; height: number } {
  const ratio = RATIOS.find((item) => item.key === ratioKey) ?? RATIOS[0];
  const edge = longEdge > 0 ? longEdge : 1024;
  if (ratio.w === ratio.h) {
    return { width: snap(edge), height: snap(edge) };
  }
  if (ratio.w > ratio.h) {
    return { width: snap(edge), height: snap((edge * ratio.h) / ratio.w) };
  }
  return { width: snap((edge * ratio.w) / ratio.h), height: snap(edge) };
}

export function megapixels(width: number, height: number): string {
  return `${((width * height) / 1_000_000).toFixed(2)} MP`;
}
