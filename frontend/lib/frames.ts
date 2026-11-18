// 抽帧台的像素活：逐帧抽出、可选抠背景、量主体框、按「锁水平 / 锁垂直」算偏移。
// 全部跑在 CPU 上、不依赖后端：抽帧台只是浏览器里的一段 canvas 处理。

export type Frame = {
  index: number;
  time: number;
  canvas: HTMLCanvasElement;
};

export type SubjectBox = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  centerX: number;
};

export type AlignMode = "none" | "x" | "y" | "both";

export type Offset = { dx: number; dy: number };

export type ExtractOptions = {
  fps: number;
  start?: number;
  end?: number;
  limit?: number;
  onProgress?: (done: number, total: number) => void;
};

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const duration = Number.isFinite(video.duration) ? video.duration : time;
    const target = Math.min(Math.max(time, 0), Math.max(duration - 0.001, 0));
    if (Math.abs(video.currentTime - target) < 0.002) {
      resolve();
      return;
    }
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    video.currentTime = target;
  });
}

export async function extractFrames(video: HTMLVideoElement, options: ExtractOptions): Promise<Frame[]> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) {
    throw new Error("视频还没解出画面，等它加载完再抽帧");
  }
  const fps = Math.max(1, Math.min(60, options.fps));
  const start = Math.max(0, options.start ?? 0);
  const end = Math.min(video.duration || start, options.end ?? (video.duration || start));
  const step = 1 / fps;
  const total = Math.max(1, Math.floor((end - start) / step) + 1);
  const limit = Math.max(1, Math.min(options.limit ?? total, total));

  video.pause();
  const frames: Frame[] = [];
  for (let index = 0; index < limit; index += 1) {
    const time = Math.min(start + index * step, Math.max(end - 0.001, 0));
    await seek(video, time);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("这台设备的浏览器给不了 2D 画布");
    }
    context.drawImage(video, 0, 0, width, height);
    frames.push({ index, time, canvas });
    options.onProgress?.(index + 1, limit);
  }
  return frames;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** 取四角一圈像素的中位数当底色，再按欧氏距离抠掉（与工坊同一套度量：0–441）。 */
export function keyOutBackground(canvas: HTMLCanvasElement, tolerance: number, feather = 18): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const width = canvas.width;
  const height = canvas.height;
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];
  const corners = [
    [0, 0],
    [width - 8, 0],
    [0, height - 8],
    [width - 8, height - 8],
  ];
  for (const [startX, startY] of corners) {
    for (let y = Math.max(0, startY); y < Math.min(height, startY + 8); y += 1) {
      for (let x = Math.max(0, startX); x < Math.min(width, startX + 8); x += 1) {
        const offset = (y * width + x) * 4;
        reds.push(data[offset]);
        greens.push(data[offset + 1]);
        blues.push(data[offset + 2]);
      }
    }
  }
  const keyRed = median(reds);
  const keyGreen = median(greens);
  const keyBlue = median(blues);
  const cut = Math.max(0, tolerance);
  const ramp = Math.max(1, feather);
  for (let offset = 0; offset < data.length; offset += 4) {
    const dr = data[offset] - keyRed;
    const dg = data[offset + 1] - keyGreen;
    const db = data[offset + 2] - keyBlue;
    const distance = Math.sqrt(dr * dr + dg * dg + db * db);
    if (distance <= cut) {
      data[offset + 3] = 0;
    } else if (distance < cut + ramp) {
      data[offset + 3] = Math.round(((distance - cut) / ramp) * data[offset + 3]);
    }
  }
  context.putImageData(image, 0, 0);
}

function cornerKey(canvas: HTMLCanvasElement, data: Uint8ClampedArray): [number, number, number] {
  const width = canvas.width;
  const height = canvas.height;
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];
  const corners = [
    [0, 0],
    [width - 8, 0],
    [0, height - 8],
    [width - 8, height - 8],
  ];
  for (const [startX, startY] of corners) {
    for (let y = Math.max(0, startY); y < Math.min(height, startY + 8); y += 1) {
      for (let x = Math.max(0, startX); x < Math.min(width, startX + 8); x += 1) {
        const offset = (y * width + x) * 4;
        reds.push(data[offset]);
        greens.push(data[offset + 1]);
        blues.push(data[offset + 2]);
      }
    }
  }
  return [median(reds), median(greens), median(blues)];
}

/**
 * 量出「主体」在哪：bbox + alpha 加权质心 X，用于对齐。
 *
 * 没抠背景时整帧都是不透明的，光看 alpha 会把整张画面当主体（质心永远在正中，
 * 算出来的偏移全是 0），所以这里同时按「与四角底色的距离」判一次：距离够远的像素
 * 才算主体。抠过背景的帧两侧都成立，结果一致。
 */
export function measureSubject(canvas: HTMLCanvasElement, keyTolerance = 40): SubjectBox {
  const context = canvas.getContext("2d");
  if (!context) {
    return { left: 0, right: canvas.width, top: 0, bottom: canvas.height, width: canvas.width, height: canvas.height, centerX: canvas.width / 2 };
  }
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const [keyRed, keyGreen, keyBlue] = cornerKey(canvas, data);
  let left = canvas.width;
  let right = -1;
  let top = canvas.height;
  let bottom = -1;
  let weight = 0;
  let weighted = 0;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const offset = (y * canvas.width + x) * 4;
      const alpha = data[offset + 3];
      if (alpha <= 8) continue;
      const dr = data[offset] - keyRed;
      const dg = data[offset + 1] - keyGreen;
      const db = data[offset + 2] - keyBlue;
      if (Math.sqrt(dr * dr + dg * dg + db * db) <= keyTolerance) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      weight += alpha;
      weighted += alpha * x;
    }
  }
  if (right < 0 || bottom < 0) {
    return { left: 0, right: canvas.width, top: 0, bottom: canvas.height, width: canvas.width, height: canvas.height, centerX: canvas.width / 2 };
  }
  return {
    left,
    right,
    top,
    bottom,
    width: right - left + 1,
    height: bottom - top + 1,
    centerX: weight > 0 ? weighted / weight : (left + right) / 2,
  };
}

/** 背景色：取四角 8x8 的中位数，返回 #rrggbb（不抠背景时用它填平移留下的缺口）。 */
export function sampleBackground(canvas: HTMLCanvasElement): string {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return "#000000";
  const { width, height } = canvas;
  const size = Math.max(1, Math.min(8, Math.floor(Math.min(width, height) / 2)));
  const spots = [
    [0, 0],
    [width - size, 0],
    [0, height - size],
    [width - size, height - size],
  ];
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (const [x, y] of spots) {
    const data = context.getImageData(x, y, size, size).data;
    for (let i = 0; i < data.length; i += 4) {
      red += data[i];
      green += data[i + 1];
      blue += data[i + 2];
      count += 1;
    }
  }
  if (!count) return "#000000";
  const hex = (value: number) => Math.round(value / count).toString(16).padStart(2, "0");
  return `#${hex(red)}${hex(green)}${hex(blue)}`;
}

export type ShiftOptions = {
  /** 输出画布尺寸：严格等于源帧尺寸，导出前后不变 */
  width: number;
  height: number;
  /** null = 透明底（抠了背景）；给颜色则先铺满这张画布再画帧 */
  fill: string | null;
};

/**
 * 把一帧平移进一张与源帧等大的画布：越界的部分被裁掉，位移留下的缺口用 fill 填。
 * 这里不缩放、不裁切画布，导出尺寸永远等于源视频的帧尺寸。
 */
export function renderShifted(frame: Frame, offset: Offset, options: ShiftOptions): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(options.width));
  canvas.height = Math.max(1, Math.round(options.height));
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  if (options.fill) {
    context.fillStyle = options.fill;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(frame.canvas, Math.round(offset.dx), Math.round(offset.dy));
  return canvas;
}

/**
 * 洋葱皮：把一帧里的主体（与四角底色差得够远的像素）染成一种颜色，其余全透明。
 * 不抠背景的帧整张都是不透明的，直接叠上去会把画面糊成一片，所以要先「取出主体」。
 */
export function ghostCanvas(frame: Frame, tint = "rgba(90, 170, 255, 0.95)", cut = 32): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = frame.canvas.width;
  canvas.height = frame.canvas.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return canvas;
  context.drawImage(frame.canvas, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  const background = sampleBackground(frame.canvas);
  const keyRed = Number.parseInt(background.slice(1, 3), 16);
  const keyGreen = Number.parseInt(background.slice(3, 5), 16);
  const keyBlue = Number.parseInt(background.slice(5, 7), 16);
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] <= 8) {
      data[offset + 3] = 0;
      continue;
    }
    const dr = data[offset] - keyRed;
    const dg = data[offset + 1] - keyGreen;
    const db = data[offset + 2] - keyBlue;
    if (Math.sqrt(dr * dr + dg * dg + db * db) <= cut) data[offset + 3] = 0;
  }
  context.putImageData(image, 0, 0);
  context.globalCompositeOperation = "source-atop";
  context.fillStyle = tint;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("导不出这张画布"));
    }, "image/png");
  });
}

export async function canvasToBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await canvasToBlob(canvas);
  return new Uint8Array(await blob.arrayBuffer());
}
