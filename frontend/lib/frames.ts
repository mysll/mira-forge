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

/** 以参考帧为基准算每帧该挪多少：锁水平对质心 X，锁垂直对脚底线（bottom）。 */
export function computeOffsets(
  frames: Frame[],
  boxes: Map<number, SubjectBox>,
  mode: AlignMode,
  referenceIndex: number,
): Map<number, Offset> {
  const reference = boxes.get(referenceIndex);
  const result = new Map<number, Offset>();
  for (const frame of frames) {
    if (mode === "none" || !reference) {
      result.set(frame.index, { dx: 0, dy: 0 });
      continue;
    }
    const box = boxes.get(frame.index);
    if (!box) {
      result.set(frame.index, { dx: 0, dy: 0 });
      continue;
    }
    const dx = mode === "x" || mode === "both" ? Math.round(reference.centerX - box.centerX) : 0;
    const dy = mode === "y" || mode === "both" ? reference.bottom - box.bottom : 0;
    result.set(frame.index, { dx, dy });
  }
  return result;
}

export type Bounds = { minX: number; minY: number; width: number; height: number };

/** 把所有帧按各自的偏移摆进去之后的公共画布尺寸（保证谁都不被裁）。 */
export function boundsFor(frames: Frame[], offsets: Map<number, Offset>): Bounds {
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  for (const frame of frames) {
    const offset = offsets.get(frame.index) ?? { dx: 0, dy: 0 };
    minX = Math.min(minX, offset.dx);
    minY = Math.min(minY, offset.dy);
    maxX = Math.max(maxX, frame.canvas.width + offset.dx);
    maxY = Math.max(maxY, frame.canvas.height + offset.dy);
  }
  return {
    minX,
    minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

export function renderAligned(frame: Frame, offset: Offset, bounds: Bounds): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = bounds.width;
  canvas.height = bounds.height;
  const context = canvas.getContext("2d");
  if (context) {
    context.drawImage(frame.canvas, offset.dx - bounds.minX, offset.dy - bounds.minY);
  }
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
