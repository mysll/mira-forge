/**
 * 视频的尺寸：按「比例 × 分辨率档」算宽高，和图片的尺寸面板同一套思路。
 *
 * 为什么要算而不是列死：MiniMax H3 的 width/height 只要求是 32 的倍数，
 * 官方模板自己也是用 1344×768 这种对齐过的数；把「比例 + 档位」交给用户，
 * 组合数比列一长串预设更省心，也不会把模型能力写死在前端。
 */

export type VideoRatioKey = "auto" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";

export type VideoRatio = {
  key: VideoRatioKey;
  label: string;
  /** 宽 / 高；auto 没有固定比例，用模型默认值 */
  value: number;
  /** 面板里的小方块形状，宽度按比例给 */
  shape: string;
};

export const VIDEO_RATIOS: VideoRatio[] = [
  { key: "auto", label: "自动", value: 0, shape: "1 / 1" },
  { key: "21:9", label: "21:9", value: 21 / 9, shape: "21 / 9" },
  { key: "16:9", label: "16:9", value: 16 / 9, shape: "16 / 9" },
  { key: "4:3", label: "4:3", value: 4 / 3, shape: "4 / 3" },
  { key: "1:1", label: "1:1", value: 1, shape: "1 / 1" },
  { key: "3:4", label: "3:4", value: 3 / 4, shape: "3 / 4" },
  { key: "9:16", label: "9:16", value: 9 / 16, shape: "9 / 16" },
];

/** 档位按「短边」定义，跟分辨率称号一致：480p / 720p / 1080p。 */
export type VideoTier = { key: string; label: string; shortEdge: number };

export const VIDEO_TIERS: VideoTier[] = [
  { key: "480p", label: "480p", shortEdge: 480 },
  { key: "720p", label: "720p", shortEdge: 720 },
  { key: "1080p", label: "1080p", shortEdge: 1080 },
];

const MIN_EDGE = 256;
const MAX_EDGE = 2048;

/** 对齐到 32（模型要求），并夹在合理区间里。 */
export function align32(value: number): number {
  const snapped = Math.round(value / 32) * 32;
  return Math.min(MAX_EDGE, Math.max(MIN_EDGE, snapped));
}

export type VideoSize = { width: number; height: number; label: string };

/** 「自动」时把模型默认宽高比吸附到最近的常用比例，免得算出 1952 这种怪数。 */
const SNAP_RATIOS = [21 / 9, 16 / 9, 4 / 3, 1, 3 / 4, 9 / 16];

function snapRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 16 / 9;
  let best = SNAP_RATIOS[0];
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const candidate of SNAP_RATIOS) {
    const delta = Math.abs(Math.log(value / candidate));
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * 比例 + 档位 → 实际宽高。
 *
 * 「自动」= 沿用模型默认的宽高比（吸附到常用比例），再按档位缩放短边，
 * 所以 480p/720p/1080p 在自动档位下也照样生效（否则选了档位没反应，用户会以为是坏的）。
 */
export function videoSizeFor(
  ratio: VideoRatio,
  tier: VideoTier,
  fallback: { width: number; height: number },
): VideoSize {
  const auto = ratio.key === "auto" || ratio.value <= 0;
  const fallbackRatio =
    fallback.height > 0 ? fallback.width / fallback.height : 16 / 9;
  const value = auto ? snapRatio(fallbackRatio) : ratio.value;

  const edge = tier.shortEdge;
  const width = value >= 1 ? edge * value : edge;
  const height = value >= 1 ? edge : edge / value;
  const w = align32(width);
  const h = align32(height);
  const label = auto ? `自动 ${w}×${h}` : `${ratio.label} ${w}×${h}`;
  return { width: w, height: h, label };
}

/**
 * 时长：3 / 5 / 8 / 10 秒是快捷档，1–15 秒之间可以用滑块随意取。
 * 模型侧的帧数 = max(5, round(秒×24)) 再补齐到 5 + 17k。
 */
export const VIDEO_DURATION_PRESETS = [3, 5, 8, 10];
export const VIDEO_DURATION_MIN = 1;
export const VIDEO_DURATION_MAX = 15;

/** 把任意输入夹到允许区间，并取整（模型只吃整数帧数换算）。 */
export function clampDuration(value: number): number {
  if (!Number.isFinite(value)) return VIDEO_DURATION_MIN;
  const rounded = Math.round(value);
  return Math.min(VIDEO_DURATION_MAX, Math.max(VIDEO_DURATION_MIN, rounded));
}

/**
 * 粗估一条视频的工作量：百万像素 × 帧（MP·帧）。
 * 参考值：864×480 × 5 秒 ≈ 51，实测峰值显存 15.3GB，已经贴着 16GB 的边。
 */
export function videoWeight(width: number, height: number, seconds: number): number {
  const frames = Math.max(5, Math.round(seconds * 24));
  return (width * height * frames) / 1_000_000;
}

/** 超过这个量在 16GB 卡上大概率要重试，前端据此提示一句（不拦着）。 */
export const VIDEO_WEIGHT_WARN = 60;

/**
 * 反查：已知一批视频的宽高，猜回它当时用的是哪个比例 + 档位。
 *
 * 「重新生成」要把旧参数填回创作框，而创作框的状态是「比例 + 档位」而不是宽高；
 * 先找能算出同样宽高的组合，找不到就按短边最近的档位、长宽比最近的比例兜底。
 */
export function matchVideoSize(
  width: number,
  height: number,
  fallback: { width: number; height: number },
): { ratioKey: VideoRatioKey; tierKey: string } {
  // 「自动」不参与匹配：它的宽高是拿 fallback 现算的，兜底给目标尺寸时反而会自己匹配自己
  const ratios = VIDEO_RATIOS.filter((item) => item.value > 0);
  if (width > 0 && height > 0) {
    for (const tier of VIDEO_TIERS) {
      for (const ratio of ratios) {
        const size = videoSizeFor(ratio, tier, fallback);
        if (size.width === width && size.height === height) {
          return { ratioKey: ratio.key, tierKey: tier.key };
        }
      }
    }
  }

  const aspect =
    width > 0 && height > 0
      ? width / height
      : fallback.width > 0 && fallback.height > 0
        ? fallback.width / fallback.height
        : 16 / 9;
  let bestRatio = VIDEO_RATIOS[0];
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const candidate of ratios) {
    const value = candidate.value;
    const delta = Math.abs(Math.log(aspect / value));
    if (delta < bestDelta) {
      bestRatio = candidate;
      bestDelta = delta;
    }
  }

  const shortEdge = Math.min(width || fallback.width, height || fallback.height);
  let bestTier = VIDEO_TIERS[0];
  let tierDelta = Number.POSITIVE_INFINITY;
  for (const candidate of VIDEO_TIERS) {
    const delta = Math.abs(Math.log((shortEdge || candidate.shortEdge) / candidate.shortEdge));
    if (delta < tierDelta) {
      bestTier = candidate;
      tierDelta = delta;
    }
  }

  return { ratioKey: bestRatio.key, tierKey: bestTier.key };
}
