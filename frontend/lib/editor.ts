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

/** 把 src 画成一张新 canvas（导出与预览共用同一套绘制代码）。 */
export function drawScene(ctx: CanvasRenderingContext2D, input: SceneInput): Placement | null {
  const placement = placementFor(input);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, input.canvasWidth, input.canvasHeight);

  if (input.background !== "transparent") {
    ctx.fillStyle = input.background;
    ctx.fillRect(0, 0, input.canvasWidth, input.canvasHeight);
  }

  if (placement && input.subject) {
    ctx.drawImage(input.subject, placement.x, placement.y, placement.width, placement.height);
  }
  ctx.restore();
  return placement;
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
