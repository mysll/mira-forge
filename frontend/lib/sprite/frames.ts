/**
 * 视频 → 序列帧，以及「抠掉纯色背景」这一步。
 *
 * 抽帧用 <video> + seek：每帧 seek 到目标时间再 drawImage。
 * 好处是纯前端、不依赖 WebCodecs 的编解码差异；代价是比解码流慢一点，
 * 但 3–5 秒的视频一般 10–20 秒内能抽完，而且能随时取消。
 */

export type ExtractedFrame = {
  id: string;
  time: number;
  canvas: HTMLCanvasElement;
};

export type VideoSource = {
  url: string;
  video: HTMLVideoElement;
  width: number;
  height: number;
  duration: number;
};

function once(target: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      target.removeEventListener(event, done);
      target.removeEventListener("error", fail);
      resolve();
    };
    const fail = () => {
      target.removeEventListener(event, done);
      target.removeEventListener("error", fail);
      reject(new Error("视频解码失败，可能是浏览器不支持这个编码（试试 H.264 的 mp4）"));
    };
    target.addEventListener(event, done, { once: true });
    target.addEventListener("error", fail, { once: true });
  });
}

export async function loadVideo(file: Blob): Promise<VideoSource> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";

  if (video.readyState < 1) {
    await once(video, "loadedmetadata");
  }
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (!duration) {
    URL.revokeObjectURL(url);
    throw new Error("读不到视频时长，这个文件可能不是视频");
  }
  return { url, video, width: video.videoWidth, height: video.videoHeight, duration };
}

export function disposeVideo(source: VideoSource) {
  source.video.removeAttribute("src");
  source.video.load();
  URL.revokeObjectURL(source.url);
}

/** 建议的抽帧数：按 fps 算，但不超过上限，也不少于 1。 */
export function frameCountFor(duration: number, fps: number, maxFrames: number): number {
  return Math.max(1, Math.min(maxFrames, Math.round(duration * Math.max(0.5, fps))));
}

export type ExtractOptions = {
  fps: number;
  count: number;
  maxEdge?: number;
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
};

export async function extractFrames(
  source: VideoSource,
  options: ExtractOptions,
): Promise<ExtractedFrame[]> {
  const { fps, count, maxEdge = 1024, onProgress, isCancelled } = options;
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const step = 1 / Math.max(0.5, fps);
  const frames: ExtractedFrame[] = [];

  for (let index = 0; index < count; index += 1) {
    if (isCancelled?.()) break;
    const time = Math.min(index * step, Math.max(0, source.duration - 0.001));
    if (Math.abs(source.video.currentTime - time) > 0.001) {
      source.video.currentTime = time;
      await once(source.video, "seeked");
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context) {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(source.video, 0, 0, width, height);
    }
    frames.push({ id: `t${index}-${Math.round(time * 1000)}`, time, canvas });
    onProgress?.(index + 1, count);
  }

  return frames;
}

function hexToRgb(color: string): [number, number, number] {
  const value = color.replace("#", "").trim();
  const full = value.length === 3 ? value.split("").map((char) => char + char).join("") : value.padEnd(6, "0").slice(0, 6);
  return [parseInt(full.slice(0, 2), 16) || 0, parseInt(full.slice(2, 4), 16) || 0, parseInt(full.slice(4, 6), 16) || 0];
}

/** 从画布左上角/四角采样，猜一个背景色（取中位数，比取众数稳）。 */
export function guessBackgroundColor(canvas: HTMLCanvasElement): string {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return "#000000";
  const { width, height } = canvas;
  const samples: number[][] = [];
  const points = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
    [Math.floor(width / 2), 0],
    [Math.floor(width / 2), height - 1],
  ];
  for (const [x, y] of points) {
    const data = context.getImageData(Math.max(0, x), Math.max(0, y), 1, 1).data;
    samples.push([data[0], data[1], data[2]]);
  }
  const median = (index: number) => {
    const values = samples.map((sample) => sample[index]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  const toHex = (value: number) => Math.round(value).toString(16).padStart(2, "0");
  return `#${toHex(median(0))}${toHex(median(1))}${toHex(median(2))}`;
}

export type KeyOptions = { color: string; tolerance: number; feather: number };

/**
 * 按颜色抠背景：距离 ≤ tolerance 的全透明，再往外 `feather` 像素的过渡带线性降 alpha。
 * 直接改传入的画布（调用方负责拷一份）。
 */
export function keyBackground(canvas: HTMLCanvasElement, options: KeyOptions) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return;
  const { width, height } = canvas;
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  const [kr, kg, kb] = hexToRgb(options.color);
  const tolerance = Math.max(0, options.tolerance);
  const feather = Math.max(0, options.feather);
  const outer = tolerance + feather;

  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const distance = Math.max(
      Math.abs(data[index] - kr),
      Math.abs(data[index + 1] - kg),
      Math.abs(data[index + 2] - kb),
    );
    if (distance <= tolerance) {
      data[index + 3] = 0;
    } else if (feather > 0 && distance < outer) {
      const ratio = (distance - tolerance) / feather;
      data[index + 3] = Math.round(data[index + 3] * Math.min(1, Math.max(0, ratio)));
    }
  }
  context.putImageData(image, 0, 0);
}

export function cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d");
  context?.drawImage(source, 0, 0);
  return canvas;
}

export async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("画布导出失败"))), "image/png");
  });
}

export async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}
