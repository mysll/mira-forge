/** 图片的预设比例与分辨率档位：短边定档，长边按比例换算，并对齐到 16 的倍数。
 *
 * 和视频创作框共用同一套信息密度（比例方块 + 分辨率档位），差别只是档位更偏静态图：
 * 480 / 720 / 1K / 2K，短边分别是 480 / 720 / 1024 / 1440。
 * 长边硬上限 2560——再大 Qwen 在 16GB 卡上出图会明显变慢，也不比 2K 更好看。
 */

export type ImageRatio = {
  key: string;
  label: string;
  /** 比例分子/分母（宽 : 高） */
  w: number;
  h: number;
};

export const IMAGE_RATIOS: ImageRatio[] = [
  { key: "21:9", label: "21:9", w: 21, h: 9 },
  { key: "16:9", label: "16:9", w: 16, h: 9 },
  { key: "5:4", label: "5:4", w: 5, h: 4 },
  { key: "4:3", label: "4:3", w: 4, h: 3 },
  { key: "3:2", label: "3:2", w: 3, h: 2 },
  { key: "1:1", label: "1:1", w: 1, h: 1 },
  { key: "2:3", label: "2:3", w: 2, h: 3 },
  { key: "3:4", label: "3:4", w: 3, h: 4 },
  { key: "4:5", label: "4:5", w: 4, h: 5 },
  { key: "9:16", label: "9:16", w: 9, h: 16 },
];

export type ImageTierKey = "480" | "720" | "1K" | "2K";

export type ImageTier = {
  key: ImageTierKey;
  label: string;
  /** 短边像素；1:1 时就是边长 */
  shortEdge: number;
};

export const IMAGE_TIERS: ImageTier[] = [
  { key: "480", label: "480", shortEdge: 480 },
  { key: "720", label: "720", shortEdge: 720 },
  { key: "1K", label: "1K", shortEdge: 1024 },
  { key: "2K", label: "2K", shortEdge: 1440 },
];

export const DEFAULT_RATIO = "1:1";
export const DEFAULT_TIER: ImageTierKey = "1K";

const MIN_EDGE = 256;
const MAX_LONG_EDGE = 2560;
const MAX_SHORT_EDGE = 2048;

/** 对齐到 16：Qwen 的 latent 是 8x 下采样再 2x patch，16 的倍数就够，720 这类常用档位也能原样保留。 */
export function snap(value: number): number {
  return Math.max(MIN_EDGE, Math.round(value / 16) * 16);
}

export function clampSize(width: number, height: number): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= MAX_LONG_EDGE) {
    return { width, height };
  }
  const scale = MAX_LONG_EDGE / longEdge;
  return { width: snap(width * scale), height: snap(height * scale) };
}

export function ratioOf(key: string): ImageRatio {
  return IMAGE_RATIOS.find((item) => item.key === key) ?? IMAGE_RATIOS[5];
}

/** 按「比例 + 档位」算尺寸；档位决定短边，长边超限时整体缩小。 */
export function imageSizeFor(
  ratioKey: string,
  tierKey: ImageTierKey | string,
): { width: number; height: number } {
  const ratio = ratioOf(ratioKey);
  const tier = IMAGE_TIERS.find((item) => item.key === tierKey) ?? IMAGE_TIERS[2];
  const shortEdge = Math.min(tier.shortEdge, MAX_SHORT_EDGE);
  const longRatio = Math.max(ratio.w, ratio.h) / Math.min(ratio.w, ratio.h);

  if (ratio.w === ratio.h) {
    return { width: snap(shortEdge), height: snap(shortEdge) };
  }
  const longEdge = shortEdge * longRatio;
  const scaled = clampSize(
    ratio.w > ratio.h ? longEdge : shortEdge,
    ratio.w > ratio.h ? shortEdge : longEdge,
  );
  return { width: snap(scaled.width), height: snap(scaled.height) };
}

/** 自定义尺寸只做对齐与上限收敛，不改比例。 */
export function customSizeFor(width: number, height: number): { width: number; height: number } {
  const safeWidth = width > 0 ? width : 1024;
  const safeHeight = height > 0 ? height : 1024;
  const scaled = clampSize(safeWidth, safeHeight);
  return { width: snap(scaled.width), height: snap(scaled.height) };
}

export function megapixels(width: number, height: number): string {
  return `${((width * height) / 1_000_000).toFixed(2)} MP`;
}
