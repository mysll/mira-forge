"use client";

// 抽帧台：把一段视频按固定帧率抽成序列帧，可选抠背景与「锁水平 / 锁垂直」对齐，
// 最后导成一个 ZIP 存进资产库（media_type=frameset，卡片上带「N 帧」角标）。
// 不与「图片编辑」共用输入：编辑是在已有图上改，抽帧是从视频里取。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import ImagePicker from "@/components/ImagePicker";
import ProjectSwitcher from "@/components/ProjectSwitcher";
import ToastStack, { type ToastItem } from "@/components/ToastStack";
import { imageFileUrl, saveFrameSet } from "@/lib/api";
import {
  canvasToBlob,
  canvasToBytes,
  computeOffsets,
  createLayout,
  extractFrames,
  keyOutBackground,
  measureSubject,
  renderInLayout,
  type AlignMode,
  type Frame,
  type Layout,
  type Offset,
  type SubjectBox,
} from "@/lib/frames";
import { createZip } from "@/lib/zip";
import type { ImageBrief } from "@/types/api";

const ALIGN_MODES: { value: AlignMode; label: string; hint: string }[] = [
  { value: "none", label: "不对齐", hint: "原样导出，帧与帧之间的抖动保留" },
  { value: "x", label: "锁水平", hint: "按主体质心对齐横轴，脚底下不动" },
  { value: "y", label: "锁垂直", hint: "按脚底线对齐纵轴，人不会越走越高" },
  { value: "both", label: "都锁", hint: "横竖都钉住，动作最大的帧会被整体平移" },
];

function numberOr(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default function FramesPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLCanvasElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoName, setVideoName] = useState("");
  const [videoId, setVideoId] = useState<number | undefined>(undefined);
  const [duration, setDuration] = useState(0);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [picking, setPicking] = useState(false);

  const [fps, setFps] = useState("24");
  const [start, setStart] = useState("0");
  const [limit, setLimit] = useState("120");
  const [keying, setKeying] = useState(false);
  const [tolerance, setTolerance] = useState(48);

  const [frames, setFrames] = useState<Frame[]>([]);
  // 剪辑软件那种轨道：鼠标停在哪一帧，上面的大画面就显示哪一帧
  const [hovered, setHovered] = useState<number | null>(null);
  // 视频里人往往只占一小块，默认裁到主体看，大画面才看得出动作细节
  const [zoomSubject, setZoomSubject] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [boxes, setBoxes] = useState<Map<number, SubjectBox>>(new Map());
  const [extracting, setExtracting] = useState(false);
  const [progress, setProgress] = useState("");
  const [alignMode, setAlignMode] = useState<AlignMode>("x");
  const [reference, setReference] = useState<number | null>(null);
  // 输出画布：游戏里要的是固定尺寸的贴图，所以默认把主体缩到 256 高、脚底留 4px。
  const [outputHeight, setOutputHeight] = useState("256");
  const [bottomPad, setBottomPad] = useState("4");
  const [sidePad, setSidePad] = useState("8");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((text: string) => {
    setToasts((current) => [...current, { id: Date.now() + Math.random(), text }]);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  useEffect(() => {
    return () => {
      if (videoUrl?.startsWith("blob:")) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const resetFrames = () => {
    setFrames([]);
    setHovered(null);
    setSelected(new Set());
    setBoxes(new Map());
    setReference(null);
    setProgress("");
  };

  const attachVideo = (url: string, label: string, id?: number) => {
    if (videoUrl?.startsWith("blob:") && videoUrl !== url) URL.revokeObjectURL(videoUrl);
    resetFrames();
    setVideoId(id);
    setVideoName(label);
    setVideoUrl(url);
    setName((current) => current || label.replace(/\.[^.]+$/, ""));
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    attachVideo(URL.createObjectURL(file), file.name);
  };

  const onPickVideo = (image: ImageBrief) => {
    attachVideo(imageFileUrl(image), image.label || `视频 #${image.id}`, image.id);
    setPicking(false);
  };

  const selectedFrames = useMemo(
    () => frames.filter((frame) => selected.has(frame.index)),
    [frames, selected],
  );

  // 大画面里正在看的那一帧：优先鼠标悬停的，其次第一张选中的。
  const previewFrame = useMemo(() => {
    if (hovered !== null) {
      const found = frames.find((frame) => frame.index === hovered);
      if (found) return found;
    }
    return selectedFrames[0] ?? frames[0] ?? null;
  }, [frames, hovered, selectedFrames]);

  useEffect(() => {
    const canvas = stageRef.current;
    if (!canvas) return;
    if (!previewFrame) {
      canvas.width = 1;
      canvas.height = 1;
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    const box = zoomSubject ? boxes.get(previewFrame.index) : undefined;
    if (box) {
      // 主体框外留一圈余量，动作幅度大时不会被裁掉
      const padX = Math.max(8, Math.round(box.width * 0.18));
      const padY = Math.max(8, Math.round(box.height * 0.12));
      const left = Math.max(0, box.left - padX);
      const top = Math.max(0, box.top - padY);
      const right = Math.min(previewFrame.canvas.width, box.right + padX);
      const bottom = Math.min(previewFrame.canvas.height, box.bottom + padY);
      const cropWidth = Math.max(1, right - left);
      const cropHeight = Math.max(1, bottom - top);
      canvas.width = cropWidth;
      canvas.height = cropHeight;
      context.clearRect(0, 0, cropWidth, cropHeight);
      context.drawImage(previewFrame.canvas, left, top, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
      return;
    }
    canvas.width = previewFrame.canvas.width;
    canvas.height = previewFrame.canvas.height;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(previewFrame.canvas, 0, 0);
  }, [boxes, previewFrame, zoomSubject]);

  const offsets = useMemo(() => {
    const basis = reference !== null ? frames : selectedFrames;
    return computeOffsets(basis, boxes, alignMode, reference ?? selectedFrames[0]?.index ?? 0);
  }, [alignMode, boxes, frames, reference, selectedFrames]);

  const layoutOptions = useMemo(() => {
    return {
      height: outputHeight.trim() === "" ? null : Math.max(16, Math.round(numberOr(outputHeight, 256))),
      bottomPad: Math.max(0, Math.round(numberOr(bottomPad, 4))),
      sidePad: Math.max(0, Math.round(numberOr(sidePad, 8))),
      topPad: 0,
    };
  }, [bottomPad, outputHeight, sidePad]);

  const layout = useMemo(
    () => createLayout(selectedFrames, boxes, offsets, layoutOptions),
    [boxes, layoutOptions, offsets, selectedFrames],
  );

  const runExtract = async () => {
    const video = videoRef.current;
    if (!video || !videoUrl) {
      toast("先挑一段视频");
      return;
    }
    setExtracting(true);
    setProgress("准备抽帧…");
    try {
      // 先按需抠背景（逐帧处理，抽完即可见），再量主体框
      const extracted = await extractFrames(video, {
        fps: numberOr(fps, 24),
        start: numberOr(start, 0),
        limit: numberOr(limit, 120),
        onProgress: (done, total) => setProgress(`抽帧中 ${done}/${total}`),
      });
      if (keying) {
        for (const frame of extracted) {
          keyOutBackground(frame.canvas, tolerance);
        }
      }
      const measured = new Map<number, SubjectBox>();
      for (const frame of extracted) {
        measured.set(frame.index, measureSubject(frame.canvas));
      }
      setFrames(extracted);
      setBoxes(measured);
      setSelected(new Set(extracted.map((frame) => frame.index)));
      setReference(extracted[0]?.index ?? null);
      setProgress(
        `抽到 ${extracted.length} 帧${keying ? "，已抠背景" : ""}${extracted.length < numberOr(limit, 120) ? "（到底了）" : ""}`,
      );
    } catch (error) {
      toast((error as Error).message || "抽帧失败");
      setProgress("");
    } finally {
      setExtracting(false);
    }
  };

  const toggleFrame = (index: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const exportAndSave = async () => {
    if (selectedFrames.length === 0) {
      toast("一帧都没选");
      return;
    }
    const label = name.trim();
    if (!label) {
      toast("给这个帧集起个名字");
      return;
    }
    const basis = frames.filter((frame) => selected.has(frame.index));
    const referenceIndex = reference ?? basis[0]?.index ?? 0;
    const shift = computeOffsets(basis, boxes, alignMode, referenceIndex);
    // 导出用同一套布局参数（basis 与 selectedFrames 是同一批帧，偏移也一样）
    const frameLayout = createLayout(basis, boxes, shift, layoutOptions);
    setSaving(true);
    try {
      const entries: { name: string; data: Uint8Array }[] = [];
      const meta: { index: number; time: number; offsetX: number; offsetY: number }[] = [];
      let cover: Blob | null = null;
      for (let position = 0; position < basis.length; position += 1) {
        const frame = basis[position];
        const offset: Offset = shift.get(frame.index) ?? { dx: 0, dy: 0 };
        const canvas = renderInLayout(frame, offset, frameLayout);
        entries.push({
          name: `frames/${String(position + 1).padStart(4, "0")}.png`,
          data: await canvasToBytes(canvas),
        });
        meta.push({ index: position + 1, time: Number(frame.time.toFixed(3)), offsetX: offset.dx, offsetY: offset.dy });
        // 封面用「未对齐」的第一帧：对齐后的画布比原帧大，透明边压成 JPEG 会发黑。
        if (position === 0) cover = await canvasToBlob(frame.canvas);
      }
      entries.push({
        name: "frames.json",
        data: new TextEncoder().encode(
          JSON.stringify(
            {
              name: label,
              fps: numberOr(fps, 24),
              width: frameLayout.width,
              height: frameLayout.height,
              align: alignMode,
              keying,
              tolerance: keying ? tolerance : null,
              source: videoName || null,
              frames: meta,
            },
            null,
            2,
          ),
        ),
      });
      if (!cover) throw new Error("导不出封面帧");
      const bundle = createZip(entries);
      const saved = await saveFrameSet({
        bundle,
        cover,
        name: label,
        count: basis.length,
        width: frameLayout.width,
        height: frameLayout.height,
        fps: numberOr(fps, 24),
        sourceVideoId: videoId,
      });
      toast(`已存成帧集「${saved.name}」· ${saved.frame_count} 帧`);
    } catch (error) {
      toast((error as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const previewFrames = selectedFrames.slice(0, 8);

  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 px-4 py-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">抽帧台</h1>
          <p className="mt-0.5 text-[11px] text-muted">
            从一段视频里抽序列帧，可选抠背景与锁水平 / 锁垂直对齐，导出成一个「帧集」存进资产
          </p>
        </div>
        <ProjectSwitcher />
      </header>

      <section className="panel flex flex-col gap-3 p-4" data-frames-source>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="rounded-lg border border-edge bg-surface2 px-3 py-1.5 text-xs text-ink transition hover:border-accent/50"
          >
            从资产选视频
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded-lg border border-edge bg-surface2 px-3 py-1.5 text-xs text-ink transition hover:border-accent/50"
          >
            本机文件
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(event) => {
              onFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <span className="text-[11px] text-muted" data-frames-video-name>
            {videoName || "还没选视频"}
          </span>
          {duration > 0 ? (
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-muted">
              {duration.toFixed(2)} 秒 · {width}×{height}
            </span>
          ) : null}
        </div>

        {videoUrl ? (
          <div
            className="relative flex w-full items-center justify-center overflow-hidden rounded-lg border border-edge/60"
            style={{
              height: "min(46vh, 380px)",
              // 透明处给棋盘格，抠背景以后才能一眼看出抠没抠干净
              backgroundImage: "repeating-conic-gradient(#15181e 0% 25%, #0e1015 0% 50%)",
              backgroundSize: "18px 18px",
            }}
            data-frames-stage
          >
            {/* 没抽帧时它就是播放器；抽完帧就退成取帧的源，把画面让给预览 canvas */}
            <video
              ref={videoRef}
              src={videoUrl}
              controls={frames.length === 0}
              playsInline
              crossOrigin="anonymous"
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                setDuration(Number.isFinite(video.duration) ? video.duration : 0);
                setWidth(video.videoWidth);
                setHeight(video.videoHeight);
              }}
              className={`h-full w-full object-contain ${frames.length > 0 ? "pointer-events-none opacity-0" : ""}`}
              data-frames-video
            />
            {frames.length > 0 ? (
              <canvas
                ref={stageRef}
                className="pointer-events-none absolute inset-0 m-auto h-auto w-auto max-h-full max-w-full object-contain"
                data-frames-preview
              />
            ) : null}
            {frames.length > 0 ? (
              <div className="absolute right-2 top-2 flex gap-1 rounded-md bg-black/45 p-0.5" data-frames-zoom>
                {[
                  { value: true, label: "看主体" },
                  { value: false, label: "整幅" },
                ].map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => setZoomSubject(option.value)}
                    data-zoom-mode={option.value ? "subject" : "frame"}
                    className={`rounded px-2 py-0.5 text-[10px] transition ${
                      zoomSubject === option.value ? "bg-accent/25 text-accentSoft" : "text-white/70 hover:text-white"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
            {frames.length > 0 ? (
              <span
                className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/65 px-2 py-1 text-[10px] text-white/85"
                data-frames-preview-label
              >
                {hovered !== null && previewFrame
                  ? `第 ${previewFrame.index + 1} 帧 · ${previewFrame.time.toFixed(3)} 秒`
                  : previewFrame
                    ? `第 ${previewFrame.index + 1} 帧（悬停帧条可逐帧看）`
                    : "把鼠标移到帧条上预览"}
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            帧率
            <input
              value={fps}
              onChange={(event) => setFps(event.target.value)}
              inputMode="numeric"
              className="w-16 rounded border border-edge bg-surface2 px-2 py-1 text-xs text-ink"
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
              className="w-20 rounded border border-edge bg-surface2 px-2 py-1 text-xs text-ink"
              aria-label="最多抽多少帧"
            />
          </label>
          <label className="flex items-center gap-2 text-[11px] text-muted" data-frames-keying>
            <input
              type="checkbox"
              checked={keying}
              onChange={(event) => setKeying(event.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--accent,#7c9cff)]"
            />
            抠背景
          </label>
          {keying ? (
            <label className="flex items-center gap-2 text-[11px] text-muted">
              容差
              <input
                type="range"
                min={0}
                max={96}
                value={tolerance}
                onChange={(event) => setTolerance(Number(event.target.value))}
                className="w-32 accent-[var(--accent,#7c9cff)]"
                aria-label="抠背景容差"
              />
              <span className="w-6 text-right text-ink">{tolerance}</span>
            </label>
          ) : null}
          <button
            type="button"
            onClick={() => void runExtract()}
            disabled={!videoUrl || extracting}
            className="rounded-lg border border-accent/50 bg-accent/15 px-3 py-1.5 text-xs font-medium text-accentSoft transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {extracting ? "抽帧中…" : "抽帧"}
          </button>
          <span className="text-[11px] text-muted" data-frames-progress>
            {progress}
          </span>
        </div>
      </section>

      {frames.length > 0 ? (
        <section className="panel flex flex-col gap-3 p-4" data-frames-strip>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xs font-medium text-ink">帧条</h2>
            <span className="text-[10px] text-muted/70">悬停看大图 · 点击选中</span>
            <span className="text-[11px] text-muted" data-frames-count>
              已选 {selected.size} / 共 {frames.length}
            </span>
            <button
              type="button"
              onClick={() => setSelected(new Set(frames.map((frame) => frame.index)))}
              className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted transition hover:text-ink"
            >
              全选
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted transition hover:text-ink"
            >
              全不选
            </button>
            <button
              type="button"
              onClick={() =>
                setSelected((current) => {
                  const next = new Set<number>();
                  for (const frame of frames) if (!current.has(frame.index)) next.add(frame.index);
                  return next;
                })
              }
              className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted transition hover:text-ink"
            >
              反选
            </button>
          </div>

          {/* 剪辑软件式的轨道：横向一条，格子够大能看清动作，悬停时上面的大画面同步预览 */}
          <div
            className="scroll-thin flex gap-2 overflow-x-auto pb-2"
            data-frames-track
            onMouseLeave={() => setHovered(null)}
          >
            {frames.map((frame) => {
              const active = selected.has(frame.index);
              const peeking = hovered === frame.index;
              return (
                <button
                  key={frame.index}
                  type="button"
                  onClick={() => toggleFrame(frame.index)}
                  onMouseEnter={() => setHovered(frame.index)}
                  onFocus={() => setHovered(frame.index)}
                  data-frame-chip={frame.index}
                  data-selected={active ? "1" : "0"}
                  title={`第 ${frame.index + 1} 帧 · ${frame.time.toFixed(3)} 秒（点击选中 / 取消）`}
                  className={`relative w-[116px] shrink-0 overflow-hidden rounded-md border transition ${
                    peeking
                      ? "border-accent/80 ring-1 ring-accent/50"
                      : active
                        ? "border-accent/60"
                        : "border-edge/60 opacity-75 hover:opacity-100"
                  }`}
                >
                  <FrameThumb frame={frame} box={zoomSubject ? boxes.get(frame.index) : undefined} />
                  <span className="absolute left-1 top-1 rounded bg-black/65 px-1 text-[9px] text-white/85">
                    {frame.index + 1}
                  </span>
                  {active ? (
                    <span className="absolute right-1 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-[9px] text-black">
                      ✓
                    </span>
                  ) : null}
                  <span className="absolute inset-x-0 bottom-0 bg-black/60 py-0.5 text-center text-[9px] text-white/80">
                    {frame.time.toFixed(2)}s
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {frames.length > 0 ? (
        <section className="panel flex flex-col gap-3 p-4" data-frames-align>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xs font-medium text-ink">对齐</h2>
            {ALIGN_MODES.map((option) => (
              <label
                key={option.value}
                className="flex items-center gap-1.5 text-[11px] text-muted"
                title={option.hint}
              >
                <input
                  type="radio"
                  name="align-mode"
                  value={option.value}
                  checked={alignMode === option.value}
                  onChange={() => setAlignMode(option.value)}
                  data-align-mode={option.value}
                  className="h-3 w-3 accent-[var(--accent,#7c9cff)]"
                />
                {option.label}
              </label>
            ))}
            <label className="flex items-center gap-2 text-[11px] text-muted">
              参考帧
              <select
                value={reference ?? ""}
                onChange={(event) => setReference(event.target.value ? Number(event.target.value) : null)}
                className="rounded border border-edge bg-surface2 px-2 py-1 text-xs text-ink"
                aria-label="参考帧"
              >
                {selectedFrames.map((frame) => (
                  <option key={frame.index} value={frame.index}>
                    第 {frame.index + 1} 帧
                  </option>
                ))}
              </select>
            </label>
          </div>

          {previewFrames.length > 0 ? (
            <div className="flex flex-wrap items-end gap-3">
              {previewFrames.map((frame) => {
                const offset = offsets.get(frame.index) ?? { dx: 0, dy: 0 };
                return (
                  <div key={frame.index} className="flex flex-col items-center gap-1">
                    <div className="relative overflow-hidden rounded-md border border-edge/60 bg-[#0b0d10]">
                      <AlignedThumb frame={frame} offset={offset} layout={layout} />
                    </div>
                    <span className="text-[9px] text-muted" data-offset-label={frame.index}>
                      {offset.dx >= 0 ? `+${offset.dx}` : offset.dx} / {offset.dy >= 0 ? `+${offset.dy}` : offset.dy}
                    </span>
                  </div>
                );
              })}
              <p className="max-w-[260px] text-[10px] leading-relaxed text-muted">
                预览用的是导出那套画布：虚线是脚底线，对齐后每帧都踩在同一高度；数字是这一帧被平移的像素（x / y）。
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      {frames.length > 0 ? (
        <section className="panel flex flex-col gap-3 p-4" data-frames-layout>
          <div className="flex flex-wrap items-end gap-3">
            <h2 className="text-xs font-medium text-ink">输出画布</h2>
            <label className="flex flex-col gap-1 text-[11px] text-muted">
              高度（留空 = 跟主体框）
              <input
                value={outputHeight}
                onChange={(event) => setOutputHeight(event.target.value)}
                inputMode="numeric"
                placeholder="自动"
                aria-label="输出高度"
                className="w-24 rounded border border-edge bg-surface2 px-2 py-1 text-xs text-ink"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted">
              底边留白
              <input
                value={bottomPad}
                onChange={(event) => setBottomPad(event.target.value)}
                inputMode="numeric"
                aria-label="底边留白"
                className="w-20 rounded border border-edge bg-surface2 px-2 py-1 text-xs text-ink"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted">
              左右留白
              <input
                value={sidePad}
                onChange={(event) => setSidePad(event.target.value)}
                inputMode="numeric"
                aria-label="左右留白"
                className="w-20 rounded border border-edge bg-surface2 px-2 py-1 text-xs text-ink"
              />
            </label>
            <span
              className="rounded-md border border-edge/60 bg-surface2 px-2 py-1 font-mono text-[11px] text-accentSoft"
              data-frames-layout-size
            >
              {layout.width} × {layout.height}
            </span>
          </div>
          <p className="text-[10px] leading-relaxed text-muted">
            每帧都缩放进同一张画布（主体并集框 + 对齐偏移），游戏里可以直接当贴图用：高度决定人物多大，
            底边留白是脚底到画布底的距离，左右留白跟着高度等比走。
          </p>
        </section>
      ) : null}

      <section className="panel flex flex-wrap items-end gap-3 p-4">
        <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-[11px] text-muted">
          帧集名字
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            placeholder="例如 走路 8 帧"
            className="rounded border border-edge bg-surface2 px-2 py-1.5 text-xs text-ink"
            aria-label="帧集名字"
          />
        </label>
        <button
          type="button"
          onClick={() => void exportAndSave()}
          disabled={saving || selectedFrames.length === 0}
          data-frames-export
          className="rounded-lg border border-accent/50 bg-accent/15 px-3 py-1.5 text-xs font-medium text-accentSoft transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "打包中…" : `导出并保存（${selectedFrames.length} 帧）`}
        </button>
        <p className="w-full text-[10px] leading-relaxed text-muted">
          ZIP 里是 <code className="text-ink/80">frames/0001.png…</code> 与{" "}
          <code className="text-ink/80">frames.json</code>（每帧的时间与偏移），封面取第一张选中帧。
        </p>
      </section>

      <ImagePicker
        open={picking}
        kind="video"
        title="选择视频"
        hint="抽帧的源视频：优先用视频工作台生成的片段"
        onClose={() => setPicking(false)}
        onPick={onPickVideo}
      />

        <ToastStack items={toasts} onDismiss={dismissToast} />
      </div>
    </div>
  );
}

function FrameThumb({ frame, box }: { frame: Frame; box?: SubjectBox }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const boxWidth = 116;
    const boxHeight = 76;
    canvas.width = boxWidth;
    canvas.height = boxHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, boxWidth, boxHeight);
    // 源视频里人往往只占中间一小条，缩略图跟着裁到主体，才看得出这一帧在做什么
    if (box) {
      const padX = Math.max(8, Math.round(box.width * 0.18));
      const padY = Math.max(8, Math.round(box.height * 0.12));
      const left = Math.max(0, box.left - padX);
      const top = Math.max(0, box.top - padY);
      const right = Math.min(frame.canvas.width, box.right + padX);
      const bottom = Math.min(frame.canvas.height, box.bottom + padY);
      const cropWidth = Math.max(1, right - left);
      const cropHeight = Math.max(1, bottom - top);
      const scale = Math.min(boxWidth / cropWidth, boxHeight / cropHeight);
      const drawWidth = cropWidth * scale;
      const drawHeight = cropHeight * scale;
      context.drawImage(
        frame.canvas,
        left,
        top,
        cropWidth,
        cropHeight,
        (boxWidth - drawWidth) / 2,
        (boxHeight - drawHeight) / 2,
        drawWidth,
        drawHeight,
      );
      return;
    }
    const scale = Math.min(boxWidth / frame.canvas.width, boxHeight / frame.canvas.height);
    const drawWidth = frame.canvas.width * scale;
    const drawHeight = frame.canvas.height * scale;
    context.drawImage(frame.canvas, (boxWidth - drawWidth) / 2, (boxHeight - drawHeight) / 2, drawWidth, drawHeight);
  }, [box, frame]);
  return <canvas ref={ref} className="block h-[76px] w-full bg-[#0b0d10]" />;
}

function AlignedThumb({ frame, offset, layout }: { frame: Frame; offset: Offset; layout: Layout }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    // 直接用导出的同一套布局画，所见即所得（画布可能不是正方形）
    const rendered = renderInLayout(frame, offset, layout);
    canvas.width = rendered.width;
    canvas.height = rendered.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(rendered, 0, 0);
    // 脚底线：每帧都该踩在这条线上，一眼就能看出对齐有没有生效
    context.save();
    context.strokeStyle = "rgba(124, 156, 255, 0.75)";
    context.setLineDash([4, 3]);
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, layout.baseline + 0.5);
    context.lineTo(canvas.width, layout.baseline + 0.5);
    context.stroke();
    context.restore();
  }, [frame, layout, offset]);
  return <canvas ref={ref} className="block max-h-[96px] max-w-[96px]" />;
}
