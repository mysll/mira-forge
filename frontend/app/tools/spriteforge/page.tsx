"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import ImagePicker from "@/components/ImagePicker";
import SlotMenu from "@/components/SlotMenu";
import ToastStack, { type ToastItem } from "@/components/ToastStack";
import { imageAsFile, imageFileUrl, saveAsset } from "@/lib/api";
import {
  buildAtlasJson,
  packFrames,
  parseAtlasJson,
  type AtlasConfig,
  type PackedAtlas,
} from "@/lib/sprite/atlas";
import {
  blobToCanvas,
  canvasToBlob,
  cloneCanvas,
  disposeVideo,
  extractFrames,
  frameCountFor,
  guessBackgroundColor,
  keyBackground,
  loadVideo,
  type ExtractedFrame,
  type VideoSource,
} from "@/lib/sprite/frames";
import { bytesToBlob, createZip, readZip } from "@/lib/sprite/zip";
import type { ImageBrief } from "@/types/api";
import { formatBytes } from "@/lib/date";

type SourceKind = "video" | "atlas";

const MAX_FRAMES = 240;

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
};

const baseName = (name: string) => (name.replace(/\.[^.]+$/, "").replace(/[^\w\u4e00-\u9fa5-]+/g, "_") || "atlas").slice(0, 40);

export default function SpriteForgePage() {
  const queryClient = useQueryClient();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastId = useRef(0);
  const toast = useCallback((text: string) => {
    toastId.current += 1;
    setToasts((list) => [...list, { id: toastId.current, text }]);
  }, []);

  // 输入源
  const [kind, setKind] = useState<SourceKind>("video");
  const [picking, setPicking] = useState<null | "video" | "atlas">(null);
  const [menu, setMenu] = useState<null | "video" | "atlas">(null);
  const [fileName, setFileName] = useState("");
  const videoRef = useRef<VideoSource | null>(null);
  const [videoInfo, setVideoInfo] = useState<{ width: number; height: number; duration: number } | null>(null);
  const [atlasName, setAtlasName] = useState("");

  // 抽帧参数
  const [fps, setFps] = useState(24);
  const [maxFrames, setMaxFrames] = useState(120);
  const [maxEdge, setMaxEdge] = useState(1024);
  const [extracting, setExtracting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const cancelRef = useRef(false);

  // 帧
  const [frames, setFrames] = useState<ExtractedFrame[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 抠背景
  const [keyOn, setKeyOn] = useState(false);
  const [keyColor, setKeyColor] = useState("#00b140");
  const [tolerance, setTolerance] = useState(48);
  const [feather, setFeather] = useState(24);

  // 图集
  const [config, setConfig] = useState<AtlasConfig>({
    cols: 8,
    rows: 6,
    cellWidth: 256,
    cellHeight: 256,
    scale: 1,
  });

  const [saving, setSaving] = useState(false);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const atlasInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => {
    if (videoRef.current) disposeVideo(videoRef.current);
  }, []);

  const count = useMemo(
    () => (videoInfo ? frameCountFor(videoInfo.duration, fps, maxFrames) : 0),
    [videoInfo, fps, maxFrames],
  );

  const chosen = useMemo(() => frames.filter((frame) => selected.has(frame.id)), [frames, selected]);

  /** 选中的帧（按需抠背景）→ 图集。 */
  const packed: PackedAtlas | null = useMemo(() => {
    if (chosen.length === 0) return null;
    const canvases = chosen.map((frame) => {
      const canvas = cloneCanvas(frame.canvas);
      if (keyOn) keyBackground(canvas, { color: keyColor, tolerance, feather });
      return canvas;
    });
    return packFrames(canvases, config);
  }, [chosen, keyOn, keyColor, tolerance, feather, config]);

  // 预览第一页
  useEffect(() => {
    const target = previewRef.current;
    if (!target) return;
    const page = packed?.pages[0]?.canvas;
    if (!page) {
      target.width = 0;
      target.height = 0;
      return;
    }
    target.width = page.width;
    target.height = page.height;
    const context = target.getContext("2d");
    context?.clearRect(0, 0, target.width, target.height);
    context?.drawImage(page, 0, 0);
  }, [packed]);

  const adoptVideo = useCallback(
    async (file: File, name: string) => {
      try {
        if (videoRef.current) disposeVideo(videoRef.current);
        const source = await loadVideo(file);
        videoRef.current = source;
        setVideoInfo({ width: source.width, height: source.height, duration: source.duration });
        setFrames([]);
        setSelected(new Set());
        setKind("video");
        setFileName(name);
        setAtlasName(baseName(name));
        setFps(24);
        setMaxFrames(Math.min(MAX_FRAMES, Math.max(1, Math.round(source.duration * 24))));
        toast(`已载入视频：${source.width}×${source.height} · ${source.duration.toFixed(1)} 秒`);
      } catch (error) {
        toast(error instanceof Error ? error.message : "视频打不开");
      }
    },
    [toast],
  );

  const adoptAtlasZip = useCallback(
    async (buffer: ArrayBuffer, name: string) => {
      try {
        const files = await readZip(buffer);
        const jsonEntry = [...files.entries()].find(([key]) => key.toLowerCase().endsWith(".json"));
        if (!jsonEntry) throw new Error("压缩包里没有图集 JSON");
        const parsed = parseAtlasJson(new TextDecoder().decode(jsonEntry[1]));
        const pages = [...files.entries()]
          .filter(([key]) => key.toLowerCase().endsWith(".png"))
          .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
          .map(([, data]) => bytesToBlob(data, "image/png"));

        if (pages.length === 0) throw new Error("压缩包里没有图集 PNG");

        const canvases = await Promise.all(pages.map((blob) => blobToCanvas(blob)));
        const imported: ExtractedFrame[] = [];
        parsed.frames.forEach((frame, index) => {
          const page = canvases[Math.min(canvases.length, Math.max(1, frame.page)) - 1];
          if (!page) return;
          const canvas = document.createElement("canvas");
          canvas.width = frame.width;
          canvas.height = frame.height;
          canvas
            .getContext("2d")
            ?.drawImage(page, frame.x, frame.y, frame.width, frame.height, 0, 0, frame.width, frame.height);
          imported.push({ id: `a${index}`, time: frame.time, canvas });
        });

        setFrames(imported);
        setSelected(new Set(imported.map((frame) => frame.id)));
        setKind("atlas");
        setFileName(name);
        setAtlasName(parsed.name || baseName(name));
        setKeyOn(false);
        setConfig((current) => ({
          ...current,
          cellWidth: imported[0]?.canvas.width ?? current.cellWidth,
          cellHeight: imported[0]?.canvas.height ?? current.cellHeight,
        }));
        toast(`已从图集恢复 ${imported.length} 帧（${parsed.pageCount} 页）`);
      } catch (error) {
        toast(error instanceof Error ? error.message : "图集读取失败");
      }
    },
    [toast],
  );

  const adoptAtlasJson = useCallback(
    async (text: string, name: string) => {
      try {
        const parsed = parseAtlasJson(text);
        throw new Error(`这份 JSON 引用了 ${parsed.pageCount} 页图集，需要连同 PNG 一起打包成 zip 导入`);
      } catch (error) {
        toast(error instanceof Error ? error.message : "JSON 读取失败");
      }
    },
    [toast],
  );

  const handleFiles = useCallback(
    async (files: FileList | File[] | null | undefined) => {
      const list = files ? Array.from(files) : [];
      const file = list[0];
      if (!file) return;
      const lower = file.name.toLowerCase();
      if (file.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/.test(lower)) {
        await adoptVideo(file, file.name);
        return;
      }
      if (lower.endsWith(".zip")) {
        await adoptAtlasZip(await file.arrayBuffer(), file.name);
        return;
      }
      if (lower.endsWith(".json")) {
        await adoptAtlasJson(await file.text(), file.name);
        return;
      }
      toast("只认识视频（mp4/webm）与图集（zip/json）");
    },
    [adoptAtlasJson, adoptAtlasZip, adoptVideo, toast],
  );

  // ?video=<id> / ?asset=<id> 深链
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const videoId = Number(params.get("video"));
    const assetId = Number(params.get("asset"));
    if (!Number.isFinite(videoId) && !Number.isFinite(assetId)) return;
    void (async () => {
      try {
        if (Number.isFinite(videoId) && videoId > 0) {
          const file = await imageAsFile(videoId);
          await adoptVideo(file, file.name);
        } else if (Number.isFinite(assetId) && assetId > 0) {
          const response = await fetch(imageFileUrl({ id: assetId }));
          if (!response.ok) throw new Error("素材下载失败");
          const blob = await response.blob();
          if (blob.type === "application/zip" || (await blob.slice(0, 2).text()) === "PK") {
            await adoptAtlasZip(await blob.arrayBuffer(), `asset-${assetId}.zip`);
          } else {
            await adoptAtlasJson(await blob.text(), `asset-${assetId}.json`);
          }
        }
      } catch (error) {
        toast(error instanceof Error ? error.message : "从资产载入失败");
      }
    })();
    // 只跑一次：参数来自 URL，不会在会话中变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startExtract = useCallback(async () => {
    const source = videoRef.current;
    if (!source) {
      toast("先选一个视频");
      return;
    }
    setExtracting(true);
    cancelRef.current = false;
    setProgress({ done: 0, total: count });
    try {
      const result = await extractFrames(source, {
        fps,
        count,
        maxEdge,
        onProgress: (done, total) => setProgress({ done, total }),
        isCancelled: () => cancelRef.current,
      });
      setFrames(result);
      setSelected(new Set(result.map((frame) => frame.id)));
      if (result[0]) {
        // 格子默认跟帧一样大，省得用户先被 256 的小格子吓一跳
        setConfig((current) => ({
          ...current,
          cellWidth: result[0].canvas.width,
          cellHeight: result[0].canvas.height,
        }));
      }
      toast(result.length > 0 ? `已提取 ${result.length} 帧` : "已取消");
    } catch (error) {
      toast(error instanceof Error ? error.message : "抽帧失败");
    } finally {
      setExtracting(false);
    }
  }, [count, fps, maxEdge, toast]);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = frames.length > 0 && selected.size === frames.length;

  const pickColorFromFrame = () => {
    const sample = chosen[0] ?? frames[0];
    if (!sample) {
      toast("先抽帧，才能从画面里取背景色");
      return;
    }
    setKeyColor(guessBackgroundColor(sample.canvas));
    setKeyOn(true);
  };

  const exportFiles = useCallback(async () => {
    if (!packed) return null;
    const stem = baseName(atlasName || "atlas");
    const entries: { name: string; data: Uint8Array }[] = [];
    for (let index = 0; index < packed.pages.length; index += 1) {
      const blob = await canvasToBlob(packed.pages[index].canvas);
      entries.push({ name: `${stem}_${String(index + 1).padStart(2, "0")}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    const json = buildAtlasJson({
      name: stem,
      config,
      packed,
      fps,
      times: chosen.map((frame) => frame.time),
    });
    entries.push({ name: `${stem}.json`, data: new TextEncoder().encode(json) });
    return { stem, entries, zip: createZip(entries) };
  }, [atlasName, chosen, config, fps, packed]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("[data-source-menu]")) setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const onExport = useCallback(async () => {
    const result = await exportFiles();
    if (!result) {
      toast("先在中间选几帧");
      return;
    }
    downloadBlob(result.zip, `${result.stem}.zip`);
    toast(`已导出 ${result.entries.length} 个文件`);
  }, [exportFiles, toast]);

  const onSave = useCallback(async () => {
    const result = await exportFiles();
    if (!result) {
      toast("先在中间选几帧");
      return;
    }
    setSaving(true);
    try {
      const saved = await saveAsset(result.zip, `${result.stem}.zip`, {
        prompt: `序列帧工坊 · ${chosen.length} 帧 / ${packed?.pages.length ?? 1} 页`,
      });
      await queryClient.invalidateQueries({ queryKey: ["generations"] });
      await queryClient.invalidateQueries({ queryKey: ["images"] });
      toast(`已保存到资产（批次 #${saved.generation_id}）`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }, [chosen.length, exportFiles, packed?.pages.length, queryClient, toast]);

  const pickFromAsset = (image: ImageBrief) => {
    const target = picking;
    setPicking(null);
    if (!target) return;
    void (async () => {
      try {
        const file = await imageAsFile(image.id);
        if (target === "video") {
          await adoptVideo(file, file.name);
        } else if (file.name.toLowerCase().endsWith(".json")) {
          await adoptAtlasJson(await file.text(), file.name);
        } else {
          await adoptAtlasZip(await file.arrayBuffer(), file.name);
        }
      } catch (error) {
        toast(error instanceof Error ? error.message : "读取资产失败");
      }
    })();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-edge/70 px-5 py-3">
        <Link href="/tools" className="text-xs text-muted transition hover:text-ink">
          ← 工具
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium text-ink">序列帧工坊</h1>
          <p className="truncate text-[11px] text-muted">
            视频拆序列帧 → 抠掉纯色背景 → 按行列打成透明图集，导出 PNG + JSON + ZIP；全程在本机跑
          </p>
        </div>
        <div className="relative" data-source-menu>
          <button
            type="button"
            className="btn inline-flex items-center gap-1.5"
            aria-haspopup="menu"
            aria-expanded={menu === "atlas"}
            onClick={() => setMenu(menu === "atlas" ? null : "atlas")}
          >
            打开图集
            <Caret />
          </button>
          <SlotMenu
            open={menu === "atlas"}
            align="right"
            placement="down"
            onUpload={() => {
              setMenu(null);
              atlasInputRef.current?.click();
            }}
            onPickAsset={() => {
              setMenu(null);
              setPicking("atlas");
            }}
          />
        </div>
        <div className="relative" data-source-menu>
          <button
            type="button"
            className="btn inline-flex items-center gap-1.5"
            aria-haspopup="menu"
            aria-expanded={menu === "video"}
            onClick={() => setMenu(menu === "video" ? null : "video")}
          >
            加载视频
            <Caret />
          </button>
          <SlotMenu
            open={menu === "video"}
            align="right"
            placement="down"
            onUpload={() => {
              setMenu(null);
              videoInputRef.current?.click();
            }}
            onPickAsset={() => {
              setMenu(null);
              setPicking("video");
            }}
          />
        </div>
        <button type="button" className="btn" onClick={() => void onSave()} disabled={!packed || saving}>
          {saving ? "保存中…" : "保存"}
        </button>
        <button type="button" className="btn-primary" onClick={() => void onExport()} disabled={!packed}>
          导出
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左：来源与参数 */}
        <aside className="scroll-thin w-[300px] shrink-0 overflow-y-auto border-r border-edge/70 p-4">
          <section className="mb-5">
            <div className="label mb-2">来源</div>
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-edge/70 p-1">
              <button
                type="button"
                onClick={() => setKind("video")}
                className={`rounded px-2 py-1.5 text-xs transition ${
                  kind === "video" ? "bg-accent/15 text-accentSoft" : "text-muted hover:text-ink"
                }`}
              >
                视频
              </button>
              <button
                type="button"
                onClick={() => setKind("atlas")}
                className={`rounded px-2 py-1.5 text-xs transition ${
                  kind === "atlas" ? "bg-accent/15 text-accentSoft" : "text-muted hover:text-ink"
                }`}
              >
                图集
              </button>
            </div>
            <div className="mt-2 rounded-lg border border-dashed border-edge/70 p-3 text-[11px] leading-relaxed text-muted">
              {fileName ? (
                <>
                  <div className="truncate text-ink">{fileName}</div>
                  {videoInfo ? (
                    <div>
                      {videoInfo.width}×{videoInfo.height} · {videoInfo.duration.toFixed(1)} 秒
                    </div>
                  ) : (
                    <div>{frames.length} 帧已就绪</div>
                  )}
                </>
              ) : (
                <div>
                  选一个视频开始抽帧，或者导入一份图集（zip）把帧拆回来。
                  <button
                    type="button"
                    className="ml-1 text-accentSoft underline-offset-2 hover:underline"
                    onClick={() => videoInputRef.current?.click()}
                  >
                    选视频
                  </button>
                  ／
                  <button
                    type="button"
                    className="text-accentSoft underline-offset-2 hover:underline"
                    onClick={() => atlasInputRef.current?.click()}
                  >
                    选图集
                  </button>
                </div>
              )}
            </div>
          </section>

          {kind === "video" ? (
            <section className="mb-5 space-y-3">
              <div className="label">抽帧</div>
              <NumberField label="每秒帧数" value={fps} min={1} max={60} onChange={setFps} />
              <NumberField label="最多帧数" value={maxFrames} min={1} max={MAX_FRAMES} onChange={setMaxFrames} />
              <NumberField label="帧最长边" value={maxEdge} min={128} max={2048} step={16} onChange={setMaxEdge} />
              <div className="text-[11px] text-muted">
                预计 <span className="text-ink">{count}</span> 帧
              </div>
              <div className="flex gap-2">
                <button type="button" className="btn-primary flex-1" onClick={() => void startExtract()} disabled={!videoInfo || extracting}>
                  {extracting ? `${progress.done}/${progress.total}` : "提取序列帧"}
                </button>
                {extracting ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      cancelRef.current = true;
                    }}
                  >
                    取消
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          <section className="mb-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="label">抠背景</div>
              <button
                type="button"
                onClick={() => setKeyOn((value) => !value)}
                className={`h-5 w-9 rounded-full border transition ${
                  keyOn ? "border-accent/60 bg-accent/30" : "border-edge bg-surface2"
                }`}
                aria-pressed={keyOn}
                aria-label="启用抠背景"
              >
                <span
                  className={`mx-auto block h-3.5 w-3.5 rounded-full bg-ink transition ${keyOn ? "translate-x-2" : "-translate-x-2"}`}
                />
              </button>
            </div>
            <div className={`space-y-2 ${keyOn ? "" : "pointer-events-none opacity-50"}`}>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={keyColor}
                  onChange={(event) => setKeyColor(event.target.value)}
                  className="h-8 w-10 rounded border border-edge bg-surface2"
                  aria-label="背景色"
                />
                <input
                  value={keyColor}
                  onChange={(event) => setKeyColor(event.target.value)}
                  className="field h-8 flex-1 font-mono text-[11px]"
                  aria-label="背景色十六进制"
                />
                <button type="button" className="btn h-8 px-2 text-[11px]" onClick={pickColorFromFrame}>
                  取色
                </button>
              </div>
              <SliderField label="容差" value={tolerance} min={0} max={160} onChange={setTolerance} />
              <SliderField label="羽化" value={feather} min={0} max={64} onChange={setFeather} />
            </div>
          </section>

          <section className="space-y-3">
            <div className="label">图集</div>
            <div className="grid grid-cols-2 gap-2">
              <NumberField label="列数" value={config.cols} min={1} max={64} onChange={(value) => setConfig((c) => ({ ...c, cols: value }))} />
              <NumberField label="行数" value={config.rows} min={1} max={64} onChange={(value) => setConfig((c) => ({ ...c, rows: value }))} />
              <NumberField label="格宽" value={config.cellWidth} min={16} max={2048} step={16} onChange={(value) => setConfig((c) => ({ ...c, cellWidth: value }))} />
              <NumberField label="格高" value={config.cellHeight} min={16} max={2048} step={16} onChange={(value) => setConfig((c) => ({ ...c, cellHeight: value }))} />
            </div>
            <SliderField
              label="格内占比"
              value={Math.round(config.scale * 100)}
              min={50}
              max={100}
              onChange={(value) => setConfig((c) => ({ ...c, scale: value / 100 }))}
              suffix="%"
            />
            <button
              type="button"
              className="btn w-full text-[11px]"
              onClick={() => {
                const first = chosen[0] ?? frames[0];
                if (!first) return;
                setConfig((c) => ({ ...c, cellWidth: first.canvas.width, cellHeight: first.canvas.height }));
              }}
            >
              格子跟随首帧尺寸
            </button>
            <div className="text-[11px] leading-relaxed text-muted">
              每页 {config.cols * config.rows} 格 · 共 {packed?.pages.length ?? 0} 页 · 已选 {chosen.length} 帧
            </div>
          </section>
        </aside>

        {/* 中：帧 */}
        <section className="scroll-thin flex min-w-0 flex-1 flex-col overflow-y-auto p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-xs text-muted">
              序列帧 <span className="text-ink">{frames.length}</span> · 已选 {selected.size}
            </span>
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                className="btn h-7 px-2 text-[11px]"
                onClick={() => setSelected(allSelected ? new Set() : new Set(frames.map((frame) => frame.id)))}
                disabled={frames.length === 0}
              >
                {allSelected ? "取消全选" : "全选"}
              </button>
              <button
                type="button"
                className="btn h-7 px-2 text-[11px]"
                onClick={() => {
                  setFrames([]);
                  setSelected(new Set());
                }}
                disabled={frames.length === 0}
              >
                清空
              </button>
            </div>
          </div>

          {frames.length === 0 ? (
            <div className="flex flex-1 items-center justify-center rounded-xl2 border border-dashed border-edge/70 p-10 text-center">
              <p className="max-w-sm text-xs leading-relaxed text-muted">
                还没有帧。左边选一个视频并「提取序列帧」，或者导入一份图集 zip 把帧拆回来。
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
              {frames.map((frame) => {
                const active = selected.has(frame.id);
                return (
                  <button
                    key={frame.id}
                    type="button"
                    onClick={() => toggle(frame.id)}
                    aria-pressed={active}
                    data-frame="true"
                    title={`${frame.canvas.width}×${frame.canvas.height} · ${frame.time.toFixed(2)} 秒`}
                    className={`group relative aspect-square overflow-hidden rounded-lg border bg-[repeating-conic-gradient(#1b1f27_0%_25%,#141821_0%_50%)_50%/16px_16px] transition ${
                      active ? "border-accent ring-2 ring-accent/40" : "border-edge/60 hover:border-edge"
                    }`}
                  >
                    <FrameThumb frame={frame} />
                    <span className="absolute bottom-0 left-0 right-0 bg-black/55 px-1 py-0.5 text-left text-[10px] text-white/85">
                      {frame.time.toFixed(2)}s
                    </span>
                    {active ? (
                      <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded bg-accent text-[10px] text-white">
                        ✓
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* 右：预览 */}
        <aside className="scroll-thin w-[320px] shrink-0 overflow-y-auto border-l border-edge/70 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="label">图集预览</div>
            <span className="text-[11px] text-muted">
              {packed ? `${packed.pages[0]?.canvas.width}×${packed.pages[0]?.canvas.height}` : "—"}
            </span>
          </div>
          <div className="rounded-lg border border-edge/70 bg-[repeating-conic-gradient(#1b1f27_0%_25%,#141821_0%_50%)_50%/16px_16px] p-2">
            <canvas ref={previewRef} className="block h-auto w-full rounded" />
          </div>
          {packed ? (
            <div className="mt-2 space-y-1 text-[11px] text-muted">
              <div>
                {packed.pages.length} 页 · {packed.placements.length} 帧
              </div>
              <div>
                ZIP 约{" "}
                {formatBytes(
                  packed.pages.reduce((sum, page) => sum + page.canvas.width * page.canvas.height * 0.25, 0),
                )}
                （PNG 未压缩前的估算）
              </div>
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-muted">选帧后这里会显示第一页。</p>
          )}
        </aside>
      </div>

      <input
        ref={videoInputRef}
        type="file"
        accept="video/mp4,video/webm,video/quicktime"
        className="hidden"
        onChange={(event) => {
          void handleFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={atlasInputRef}
        type="file"
        accept=".zip,.json,application/zip,application/json"
        className="hidden"
        onChange={(event) => {
          void handleFiles(event.target.files);
          event.target.value = "";
        }}
      />

      <ImagePicker
        open={picking !== null}
        kind={picking === "video" ? "video" : "image"}
        title={picking === "video" ? "从资产选视频" : "从资产选图集"}
        hint={
          picking === "video"
            ? "列出的都是这个项目里生成过的视频。"
            : "素材里的 .zip / .json 都在这里；zip 里要有图集 PNG 才能拆回帧。"
        }
        onClose={() => setPicking(null)}
        onPick={pickFromAsset}
        onUpload={() => {
          setPicking(null);
          if (picking === "video") videoInputRef.current?.click();
          else atlasInputRef.current?.click();
        }}
      />

      <ToastStack items={toasts} onDismiss={(id) => setToasts((list) => list.filter((item) => item.id !== id))} />
    </div>
  );
}

/** 帧缩略图：直接画到 canvas，避免给每帧造一个 dataURL。 */
function FrameThumb({ frame }: { frame: ExtractedFrame }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const target = ref.current;
    if (!target) return;
    target.width = frame.canvas.width;
    target.height = frame.canvas.height;
    const context = target.getContext("2d");
    context?.clearRect(0, 0, target.width, target.height);
    context?.drawImage(frame.canvas, 0, 0);
  }, [frame]);
  return <canvas ref={ref} className="h-full w-full object-contain" />;
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-muted">{label}</span>
      <input
        type="number"
        className="field h-8 text-xs"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
        }}
      />
    </label>
  );
}

function SliderField({
  label,
  value,
  onChange,
  min,
  max,
  suffix = "",
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  suffix?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-[11px] text-muted">
        <span>{label}</span>
        <span className="text-ink">
          {value}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full appearance-none rounded-full bg-edge accent-accent"
      />
    </label>
  );
}

function Caret() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3 text-muted" fill="none" aria-hidden>
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
