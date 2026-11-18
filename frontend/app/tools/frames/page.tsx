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
  boundsFor,
  canvasToBlob,
  canvasToBytes,
  computeOffsets,
  extractFrames,
  keyOutBackground,
  measureSubject,
  renderAligned,
  type AlignMode,
  type Frame,
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
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [boxes, setBoxes] = useState<Map<number, SubjectBox>>(new Map());
  const [extracting, setExtracting] = useState(false);
  const [progress, setProgress] = useState("");
  const [alignMode, setAlignMode] = useState<AlignMode>("x");
  const [reference, setReference] = useState<number | null>(null);
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

  const offsets = useMemo(() => {
    const basis = reference !== null ? frames : selectedFrames;
    return computeOffsets(basis, boxes, alignMode, reference ?? selectedFrames[0]?.index ?? 0);
  }, [alignMode, boxes, frames, reference, selectedFrames]);

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
    const bounds = boundsFor(basis, shift);
    setSaving(true);
    try {
      const entries: { name: string; data: Uint8Array }[] = [];
      const meta: { index: number; time: number; offsetX: number; offsetY: number }[] = [];
      let cover: Blob | null = null;
      for (let position = 0; position < basis.length; position += 1) {
        const frame = basis[position];
        const offset: Offset = shift.get(frame.index) ?? { dx: 0, dy: 0 };
        const canvas = renderAligned(frame, offset, bounds);
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
              width: bounds.width,
              height: bounds.height,
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
        width: bounds.width,
        height: bounds.height,
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
  const previewBoxes = previewFrames.length > 0 ? boundsFor(previewFrames, offsets) : null;

  return (
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
          <div className="flex justify-center rounded-lg border border-edge/60 bg-black/60 p-1">
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            playsInline
            crossOrigin="anonymous"
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              setDuration(Number.isFinite(video.duration) ? video.duration : 0);
              setWidth(video.videoWidth);
              setHeight(video.videoHeight);
            }}
            className="max-h-60 max-w-full rounded object-contain"
            data-frames-video
          />
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

          <div className="grid max-h-[300px] grid-cols-6 gap-2 overflow-y-auto sm:grid-cols-8 md:grid-cols-10">
            {frames.map((frame) => {
              const active = selected.has(frame.index);
              return (
                <button
                  key={frame.index}
                  type="button"
                  onClick={() => toggleFrame(frame.index)}
                  data-frame-chip={frame.index}
                  data-selected={active ? "1" : "0"}
                  title={`第 ${frame.index + 1} 帧 · ${frame.time.toFixed(2)} 秒`}
                  className={`relative overflow-hidden rounded-md border transition ${
                    active ? "border-accent/70 ring-1 ring-accent/40" : "border-edge/60 opacity-60 hover:opacity-100"
                  }`}
                >
                  <FrameThumb frame={frame} />
                  <span className="absolute inset-x-0 bottom-0 bg-black/55 py-0.5 text-center text-[9px] text-white/85">
                    {frame.index + 1}
                  </span>
                  {active ? (
                    <span className="absolute right-1 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-[9px] text-black">
                      ✓
                    </span>
                  ) : null}
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

          {previewBoxes && previewFrames.length > 0 ? (
            <div className="flex flex-wrap items-end gap-3">
              {previewFrames.map((frame) => {
                const offset = offsets.get(frame.index) ?? { dx: 0, dy: 0 };
                return (
                  <div key={frame.index} className="flex flex-col items-center gap-1">
                    <div className="relative overflow-hidden rounded-md border border-edge/60 bg-[#0b0d10]">
                      <AlignedThumb frame={frame} offset={offset} bounds={previewBoxes} />
                      <span className="pointer-events-none absolute inset-x-4 top-1/2 h-px bg-accent/50" />
                      <span className="pointer-events-none absolute inset-y-2 left-1/2 w-px bg-warn/40" />
                    </div>
                    <span className="text-[9px] text-muted" data-offset-label={frame.index}>
                      {offset.dx >= 0 ? `+${offset.dx}` : offset.dx} / {offset.dy >= 0 ? `+${offset.dy}` : offset.dy}
                    </span>
                  </div>
                );
              })}
              <p className="max-w-[260px] text-[10px] leading-relaxed text-muted">
                预览里的横线是参考帧的质心高度、竖线是脚底线；数字是这一帧被平移的像素（x / y）。
              </p>
            </div>
          ) : null}
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
  );
}

function FrameThumb({ frame }: { frame: Frame }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const size = 96;
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, size, size);
    const scale = Math.min(size / frame.canvas.width, size / frame.canvas.height);
    const drawWidth = frame.canvas.width * scale;
    const drawHeight = frame.canvas.height * scale;
    context.drawImage(frame.canvas, (size - drawWidth) / 2, (size - drawHeight) / 2, drawWidth, drawHeight);
  }, [frame]);
  return <canvas ref={ref} className="block h-[72px] w-full bg-[#0b0d10] object-cover" />;
}

function AlignedThumb({ frame, offset, bounds }: { frame: Frame; offset: Offset; bounds: ReturnType<typeof boundsFor> }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const size = 112;
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, size, size);
    const scale = Math.min(size / bounds.width, size / bounds.height);
    context.save();
    context.translate((size - bounds.width * scale) / 2, (size - bounds.height * scale) / 2);
    context.scale(scale, scale);
    context.drawImage(frame.canvas, offset.dx - bounds.minX, offset.dy - bounds.minY);
    context.restore();
  }, [bounds, frame, offset]);
  return <canvas ref={ref} className="block h-[112px] w-[112px]" />;
}
