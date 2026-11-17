"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import EditorCanvas from "@/components/editor/EditorCanvas";
import EditorPanel from "@/components/editor/EditorPanel";
import ImagePicker from "@/components/ImagePicker";
import ToastStack, { type ToastItem } from "@/components/ToastStack";
import {
  analyzeForEditor,
  imageAsFile,
  removeBackgroundFromImage,
  trimTransparentImage,
  type EditorAnalysis,
} from "@/lib/api";
import {
  baseName,
  canvasToBlob,
  downloadBlob,
  drawScene,
  exportSize,
  loadImageElement,
} from "@/lib/editor";
import { useEditorStore } from "@/stores/editor";

export default function EditorPage() {
  const store = useEditorStore();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toastId = useRef(1);

  const [analysis, setAnalysis] = useState<EditorAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [picking, setPicking] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((text: string) => {
    const id = toastId.current++;
    setToasts((items) => [...items.slice(-2), { id, text }]);
  }, []);

  const adopt = useCallback(
    async (file: File, options?: { quiet?: boolean }) => {
      setLoading(true);
      try {
        const [image, info] = await Promise.all([
          loadImageElement(file),
          analyzeForEditor(file).catch(() => null),
        ]);
        setAnalysis(info);
        store.load({
          name: file.name,
          image,
          width: image.naturalWidth,
          height: image.naturalHeight,
        });
        if (!options?.quiet) {
          toast(`${file.name} · ${image.naturalWidth}×${image.naturalHeight}`);
        }
      } catch (error) {
        toast(error instanceof Error ? error.message : "图片载入失败");
      } finally {
        setLoading(false);
      }
    },
    [store, toast],
  );

  /** 从资产库带进来：`/tools/editor?image=12`。用 location 读而不是 useSearchParams，
   *  否则这个页面会被 Next 的静态预渲染卡住（bailout）。 */
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("image");
    const id = raw ? Number(raw) : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    imageAsFile(id)
      .then((file) => {
        if (!cancelled) {
          void adopt(file, { quiet: true });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          toast(error instanceof Error ? error.message : "资产图片读取失败");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      setLoading(false);
    };
    // 只在挂载时跑一次：之后换图都由用户操作触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.ctrlKey || event.metaKey;
      if (!meta) {
        return;
      }
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          useEditorStore.getState().redo();
        } else {
          useEditorStore.getState().undo();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const source = store.source;
  const subject = store.subject;

  const onRemoveBackground = useCallback(async () => {
    if (!source) {
      return;
    }
    setBusy(true);
    try {
      const blob = await removeBackgroundFromImage(await blobOf(source), {
        mode: store.mode,
        tolerance: store.tolerance,
        feather: store.feather,
        denoise: store.denoise,
      });
      const image = await loadImageElement(blob);
      store.setSubject(image, { cut: true });
      toast("背景已抠除，可以继续调整大小与位置");
    } catch (error) {
      toast(error instanceof Error ? error.message : "抠背景失败");
    } finally {
      setBusy(false);
    }
  }, [source, store, toast]);

  const onTrim = useCallback(async () => {
    if (!subject) {
      return;
    }
    setBusy(true);
    try {
      const blob = await trimTransparentImage(await blobOfImage(subject), 0);
      const image = await loadImageElement(blob);
      store.setSubject(image, { cut: true });
      toast(`已裁掉透明边，剩余 ${image.naturalWidth}×${image.naturalHeight}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "裁边失败");
    } finally {
      setBusy(false);
    }
  }, [store, subject, toast]);

  const onFitCanvas = useCallback(() => {
    if (!subject) {
      return;
    }
    store.setCanvas(subject.naturalWidth, subject.naturalHeight);
    store.setParams({ heightPct: 100, bottom: 0, offsetX: 0 });
    toast("画布已贴合主体尺寸");
  }, [store, subject, toast]);

  const onExport = useCallback(async () => {
    if (!store.subject) {
      return;
    }
    const output = exportSize(
      { canvasWidth: store.canvasWidth, canvasHeight: store.canvasHeight },
      store.exportScale,
    );
    const canvas = document.createElement("canvas");
    canvas.width = output.width;
    canvas.height = output.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      toast("导出失败：拿不到画布");
      return;
    }
    drawScene(ctx, {
      canvasWidth: store.canvasWidth,
      canvasHeight: store.canvasHeight,
      background: store.background,
      subject: store.subject,
      heightPct: store.heightPct,
      bottom: store.bottom,
      offsetX: store.offsetX,
    }, store.exportScale);
    try {
      const blob = await canvasToBlob(canvas, "image/png");
      downloadBlob(blob, `${baseName(store.subjectName || "miraforge")}-${canvas.width}x${canvas.height}.png`);
      toast("已导出 PNG");
    } catch (error) {
      toast(error instanceof Error ? error.message : "导出失败");
    }
  }, [store, toast]);

  const onPickAsset = useCallback(
    async (image: { id: number }) => {
      setPicking(false);
      setLoading(true);
      try {
        const file = await imageAsFile(image.id);
        await adopt(file);
      } catch (error) {
        toast(error instanceof Error ? error.message : "资产图片读取失败");
      } finally {
        setLoading(false);
      }
    },
    [adopt, toast],
  );

  const tools = useMemo(
    () => [
      { key: "canvas", label: "画布" },
      { key: "subject", label: "主体" },
      { key: "cut", label: "抠底" },
      { key: "export", label: "导出" },
    ],
    [],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-edge/70 px-4 py-2">
        <Link href="/tools" className="text-[12px] text-muted hover:text-ink">
          ← 工具
        </Link>
        <span className="h-4 w-px bg-edge" />
        <h1 className="text-[13px] font-medium text-ink">图片编辑器</h1>
        {source ? (
          <span className="truncate text-[11px] text-muted">
            {store.subjectName || source.name} · 原图 {source.width}×{source.height}
          </span>
        ) : (
          <span className="text-[11px] text-muted/70">本地处理，不占用 GPU，也不会生成新的作品</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className="btn-ghost px-2.5 py-1 text-[11px]" onClick={() => fileInputRef.current?.click()}>
            本机上传
          </button>
          <button type="button" className="btn-ghost px-2.5 py-1 text-[11px]" onClick={() => setPicking(true)}>
            从资产选
          </button>
        </div>
      </header>

      {source ? (
        <div className="flex min-h-0 flex-1">
          <nav className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r border-edge/60 bg-rail/60 py-2">
            {tools.map((tool) => (
              <button
                key={tool.key}
                type="button"
                className="flex w-11 flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-[10px] text-muted hover:bg-surface2 hover:text-ink"
                onClick={() => document.getElementById(`editor-${tool.key}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-accent/60" aria-hidden />
                {tool.label}
              </button>
            ))}
            <div className="mt-auto text-[9px] text-muted/40">v0.1</div>
          </nav>

          <EditorCanvas />

          <EditorPanel
            analysis={analysis}
            busy={busy}
            onRemoveBackground={onRemoveBackground}
            onResetSubject={store.resetSubject}
            onTrim={onTrim}
            onFitCanvas={onFitCanvas}
            onCenter={() => store.setParams({ offsetX: 0 })}
            onExport={onExport}
            onReplace={() => setPicking(true)}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          <div className="panel w-full max-w-md px-6 py-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-edge text-muted">
              {loading ? "…" : "＋"}
            </div>
            <h2 className="text-sm font-medium text-ink">把图片放进编辑器</h2>
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
              支持抠背景、改画布尺寸、等比缩放主体、指定主体底部位置，最后导出 PNG。
            </p>
            <div className="mt-5 flex justify-center gap-2">
              <button type="button" className="btn-primary px-3 py-1.5 text-[12px]" onClick={() => fileInputRef.current?.click()}>
                本机上传
              </button>
              <button type="button" className="btn-ghost px-3 py-1.5 text-[12px]" onClick={() => setPicking(true)}>
                从资产选
              </button>
            </div>
            <p className="mt-4 text-[10px] text-muted/60">
              也可以在资产页把鼠标移到图片上，点「本地编辑」直接带进来。
            </p>
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) {
            void adopt(file);
          }
        }}
      />

      <ImagePicker
        open={picking}
        title="选一张要编辑的图"
        hint="从本地作品里挑一张，带进编辑器不会改动原图"
        onClose={() => setPicking(false)}
        onPick={onPickAsset}
        onUpload={() => {
          setPicking(false);
          fileInputRef.current?.click();
        }}
      />

      <ToastStack items={toasts} onDismiss={(id) => setToasts((items) => items.filter((item) => item.id !== id))} />
    </div>
  );
}

/** 编辑器要的是「原图字节」，而 store 里存的是已解码的 <img>。 */
async function blobOf(source: { name: string; image: HTMLImageElement }): Promise<File> {
  const response = await fetch(source.image.src);
  const blob = await response.blob();
  return new File([blob], source.name, { type: blob.type || "image/png" });
}

/** 把 <img> 重新编码成 PNG，供裁边接口使用。 */
async function blobOfImage(image: HTMLImageElement): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("拿不到画布");
  }
  ctx.drawImage(image, 0, 0);
  const blob = await canvasToBlob(canvas, "image/png");
  return new File([blob], "subject.png", { type: "image/png" });
}
