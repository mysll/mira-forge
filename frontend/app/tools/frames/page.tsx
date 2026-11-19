"use client";

// 抽帧台：把一段视频按固定帧率抽成序列帧，可选抠背景，再按「选中顺序 × 步进」给每帧
// 算一个偏移（也可逐帧手动微调，带洋葱皮），最后导成一个 ZIP 存进资产库
// （media_type=frameset，卡片上带「N 帧」角标）。
// 导出画布严格等于源帧尺寸：游戏里要的是一套同尺寸的贴图，缩小或裁到主体都不合适。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import ImagePicker from "@/components/ImagePicker";
import ProjectSwitcher from "@/components/ProjectSwitcher";
import ToastStack, { type ToastItem } from "@/components/ToastStack";
import Link from "next/link";

import { fetchImage, imageFileUrl, saveFrameSet } from "@/lib/api";
import {
  canvasToBlob,
  canvasToBytes,
  extractFrames,
  ghostCanvas,
  keyOutBackground,
  measureSubject,
  renderShifted,
  sampleBackground,
  type Frame,
  type Offset,
  type SubjectBox,
} from "@/lib/frames";
import { createZip, readZip } from "@/lib/zip";
import type { ImageBrief } from "@/types/api";

function numberOr(value: string, fallback: number): number {
  const trimmed = value.trim();
  // 空串不等于 0：Number("") 是 0，会让「最多抽」留空时变成「只抽 1 帧」
  if (trimmed === "") return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
}

type VideoSource = { id: number | null; name: string; url: string };

const THUMB_WIDTH = 116;
const THUMB_HEIGHT = 76;

/** 把一帧按主体框裁一份画进小画布（只为看清动作，不影响导出）。 */
function drawThumb(canvas: HTMLCanvasElement, frame: Frame, box: SubjectBox | undefined) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const source = frame.canvas;
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  let sx = 0;
  let sy = 0;
  let sw = source.width;
  let sh = source.height;
  if (box) {
    const padX = Math.round(box.width * 0.18);
    const padY = Math.round(box.height * 0.12);
    sx = Math.max(0, box.left - padX);
    sy = Math.max(0, box.top - padY);
    sw = Math.min(source.width - sx, box.width + padX * 2);
    sh = Math.min(source.height - sy, box.height + padY * 2);
  }
  const scale = Math.min(width / sw, height / sh);
  const drawWidth = Math.round(sw * scale);
  const drawHeight = Math.round(sh * scale);
  context.drawImage(source, sx, sy, sw, sh, Math.round((width - drawWidth) / 2), Math.round((height - drawHeight) / 2), drawWidth, drawHeight);
}

/** 偏移列表里的小缩略图：光看「第 18 帧」不知道画的是什么。 */
function OffsetThumb({ frame, box }: { frame: Frame; box: SubjectBox | undefined }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (canvas) drawThumb(canvas, frame, box);
  }, [box, frame]);
  return <canvas ref={ref} width={30} height={42} className="rounded-[3px] bg-black/40" aria-hidden />;
}

export default function FramesPage() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [video, setVideo] = useState<VideoSource | null>(null);
  const [picking, setPicking] = useState(false);
  const [fps, setFps] = useState("24");
  const [start, setStart] = useState("0");
  const [limit, setLimit] = useState("");
  const [keying, setKeying] = useState(false);
  const [tolerance, setTolerance] = useState("48");
  const [frames, setFrames] = useState<Frame[]>([]);
  const [boxes, setBoxes] = useState<Map<number, SubjectBox>>(new Map());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // 选中顺序就是步进的依据：第 1 个选中的偏移 0，之后每多一帧再加一个步进
  const [order, setOrder] = useState<number[]>([]);
  // 手动调过的帧（覆盖自动值），键是帧号
  const [offsets, setOffsets] = useState<Map<number, Offset>>(new Map());
  const [stepX, setStepX] = useState("");
  const [stepY, setStepY] = useState("");
  // 不抠背景时，平移留下的缺口用这个纯色填满
  const [fillColor, setFillColor] = useState("#101015");
  const [adjustIndex, setAdjustIndex] = useState<number | null>(null);
  const [onionMode, setOnionMode] = useState<"previous" | "anchor">("previous");
  const [onionAlpha, setOnionAlpha] = useState("35");
  const [hovered, setHovered] = useState<number | null>(null);
  // 预览默认整幅：切到「看主体」才按主体框裁（裁切只影响预览，不影响导出）
  const [zoomSubject, setZoomSubject] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  // 从资产里重新打开的帧集：导出时覆盖这一条，而不是新建一条
  const [editing, setEditing] = useState<{ imageId: number; name: string } | null>(null);
  const [loadingSet, setLoadingSet] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const stageRef = useRef<HTMLCanvasElement | null>(null);
  const adjustCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  const toast = useCallback((text: string) => {
    setToasts((current) => [...current, { id: Date.now() + Math.random(), text }]);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const sourceWidth = frames[0]?.canvas.width ?? 0;
  const sourceHeight = frames[0]?.canvas.height ?? 0;

  const selectedFrames = useMemo(
    () =>
      order
        .map((index) => frames.find((frame) => frame.index === index))
        .filter((frame): frame is Frame => Boolean(frame)),
    [frames, order],
  );

  const autoOffsetFor = useCallback(
    (position: number): Offset => ({
      dx: Math.round(position * numberOr(stepX, 0)),
      dy: Math.round(position * numberOr(stepY, 0)),
    }),
    [stepX, stepY],
  );

  /** 这一帧最终用的偏移：手动调过就用手动的，否则按选中顺序累加步进。 */
  const offsetFor = useCallback(
    (index: number): Offset => {
      const manual = offsets.get(index);
      if (manual) return manual;
      const position = order.indexOf(index);
      return position <= 0 ? { dx: 0, dy: 0 } : autoOffsetFor(position);
    },
    [autoOffsetFor, offsets, order],
  );

  const writeManual = useCallback((index: number, offset: Offset) => {
    setOffsets((current) => {
      const next = new Map(current);
      next.set(index, { dx: Math.round(offset.dx), dy: Math.round(offset.dy) });
      return next;
    });
  }, []);

  const dropManual = useCallback((index: number) => {
    setOffsets((current) => {
      const next = new Map(current);
      next.delete(index);
      return next;
    });
  }, []);

  const resetFrames = useCallback(() => {
    setFrames([]);
    setBoxes(new Map());
    setOrder([]);
    setOffsets(new Map());
    setAdjustIndex(null);
    setHovered(null);
    setProgress(null);
  }, []);

  const useVideo = useCallback(
    (next: VideoSource) => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      if (next.url.startsWith("blob:")) blobUrlRef.current = next.url;
      setVideo(next);
      resetFrames();
      setEditing(null);
      if (!name.trim()) setName(next.name.replace(/\.[^.]+$/, "").slice(0, 40));
    },
    [name, resetFrames],
  );

  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  // 重新打开一包已存的帧集：不抽帧，直接把 ZIP 里的 PNG 拆回时间轴。
  // 打开后可以只调偏移再覆盖保存，「抽帧」这一步是可选的。
  const loadFrameSet = useCallback(
    async (imageId: number) => {
      setLoadingSet(true);
      try {
        const meta = await fetchImage(imageId);
        if (meta.media_type !== "frameset") throw new Error("这个产物不是帧集");
        const response = await fetch(imageFileUrl(meta), { cache: "no-store" });
        if (!response.ok) throw new Error(`取帧集失败（${response.status}）`);
        const entries = await readZip(await response.blob());
        const pngs = entries
          .filter((entry) => /^frames\/.+\.png$/i.test(entry.name))
          .sort((left, right) => left.name.localeCompare(right.name));
        if (pngs.length === 0) throw new Error("这个帧集里没有帧");

        type Manifest = {
          name?: string;
          fps?: number;
          stepX?: number;
          stepY?: number;
          fill?: string;
          frames?: { index: number; time: number; offsetX?: number; offsetY?: number; manual?: boolean }[];
        };
        const manifestEntry = entries.find((entry) => entry.name === "frames.json");
        let manifest: Manifest = {};
        if (manifestEntry) {
          try {
            manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data)) as Manifest;
          } catch {
            manifest = {};
          }
        }

        const rate = manifest.fps ?? meta.fps ?? 24;
        const nextFrames: Frame[] = [];
        for (let position = 0; position < pngs.length; position += 1) {
          const bitmap = await createImageBitmap(
            new Blob([pngs[position].data as unknown as BlobPart], { type: "image/png" }),
          );
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
          bitmap.close();
          nextFrames.push({
            index: position,
            time: manifest.frames?.[position]?.time ?? position / rate,
            canvas,
          });
        }

        const nextBoxes = new Map<number, SubjectBox>();
        for (const frame of nextFrames) nextBoxes.set(frame.index, measureSubject(frame.canvas));

        // 上次手动调过的帧原样带回来；没手调过的交给步进重算
        const seeded = new Map<number, Offset>();
        manifest.frames?.forEach((entry, position) => {
          if (!entry.manual) return;
          seeded.set(position, { dx: entry.offsetX ?? 0, dy: entry.offsetY ?? 0 });
        });

        const label = (manifest.name || `帧集 #${imageId}`).slice(0, 60);
        setFrames(nextFrames);
        setBoxes(nextBoxes);
        setOrder(nextFrames.map((frame) => frame.index));
        setOffsets(seeded);
        setAdjustIndex(null);
        setHovered(null);
        setFps(String(Math.round(rate)));
        setStepX(manifest.stepX ? String(manifest.stepX) : "");
        setStepY(manifest.stepY ? String(manifest.stepY) : "");
        setKeying(manifest.fill === "transparent");
        if (manifest.fill && manifest.fill !== "transparent") setFillColor(manifest.fill);
        setName(label);
        setEditing({ imageId, name: label });
        toast(`已载入帧集 #${imageId}（${nextFrames.length} 帧），调好偏移后点「覆盖保存」`);
      } catch (error) {
        toast(error instanceof Error ? error.message : "载入帧集失败");
      } finally {
        setLoadingSet(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    const wanted = Number(new URLSearchParams(window.location.search).get("frameset") ?? "");
    if (!Number.isInteger(wanted) || wanted <= 0) return;
    void loadFrameSet(wanted);
  }, [loadFrameSet]);

  // 资产里的视频在后端（另一个端口），直接当 <video src> 会污染画布、读不了像素，
  // 所以先取回成 Blob 再用同源的 blob: URL 播放。
  const pickAsset = async (image: ImageBrief) => {
    setPicking(false);
    const label = image.label?.trim() || `视频 #${image.id}`;
    try {
      const response = await fetch(imageFileUrl(image), { cache: "no-store" });
      if (!response.ok) throw new Error(`取视频失败（${response.status}）`);
      const blob = await response.blob();
      useVideo({ id: image.id, name: label, url: URL.createObjectURL(blob) });
    } catch (error) {
      toast(error instanceof Error ? error.message : "取视频失败");
    }
  };

  const pickLocal = (file: File) => {
    useVideo({ id: null, name: file.name, url: URL.createObjectURL(file) });
  };

  const runExtract = async () => {
    const element = videoRef.current;
    if (!video) {
      toast("先从资产选一条视频，或者选个本机文件");
      return;
    }
    if (!element || !element.videoWidth) {
      toast("视频还没加载完，稍等一下再抽");
      return;
    }
    const rate = Math.min(60, Math.max(1, Math.round(numberOr(fps, 24))));
    const from = Math.max(0, numberOr(start, 0));
    // 留空 = 抽完整段（交给 extractFrames 按视频长度截断），别当成 0 帧
    const cap = Math.max(1, Math.round(numberOr(limit, 600)));
    const cut = Math.max(0, Math.min(96, numberOr(tolerance, 48)));
    setBusy(true);
    setProgress({ done: 0, total: 0 });
    try {
      const extracted = await extractFrames(element, {
        fps: rate,
        start: from,
        limit: cap,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      if (extracted.length === 0) {
        toast("这段视频没抽到帧");
        return;
      }
      const nextFrames: Frame[] = extracted.map((item) => {
        if (!keying) return item;
        const copy = document.createElement("canvas");
        copy.width = item.canvas.width;
        copy.height = item.canvas.height;
        const context = copy.getContext("2d");
        if (context) {
          context.drawImage(item.canvas, 0, 0);
          keyOutBackground(copy, cut);
        }
        return { index: item.index, time: item.time, canvas: copy };
      });
      const nextBoxes = new Map<number, SubjectBox>();
      for (const frame of nextFrames) nextBoxes.set(frame.index, measureSubject(frame.canvas));
      setFrames(nextFrames);
      setBoxes(nextBoxes);
      setOrder([]);
      setOffsets(new Map());
      setAdjustIndex(null);
      setHovered(null);
      setFillColor(sampleBackground(nextFrames[0].canvas));
      toast(`抽出 ${nextFrames.length} 帧，在下面的时间轴里点选要导出的`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "抽帧失败");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const toggleFrame = (index: number) => {
    setOrder((current) => {
      if (current.includes(index)) return current.filter((value) => value !== index);
      // 补选的帧按帧号插进去：先选了 1/40，再补 12/20，不该永远排在队尾
      return [...current, index].sort((a, b) => a - b);
    });
  };

  /** 挪动某个已选帧的导出位置（它同时决定步进累加的次序）。 */
  const moveInOrder = (index: number, delta: number) => {
    setOrder((current) => {
      const from = current.indexOf(index);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= current.length) return current;
      const next = [...current];
      next[from] = next[to];
      next[to] = index;
      return next;
    });
  };

  const sortOrder = () => setOrder((current) => [...current].sort((a, b) => a - b));

  const previewFrame = useMemo(() => {
    if (hovered !== null) {
      const frame = frames.find((item) => item.index === hovered);
      if (frame) return frame;
    }
    if (selectedFrames.length > 0) return selectedFrames[0];
    return frames[0] ?? null;
  }, [frames, hovered, selectedFrames]);

  useEffect(() => {
    const canvas = stageRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    if (!previewFrame) {
      canvas.width = 16;
      canvas.height = 16;
      return;
    }
    const source = previewFrame.canvas;
    const box = zoomSubject ? boxes.get(previewFrame.index) : undefined;
    let sx = 0;
    let sy = 0;
    let sw = source.width;
    let sh = source.height;
    if (box) {
      const padX = Math.round(box.width * 0.18);
      const padY = Math.round(box.height * 0.12);
      sx = Math.max(0, box.left - padX);
      sy = Math.max(0, box.top - padY);
      sw = Math.min(source.width - sx, box.width + padX * 2);
      sh = Math.min(source.height - sy, box.height + padY * 2);
    }
    canvas.width = sw;
    canvas.height = sh;
    context.clearRect(0, 0, sw, sh);
    context.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  }, [boxes, previewFrame, zoomSubject]);

  const previewLabel = previewFrame
    ? hovered !== null
      ? `第 ${previewFrame.index + 1} 帧 · ${previewFrame.time.toFixed(3)} 秒`
      : `第 ${previewFrame.index + 1} 帧（鼠标移到下面的时间轴上可逐帧看）`
    : "";

  const adjustFrame = adjustIndex === null ? null : frames.find((frame) => frame.index === adjustIndex) ?? null;
  const adjustPosition = adjustIndex === null ? -1 : order.indexOf(adjustIndex);
  const adjustPrevious =
    adjustPosition > 0 ? frames.find((frame) => frame.index === order[adjustPosition - 1]) ?? null : null;
  const adjustAnchor = order.length > 0 ? frames.find((frame) => frame.index === order[0]) ?? null : null;
  const adjustOffset = adjustIndex === null ? { dx: 0, dy: 0 } : offsetFor(adjustIndex);

  useEffect(() => {
    if (!adjustFrame) return;
    const canvas = adjustCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const width = sourceWidth || adjustFrame.canvas.width;
    const height = sourceHeight || adjustFrame.canvas.height;
    canvas.width = width;
    canvas.height = height;
    context.clearRect(0, 0, width, height);
    if (!keying) {
      context.fillStyle = fillColor;
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(adjustFrame.canvas, adjustOffset.dx, adjustOffset.dy);
    const onion = onionMode === "anchor" ? adjustAnchor : adjustPrevious;
    if (onion && onion.index !== adjustFrame.index) {
      const ghost = ghostCanvas(onion);
      const onionOffset = offsetFor(onion.index);
      context.save();
      context.globalAlpha = Math.min(0.9, Math.max(0.1, numberOr(onionAlpha, 35) / 100));
      context.drawImage(ghost, onionOffset.dx, onionOffset.dy);
      context.restore();
    }
  }, [
    adjustAnchor,
    adjustFrame,
    adjustOffset.dx,
    adjustOffset.dy,
    adjustPrevious,
    fillColor,
    keying,
    offsetFor,
    onionAlpha,
    onionMode,
    sourceHeight,
    sourceWidth,
  ]);

  useEffect(() => {
    if (adjustIndex === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAdjustIndex(null);
        return;
      }
      const step = event.shiftKey ? 10 : 1;
      let dx = 0;
      let dy = 0;
      if (event.key === "ArrowLeft") dx = -step;
      else if (event.key === "ArrowRight") dx = step;
      else if (event.key === "ArrowUp") dy = -step;
      else if (event.key === "ArrowDown") dy = step;
      else return;
      event.preventDefault();
      writeManual(adjustIndex, { dx: adjustOffset.dx + dx, dy: adjustOffset.dy + dy });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [adjustIndex, adjustOffset.dx, adjustOffset.dy, writeManual]);

  const startDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (adjustIndex === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, dx: adjustOffset.dx, dy: adjustOffset.dy };
  };

  const moveDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const origin = dragRef.current;
    if (!origin || adjustIndex === null || !adjustFrame) return;
    const scale = adjustFrame.canvas.width / Math.max(1, event.currentTarget.clientWidth);
    writeManual(adjustIndex, {
      dx: origin.dx + Math.round((event.clientX - origin.x) * scale),
      dy: origin.dy + Math.round((event.clientY - origin.y) * scale),
    });
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const alignToPrevious = () => {
    if (adjustIndex === null || !adjustFrame) return;
    if (adjustPosition <= 0 || !adjustPrevious) {
      toast("这是第一个选中的帧，没有可对齐的上一帧");
      return;
    }
    const previousBox = boxes.get(adjustPrevious.index);
    const currentBox = boxes.get(adjustFrame.index);
    if (!previousBox || !currentBox) {
      toast("这两帧量不到主体，先抠背景或换一帧");
      return;
    }
    const previousOffset = offsetFor(adjustPrevious.index);
    const dx = adjustOffset.dx + Math.round(previousBox.centerX + previousOffset.dx - (currentBox.centerX + adjustOffset.dx));
    const dy = adjustOffset.dy + Math.round(previousBox.bottom + previousOffset.dy - (currentBox.bottom + adjustOffset.dy));
    writeManual(adjustFrame.index, { dx, dy });
  };

  const applyDeltaToRest = () => {
    if (adjustIndex === null || !adjustFrame) return;
    const auto = autoOffsetFor(adjustPosition);
    const manual = offsets.get(adjustIndex) ?? adjustOffset;
    const delta = { dx: manual.dx - auto.dx, dy: manual.dy - auto.dy };
    if (delta.dx === 0 && delta.dy === 0) {
      toast("这一帧还是自动值，没有偏差可应用");
      return;
    }
    const rest = order.slice(adjustPosition + 1);
    setOffsets((current) => {
      const next = new Map(current);
      for (const index of rest) {
        const currentOffset = current.get(index) ?? autoOffsetFor(order.indexOf(index));
        next.set(index, { dx: currentOffset.dx + delta.dx, dy: currentOffset.dy + delta.dy });
      }
      return next;
    });
    toast(`把 ${delta.dx >= 0 ? "+" : ""}${delta.dx} / ${delta.dy >= 0 ? "+" : ""}${delta.dy} 应用到后面 ${rest.length} 帧`);
  };

  const exportAndSave = async () => {
    if (order.length === 0) {
      toast("先在上面选要导出的帧");
      return;
    }
    const label = name.trim();
    if (!label) {
      toast("给这个帧集起个名字");
      return;
    }
    const width = sourceWidth;
    const height = sourceHeight;
    if (!width || !height) {
      toast("还没有帧可导出");
      return;
    }
    const fill = keying ? null : fillColor;
    const rate = numberOr(fps, 24);
    setSaving(true);
    try {
      const entries: { name: string; data: Uint8Array }[] = [];
      const meta: { index: number; time: number; offsetX: number; offsetY: number; manual: boolean }[] = [];
      let cover: Blob | null = null;
      for (let position = 0; position < order.length; position += 1) {
        const frame = frames.find((item) => item.index === order[position]);
        if (!frame) continue;
        const offset = offsetFor(frame.index);
        const canvas = renderShifted(frame, offset, { width, height, fill });
        entries.push({ name: `frames/${String(position + 1).padStart(4, "0")}.png`, data: await canvasToBytes(canvas) });
        meta.push({
          index: position + 1,
          time: Number(frame.time.toFixed(3)),
          offsetX: offset.dx,
          offsetY: offset.dy,
          manual: offsets.has(frame.index),
        });
        if (!cover) cover = await canvasToBlob(canvas);
      }
      if (!cover || meta.length === 0) {
        toast("没有可导出的帧");
        return;
      }
      entries.push({
        name: "frames.json",
        data: new TextEncoder().encode(
          JSON.stringify(
            {
              name: label,
              fps: rate,
              width,
              height,
              stepX: numberOr(stepX, 0),
              stepY: numberOr(stepY, 0),
              fill: keying ? "transparent" : fillColor,
              keying,
              tolerance: keying ? numberOr(tolerance, 48) : null,
              source: video?.name ?? null,
              frames: meta,
            },
            null,
            2,
          ),
        ),
      });
      const bundle = createZip(entries);
      const saved = await saveFrameSet({
        bundle,
        cover,
        name: label,
        count: meta.length,
        width,
        height,
        fps: rate,
        sourceVideoId: video?.id ?? undefined,
        replaceImageId: editing?.imageId,
      });
      toast(
        editing
          ? `已覆盖帧集 #${editing.imageId}（现在 ${saved.frame_count} 帧）`
          : `已存成帧集「${saved.name}」· ${saved.frame_count} 帧`,
      );
      if (editing) setEditing({ imageId: saved.image_id, name: saved.name });
      setOrder([]);
      setOffsets(new Map());
      setAdjustIndex(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : "保存帧集失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-edge/70 px-4">
        <ProjectSwitcher />
        <h1 className="text-[13px] font-medium text-ink">抽帧台</h1>
        <span className="text-[11px] text-muted">
          {loadingSet ? "载入帧集…" : "视频 → 序列帧 · 可选抠背景 · 逐帧微调偏移 · 整包存成帧集"}
        </span>
      </header>

      <div className="scroll-thin flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 px-4 py-5">
          {editing ? (
            <section
              className="panel flex flex-wrap items-center gap-2 border-accent/40 p-3"
              data-frameset-banner
              data-frameset-id={editing.imageId}
            >
              <span className="text-[11px] text-ink">正在编辑帧集 #{editing.imageId} · {editing.name}</span>
              <span className="text-[11px] text-muted">
                偏移调好点「覆盖保存」会写回这一条并换掉 ZIP；想另存一份就先选个视频重新抽帧。
              </span>
              <Link
                href="/gallery"
                className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted transition hover:border-accent/60 hover:text-ink"
              >
                回资产页
              </Link>
            </section>
          ) : null}
          <section className="panel flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xs font-medium text-ink">视频</h2>
              <button
                type="button"
                onClick={() => setPicking(true)}
                className="rounded border border-edge px-2 py-1 text-[11px] text-muted transition hover:border-accent/60 hover:text-ink"
              >
                从资产选
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="rounded border border-edge px-2 py-1 text-[11px] text-muted transition hover:border-accent/60 hover:text-ink"
              >
                本机文件
              </button>
              <span className="truncate text-[11px] text-muted">{video ? video.name : "还没有选视频"}</span>
              {frames.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setZoomSubject((current) => !current)}
                  className="ml-auto rounded border border-edge px-2 py-1 text-[11px] text-muted transition hover:border-accent/60 hover:text-ink"
                  title={zoomSubject ? "预览按主体框裁切，点一下恢复整幅" : "预览显示整幅，点一下只放大主体"}
                  data-frames-zoom
                  data-zoom-mode={zoomSubject ? "subject" : "frame"}
                >
                  {zoomSubject ? "看整幅" : "看主体"}
                </button>
              ) : null}
            </div>

            <div
              className="relative flex items-center justify-center rounded-xl border border-edge/60 bg-[#0b0d10] p-2"
              style={{
                minHeight: 220,
                backgroundImage: "repeating-conic-gradient(#15181e 0% 25%, #0e1015 0% 50%)",
                backgroundSize: "18px 18px",
              }}
              data-frames-stage
            >
              <video
                ref={videoRef}
                src={video?.url ?? undefined}
                className={
                  frames.length > 0
                    ? "pointer-events-none absolute h-px w-px opacity-0"
                    : "max-h-[46vh] max-w-full rounded-lg object-contain"
                }
                muted
                playsInline
                preload="metadata"
              />
              {frames.length > 0 ? (
                <canvas ref={stageRef} className="block max-h-[46vh] max-w-full" data-frames-preview />
              ) : (
                <span className="absolute text-[12px] text-muted">
                  {video ? "点下面的「抽帧」把这段视频拆成帧" : "从资产选一条视频，或者选个本机文件"}
                </span>
              )}
              {frames.length > 0 ? (
                <span
                  className="absolute bottom-2 left-3 rounded bg-black/60 px-2 py-0.5 text-[10px] text-white/80"
                  data-frames-preview-label
                >
                  {previewLabel}
                </span>
              ) : null}
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-[11px] text-muted">
                帧率
                <input
                  value={fps}
                  onChange={(event) => setFps(event.target.value)}
                  inputMode="numeric"
                  className="w-20 rounded border border-edge bg-surface2 px-2 py-1 text-xs text-ink"
                  aria-label="帧率"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-muted">
                起始秒
                <input
                  value={start}
                  onChange={(event) => setStart(event.target.value)}
                  inputMode="decimal"
                  className="w-20 rounded border border-edge bg-surface2 px-2 py-1 text-xs text-ink"
                  aria-label="起始秒"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-muted">
                最多抽
                <input
                  value={limit}
                  onChange={(event) => setLimit(event.target.value)}
                  inputMode="numeric"
                  placeholder="全部"
                  className="w-20 rounded border border-edge bg-surface2 px-2 py-1 text-xs text-ink"
                  aria-label="最多抽"
                />
              </label>
              <label className="flex items-center gap-2 pb-1 text-[11px] text-muted">
                <input
                  type="checkbox"
                  checked={keying}
                  onChange={(event) => setKeying(event.target.checked)}
                  aria-label="抠背景"
                />
                抠背景
              </label>
              {keying ? (
                <label className="flex items-center gap-2 pb-1 text-[11px] text-muted">
                  容差
                  <input
                    type="range"
                    min={0}
                    max={96}
                    value={Math.min(96, numberOr(tolerance, 48))}
                    onChange={(event) => setTolerance(event.target.value)}
                    className="w-32 accent-[var(--accent,#7c9cff)]"
                    aria-label="容差"
                  />
                  <span className="w-6 text-right text-ink">{Math.round(numberOr(tolerance, 48))}</span>
                </label>
              ) : null}
              <button
                type="button"
                onClick={() => void runExtract()}
                disabled={busy || !video}
                data-frames-extract
                className="ml-auto rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-accentSoft disabled:opacity-40"
              >
                {busy ? "抽帧中…" : "抽帧"}
              </button>
            </div>
            {progress ? (
              <p className="text-[11px] text-muted">
                已抽 {progress.done} / {progress.total || "?"} 帧
              </p>
            ) : null}
          </section>

          {frames.length > 0 ? (
            <section className="panel flex flex-col gap-2 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xs font-medium text-ink">时间轴</h2>
                <span className="text-[11px] text-muted" data-frames-count>
                  已选 {order.length} / 共 {frames.length}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setOrder(frames.map((frame) => frame.index))}
                    className="rounded border border-edge px-2 py-0.5 text-[10px] text-muted transition hover:border-accent/60 hover:text-ink"
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    onClick={() => setOrder([])}
                    className="rounded border border-edge px-2 py-0.5 text-[10px] text-muted transition hover:border-accent/60 hover:text-ink"
                  >
                    全不选
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setOrder((current) => {
                        const picked = new Set(current);
                        return frames
                          .map((frame) => frame.index)
                          .filter((index) => !picked.has(index));
                      })
                    }
                    className="rounded border border-edge px-2 py-0.5 text-[10px] text-muted transition hover:border-accent/60 hover:text-ink"
                  >
                    反选
                  </button>
                </div>
              </div>
              <div
                className="scroll-thin flex gap-2 overflow-x-auto pb-2"
                data-frames-track
                onMouseLeave={() => setHovered(null)}
              >
                {frames.map((frame) => {
                  const position = order.indexOf(frame.index);
                  const active = position >= 0;
                  return (
                    <FrameChip
                      key={frame.index}
                      frame={frame}
                      box={boxes.get(frame.index)}
                      active={active}
                      position={position}
                      manual={offsets.has(frame.index)}
                      onToggle={() => toggleFrame(frame.index)}
                      onHover={() => setHovered(frame.index)}
                    />
                  );
                })}
              </div>
            </section>
          ) : null}

          {frames.length > 0 ? (
            <section className="panel flex flex-col gap-3 p-4" data-frames-offsets>
              <div className="flex flex-wrap items-end gap-3">
                <h2 className="text-xs font-medium text-ink">偏移</h2>
                <label className="flex flex-col gap-1 text-[11px] text-muted">
                  步进 X（px/帧）
                  <input
                    value={stepX}
                    onChange={(event) => setStepX(event.target.value)}
                    inputMode="numeric"
                    placeholder="0"
                    className="w-20 rounded border border-edge bg-surface2 px-2 py-1 text-xs text-ink"
                    aria-label="步进 X"
                    data-frames-step-x
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-muted">
                  步进 Y（px/帧）
                  <input
                    value={stepY}
                    onChange={(event) => setStepY(event.target.value)}
                    inputMode="numeric"
                    placeholder="0"
                    className="w-20 rounded border border-edge bg-surface2 px-2 py-1 text-xs text-ink"
                    aria-label="步进 Y"
                    data-frames-step-y
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-muted">
                  背景填充
                  <input
                    type="color"
                    value={fillColor}
                    onChange={(event) => setFillColor(event.target.value)}
                    disabled={keying}
                    aria-label="背景填充"
                    data-frames-fill
                    className="h-[26px] w-16 rounded border border-edge bg-surface2 disabled:opacity-40"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setAdjustIndex(order[0] ?? null)}
                  disabled={order.length === 0}
                  data-frames-adjust
                  className="rounded border border-edge px-2 py-1 text-[11px] text-muted transition hover:border-accent/60 hover:text-ink disabled:opacity-40"
                >
                  微调选中帧（{order.length}）
                </button>
                <button
                  type="button"
                  onClick={sortOrder}
                  disabled={order.length < 2}
                  data-frames-sort
                  title="把已选帧按帧号从小到大排（覆盖手动的挪动）"
                  className="rounded border border-edge px-2 py-1 text-[11px] text-muted transition hover:border-accent/60 hover:text-ink disabled:opacity-40"
                >
                  按帧顺序重排
                </button>
              </div>
              <p className="text-[10px] leading-relaxed text-muted">
                步进按列表顺序累加：第 1 个的偏移 0，第 n 个偏移 (n−1) × 步进；手动调过的帧不再被步进覆盖。
                补选的帧会按帧号插进列表，想改导出顺序用每行的 ▲ ▼，或点「按帧顺序重排」还原。
                不抠背景时，平移留下的缺口用上面的颜色填满。画布始终等于源帧尺寸 {sourceWidth} × {sourceHeight}。
              </p>
              {order.length > 0 ? (
                <div className="flex flex-wrap gap-2" data-offset-list>
                  {order.map((index, position) => {
                    const frame = frames.find((item) => item.index === index);
                    if (!frame) return null;
                    const offset = offsetFor(index);
                    return (
                      <div
                        key={index}
                        data-offset-item={index}
                        className="flex items-center gap-1 rounded border border-edge/60 bg-surface2/60 py-1 pl-1 pr-1 text-[10px] text-muted transition hover:border-accent/50"
                      >
                        <button
                          type="button"
                          onClick={() => setAdjustIndex(index)}
                          title={`打开第 ${index + 1} 帧的微调面板`}
                          className="flex items-center gap-2 pr-1 text-left text-muted transition hover:text-ink"
                        >
                          <OffsetThumb frame={frame} box={boxes.get(index)} />
                          <span className="text-ink">#{position + 1}</span>
                          <span>第 {index + 1} 帧</span>
                          <span className="font-mono">
                            {offset.dx >= 0 ? `+${offset.dx}` : offset.dx} / {offset.dy >= 0 ? `+${offset.dy}` : offset.dy}
                          </span>
                          {offsets.has(index) ? (
                            <span className="rounded bg-accent/25 px-1 text-accentSoft">手动</span>
                          ) : null}
                        </button>
                        <span className="flex flex-col overflow-hidden rounded border border-edge/70">
                          <button
                            type="button"
                            onClick={() => moveInOrder(index, -1)}
                            disabled={position === 0}
                            aria-label={`把第 ${index + 1} 帧往前挪`}
                            title="往前挪一位"
                            className="px-1 text-[9px] leading-4 text-muted transition hover:bg-surface hover:text-ink disabled:opacity-30"
                          >
                            ▲
                          </button>
                          <button
                            type="button"
                            onClick={() => moveInOrder(index, 1)}
                            disabled={position === order.length - 1}
                            aria-label={`把第 ${index + 1} 帧往后挪`}
                            title="往后挪一位"
                            className="border-t border-edge/70 px-1 text-[9px] leading-4 text-muted transition hover:bg-surface hover:text-ink disabled:opacity-30"
                          >
                            ▼
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[11px] text-muted">还没选帧：在上面的时间轴里点选要导出的帧（默认不选）。</p>
              )}
            </section>
          ) : null}
          <section className="panel flex flex-wrap items-end gap-3 p-4">
            <label className="flex flex-col gap-1 text-[11px] text-muted">
              帧集名字
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={60}
                placeholder="走路 3 秒"
                aria-label="帧集名字"
                className="w-56 rounded border border-edge bg-surface2 px-2 py-1 text-xs text-ink"
              />
            </label>
            <button
              type="button"
              onClick={() => void exportAndSave()}
              disabled={saving || order.length === 0}
              data-frames-export
              className="rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-accentSoft disabled:opacity-40"
            >
              {saving ? "导出中…" : editing ? `覆盖保存 · ${order.length} 帧` : `导出 ${order.length} 帧并保存`}
            </button>
            <p className="text-[10px] text-muted">
              每一帧按自己的偏移平移，画布恒等于源帧尺寸（{sourceWidth || "?"} × {sourceHeight || "?"}），
              {keying ? "背景透明" : `缺口用 ${fillColor} 填满`}；ZIP 里是 <code>frames/0001.png…</code> 加一份{" "}
              <code>frames.json</code>。
            </p>
          </section>
        </div>
      </div>

      <ImagePicker
        open={picking}
        title="从资产导入视频"
        hint="只列出视频产物，点一下选为取帧源"
        kind="video"
        onClose={() => setPicking(false)}
        onPick={pickAsset}
      />

      <input
        ref={fileRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) pickLocal(file);
          event.target.value = "";
        }}
      />

      {adjustFrame ? (
        <div
          className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-3 overflow-y-auto bg-black/80 p-4 backdrop-blur-sm"
          role="presentation"
          data-adjust-panel
        >
          <div className="panel flex w-full max-w-[820px] flex-col gap-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xs font-medium text-ink">
                微调第 {adjustFrame.index + 1} 帧 · 第 {adjustPosition + 1} / {order.length} 个选中
              </h2>
              <button
                type="button"
                onClick={() => setAdjustIndex(null)}
                className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted transition hover:text-ink"
              >
                关闭
              </button>
            </div>
            <div className="flex items-center justify-center rounded-lg border border-edge/60 bg-[#0b0d10]">
              <canvas
                ref={adjustCanvasRef}
                data-adjust-canvas
                onPointerDown={startDrag}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                className="block max-h-[56vh] max-w-full cursor-move touch-none"
                style={{
                  backgroundImage: "repeating-conic-gradient(#15181e 0% 25%, #0e1015 0% 50%)",
                  backgroundSize: "18px 18px",
                }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-[11px] text-muted">
                洋葱皮
                <select
                  value={onionMode}
                  onChange={(event) => setOnionMode(event.target.value === "anchor" ? "anchor" : "previous")}
                  aria-label="洋葱皮来源"
                  className="rounded border border-edge bg-surface2 px-2 py-1 text-xs text-ink"
                >
                  <option value="previous">上一帧</option>
                  <option value="anchor">第 1 个选中帧</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-[11px] text-muted">
                透明
                <input
                  type="range"
                  min={10}
                  max={90}
                  value={Math.min(90, Math.max(10, numberOr(onionAlpha, 35)))}
                  onChange={(event) => setOnionAlpha(event.target.value)}
                  className="w-28 accent-[var(--accent,#7c9cff)]"
                  aria-label="洋葱皮透明度"
                />
                <span className="w-8 text-right text-ink">{Math.round(numberOr(onionAlpha, 35))}%</span>
              </label>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-[11px] text-muted">
                偏移 X
                <input
                  value={adjustOffset.dx}
                  onChange={(event) => writeManual(adjustFrame.index, { dx: numberOr(event.target.value, 0), dy: adjustOffset.dy })}
                  inputMode="numeric"
                  aria-label="偏移 X"
                  data-adjust-x
                  className="w-20 rounded border border-edge bg-surface2 px-2 py-1 text-xs text-ink"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-muted">
                偏移 Y
                <input
                  value={adjustOffset.dy}
                  onChange={(event) => writeManual(adjustFrame.index, { dx: adjustOffset.dx, dy: numberOr(event.target.value, 0) })}
                  inputMode="numeric"
                  aria-label="偏移 Y"
                  data-adjust-y
                  className="w-20 rounded border border-edge bg-surface2 px-2 py-1 text-xs text-ink"
                />
              </label>
              <button
                type="button"
                onClick={alignToPrevious}
                className="rounded border border-edge px-2 py-1 text-[11px] text-muted transition hover:border-accent/60 hover:text-ink"
              >
                对齐上一帧
              </button>
              <button
                type="button"
                onClick={() => dropManual(adjustFrame.index)}
                className="rounded border border-edge px-2 py-1 text-[11px] text-muted transition hover:border-accent/60 hover:text-ink"
              >
                复位此帧
              </button>
              <button
                type="button"
                onClick={applyDeltaToRest}
                className="rounded border border-edge px-2 py-1 text-[11px] text-muted transition hover:border-accent/60 hover:text-ink"
              >
                Δ 应用到后续帧
              </button>
              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  disabled={adjustPosition <= 0}
                  onClick={() => setAdjustIndex(order[adjustPosition - 1])}
                  className="rounded border border-edge px-2 py-1 text-[11px] text-muted transition hover:border-accent/60 hover:text-ink disabled:opacity-40"
                >
                  上一帧
                </button>
                <button
                  type="button"
                  disabled={adjustPosition >= order.length - 1}
                  onClick={() => setAdjustIndex(order[adjustPosition + 1])}
                  className="rounded border border-edge px-2 py-1 text-[11px] text-muted transition hover:border-accent/60 hover:text-ink disabled:opacity-40"
                >
                  下一帧
                </button>
              </div>
            </div>
            <p className="text-[10px] text-muted">
              拖动画面或用方向键微调（Shift = 10px）；蓝色半透明的是洋葱皮，对上人物就说明这一帧停在同一个位置。
              导出画布 {sourceWidth} × {sourceHeight}。
            </p>
          </div>
        </div>
      ) : null}

      <ToastStack items={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function FrameChip({
  frame,
  box,
  active,
  position,
  manual,
  onToggle,
  onHover,
}: {
  frame: Frame;
  box: SubjectBox | undefined;
  active: boolean;
  position: number;
  manual: boolean;
  onToggle: () => void;
  onHover: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) drawThumb(canvas, frame, box);
  }, [box, frame]);

  return (
    <button
      type="button"
      onClick={onToggle}
      onMouseEnter={onHover}
      onFocus={onHover}
      data-frame-chip={frame.index}
      data-selected={active ? "1" : "0"}
      title={`第 ${frame.index + 1} 帧 · ${frame.time.toFixed(3)} 秒`}
      className={`relative w-[116px] shrink-0 overflow-hidden rounded border transition ${
        active ? "border-accent" : "border-edge/60 hover:border-edge"
      }`}
    >
      <canvas ref={canvasRef} width={THUMB_WIDTH * 2} height={THUMB_HEIGHT * 2} className="block h-[76px] w-[116px]" />
      <span className="absolute left-1 top-1 rounded bg-black/65 px-1 text-[9px] text-white/85">{frame.index + 1}</span>
      {active ? (
        <span className="absolute right-1 top-1 rounded bg-accent px-1 text-[9px] font-medium text-white">{position + 1}</span>
      ) : null}
      {manual ? <span className="absolute right-1 bottom-4 h-1.5 w-1.5 rounded-full bg-accentSoft" /> : null}
      <span className="absolute inset-x-0 bottom-0 bg-black/60 py-0.5 text-[9px] text-white/75">
        {frame.time.toFixed(2)}s
      </span>
    </button>
  );
}
