/**
 * 本地图片编辑器的纯函数：排版计算、绘制、导出。
 *
 * 这一层不碰网络，也不持有状态——状态在 `stores/editor.ts`，
 * 组件只负责把两者接起来。这样排版规则可以被测试和被别处复用。
 */

export type Placement = { x: number; y: number; width: number; height: number };

export type SceneInput = {
  canvasWidth: number;
  canvasHeight: number;
  /** "transparent" 或 #rrggbb */
  background: string;
  subject: HTMLImageElement | null;
  /** 主体高度占画布高度的百分比 */
  heightPct: number;
  /** 主体底边距画布底部的像素 */
  bottom: number;
  /** 相对水平居中的像素偏移，正数向右 */
  offsetX: number;
};

export const MIN_SUBJECT_PCT = 5;
export const MAX_EXPORT_EDGE = 8192;
export const MAX_SUBJECT_PCT = 200;

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * 主体在画布上的位置与尺寸。
 *
 * 缩放只按高度算，宽度按原图宽高比推出来——**任何情况下都不会拉伸**，
 * 这正是「主体缩放不能变形」这条要求的实现方式。
 */
export function placementFor(input: SceneInput): Placement | null {
  const subject = input.subject;
  if (!subject || subject.naturalWidth === 0 || subject.naturalHeight === 0) {
    return null;
  }
  const canvasWidth = Math.max(1, Math.round(input.canvasWidth));
  const canvasHeight = Math.max(1, Math.round(input.canvasHeight));
  const pct = clamp(input.heightPct, MIN_SUBJECT_PCT, MAX_SUBJECT_PCT);
  const height = Math.max(1, (canvasHeight * pct) / 100);
  const width = height * (subject.naturalWidth / subject.naturalHeight);
  const centerX = canvasWidth / 2 + input.offsetX;
  const x = centerX - width / 2;
  const bottom = clamp(input.bottom, 0, canvasHeight);
  const y = canvasHeight - bottom - height;
  return { x: round2(x), y: round2(y), width: round2(width), height: round2(height) };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 让主体刚好放进画布（留一点边），返回建议的高度百分比。 */
export function fitHeightPct(canvasWidth: number, canvasHeight: number, subjectWidth: number, subjectHeight: number, marginPct = 4): number {
  if (!subjectWidth || !subjectHeight || !canvasWidth || !canvasHeight) {
    return 90;
  }
  const usableHeight = (canvasHeight * (100 - marginPct * 2)) / 100;
  const usableWidth = (canvasWidth * (100 - marginPct * 2)) / 100;
  const byHeight = usableHeight / subjectHeight;
  const byWidth = usableWidth / subjectWidth;
  return clamp(Math.min(byHeight, byWidth) * 100, MIN_SUBJECT_PCT, MAX_SUBJECT_PCT);
}

/** 把 src 画成一张新 canvas（导出与预览共用同一套绘制代码）。
 *
 *  `scale` 只影响输出像素密度：几何全部按画布坐标算，最后整体乘 scale，
 *  所以 2× 导出和 1× 导出在构图上一模一样，只是像素翻倍。 */
export function drawScene(ctx: CanvasRenderingContext2D, input: SceneInput, scale = 1): Placement | null {
  const placement = placementFor(input);
  const ratio = Math.max(1, scale);
  const width = Math.round(input.canvasWidth * ratio);
  const height = Math.round(input.canvasHeight * ratio);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, width, height);

  if (input.background !== "transparent") {
    ctx.fillStyle = input.background;
    ctx.fillRect(0, 0, width, height);
  }

  if (placement && input.subject) {
    drawSharply(
      ctx,
      input.subject,
      placement.x * ratio,
      placement.y * ratio,
      placement.width * ratio,
      placement.height * ratio,
    );
  }
  ctx.restore();
  return placement;
}

/**
 * 画主体，并在「大幅缩小」时分级降采样。
 *
 * 浏览器的一次性 `drawImage` 从 1024 缩到 230 会丢细节（边缘发软、细线断开）；
 * 先按 1/2 逐级缩小到接近目标尺寸再落笔，边缘会明显更实。
 * 放大的情况无法凭空造出细节，这里只保证不额外插值模糊。
 */
function drawSharply(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number },
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const sourceWidth = image.naturalWidth ?? image.width ?? width;
  const sourceHeight = image.naturalHeight ?? image.height ?? height;
  let source: CanvasImageSource = image;
  let currentWidth = sourceWidth;
  let currentHeight = sourceHeight;

  // 目标不到源图的一半时才需要分级；最多降 5 级，避免超大图卡顿
  let guard = 0;
  while (currentWidth / 2 > width && guard < 5) {
    const nextWidth = Math.max(1, Math.round(currentWidth / 2));
    const nextHeight = Math.max(1, Math.round((currentHeight * nextWidth) / currentWidth));
    const scratch = document.createElement("canvas");
    scratch.width = nextWidth;
    scratch.height = nextHeight;
    const scratchContext = scratch.getContext("2d");
    if (!scratchContext) {
      break;
    }
    scratchContext.imageSmoothingEnabled = true;
    scratchContext.imageSmoothingQuality = "high";
    scratchContext.drawImage(source, 0, 0, nextWidth, nextHeight);
    source = scratch;
    currentWidth = nextWidth;
    currentHeight = nextHeight;
    guard += 1;
  }

  ctx.drawImage(source, x, y, width, height);
}

/** 导出尺寸 = 画布 × 倍率；超过 8192px 会等比压回，避免一次性申请几百 MB 的位图。 */
export function exportSize(input: { canvasWidth: number; canvasHeight: number }, scale = 1): { width: number; height: number } {
  const requested = Math.max(1, scale);
  const longest = Math.max(input.canvasWidth, input.canvasHeight) * requested;
  const ratio = longest > MAX_EXPORT_EDGE ? (requested * MAX_EXPORT_EDGE) / longest : requested;
  return { width: Math.round(input.canvasWidth * ratio), height: Math.round(input.canvasHeight * ratio) };
}

/** 主体相对原图像素的放大倍数；>1 表示已经在「无中生有」地放大。 */
export function upscaleRatio(
  placement: Placement | null,
  subject: { naturalWidth: number; naturalHeight: number } | null,
): number {
  if (!placement || !subject || !subject.naturalWidth || !subject.naturalHeight) {
    return 1;
  }
  return Math.max(placement.width / subject.naturalWidth, placement.height / subject.naturalHeight);
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = "image/png"): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("画布导出失败"));
      }
    }, type);
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // 给浏览器一点时间开始下载再回收
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function loadImageElement(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "sync";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("图片解码失败"));
      image.src = url;
    });
    // 解码完成后再断开 URL 也不影响已经载入的图片
    return image;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export function formatSize(width: number, height: number): string {
  return `${Math.round(width)} × ${Math.round(height)}`;
}

/** 文件名去掉扩展名，用于导出时拼 `-256x256.png` 这样的后缀。 */
export function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  const trimmed = dot > 0 ? name.slice(0, dot) : name;
  return trimmed.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60) || "image";
}

export function rgbToHex(rgb: number[] | undefined): string {
  if (!rgb || rgb.length < 3) {
    return "#ffffff";
  }
  return `#${rgb
    .slice(0, 3)
    .map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0"))
    .join("")}`;
}
