"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";

import ImagePicker from "@/components/ImagePicker";
import { imageFileUrl, saveAsset } from "@/lib/api";
import type { ImageBrief } from "@/types/api";

/** 取回资产文件，按响应类型给它一个像样的名字（工坊靠后缀判断是视频还是图集）。 */
async function fileFromAsset(imageId: number): Promise<File> {
  const response = await fetch(imageFileUrl({ id: imageId }), { cache: "no-store" });
  if (!response.ok) throw new Error("读取资产失败");
  const blob = await response.blob();
  const type = blob.type || "application/octet-stream";
  const extension = type.includes("zip")
    ? "zip"
    : type.includes("json")
      ? "json"
      : type.includes("mp4")
        ? "mp4"
        : type.includes("webm")
          ? "webm"
          : type.includes("jpeg")
            ? "jpg"
            : type.includes("webp")
              ? "webp"
              : "png";
  return new File([blob], `asset-${imageId}.${extension}`, { type });
}

/**
 * 序列帧工坊：原版 SpriteForge 的原样挂载。
 *
 * 不用 iframe —— 把 `public/tools/spriteforge/index.html` 的 body 标记注入本页，
 * 把 `tool.css`（同步脚本里加了 `.sf-app` 前缀）挂上，再用 `(0, eval)` 执行
 * `app.js`。原版脚本靠 `DOMContentLoaded` 启动，这里在文档已经就绪的情况下
 * 临时接管 `addEventListener` 抓住 init 并立即调用，vendor 代码一行不改。
 *
 * 只额外加两条集成通路：
 *   1. 「从资产导入」把资产里的视频 / 图集塞进原版的 `#videoInput` / `#atlasInput`；
 *   2. 「保存到资产」拦住原版导出时的 `<a download>` 点击，把 ZIP 交给 /assets。
 */

const MARKUP_URL = "/tools/spriteforge/index.html";
const CSS_URL = "/tools/spriteforge/tool.css";
const SCRIPT_URL = "/tools/spriteforge/app.js";

type Listener = { target: EventTarget; type: string; handler: EventListener; options?: AddEventListenerOptions };
type BootResult = { cleanup: () => void };

/** 执行原版脚本并立刻跑它的 init，返回一个能摘掉全局监听的清理函数。 */
function bootTool(js: string): BootResult {
  const listeners: Listener[] = [];
  const boot: { init: (() => void) | null } = { init: null };

  const doc = document as Document & { addEventListener: typeof document.addEventListener };
  const win = window as Window & { addEventListener: typeof window.addEventListener };
  const docAdd = doc.addEventListener;
  const winAdd = win.addEventListener;

  const track = (target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions) => {
    listeners.push({ target, type, handler, options });
  };

  doc.addEventListener = function (type: string, handler: EventListener, options?: AddEventListenerOptions) {
    track(document, type, handler, options);
    if (type === "DOMContentLoaded") {
      boot.init = handler as unknown as () => void;
      return;
    }
    return docAdd.call(document, type, handler, options);
  } as typeof document.addEventListener;

  win.addEventListener = function (type: string, handler: EventListener, options?: AddEventListenerOptions) {
    track(window, type, handler, options);
    return winAdd.call(window, type, handler, options);
  } as typeof window.addEventListener;

  try {
    (0, eval)(js);
    boot.init?.();
  } finally {
    delete (doc as { addEventListener?: unknown }).addEventListener;
    delete (win as { addEventListener?: unknown }).addEventListener;
  }

  return {
    cleanup() {
      for (const item of listeners) {
        item.target.removeEventListener(item.type, item.handler, item.options);
      }
    },
  };
}

/** 把文件塞进原版的隐藏 input，让它走自己的导入流程。 */
function feedInput(input: HTMLInputElement | null, file: File) {
  if (!input) return false;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/** 点原版的「导出图集」→ 弹层里的「下载 ZIP」，把生成的 `<a download>` 折下来拿到 ZIP。 */
function captureExport(): Promise<{ blob: Blob; name: string }> {
  return new Promise((resolve, reject) => {
    const proto = HTMLAnchorElement.prototype;
    const original = proto.click;
    let settled = false;

    const restore = () => {
      proto.click = original;
    };

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      restore();
      reject(new Error("没有等到导出文件，确认图集里已经有帧了吗？"));
    }, 15000);

    proto.click = function patchedClick(this: HTMLAnchorElement) {
      const href = this.href;
      if (settled || !href || !href.startsWith("blob:")) return original.call(this);
      settled = true;
      window.clearTimeout(timer);
      restore();
      fetch(href)
        .then((response) => response.blob())
        .then((blob) => resolve({ blob, name: this.download || "sprite_atlas.zip" }))
        .catch(reject);
    };

    const exportButton = document.getElementById("exportBtn") as HTMLButtonElement | null;
    if (!exportButton) {
      window.clearTimeout(timer);
      restore();
      reject(new Error("找不到导出按钮"));
      return;
    }

    exportButton.click();

    // 原版先开导出弹层，真正的下载在弹层里的「下载 ZIP」。图集为空时它只弹一条提示。
    window.setTimeout(() => {
      if (settled) return;
      const zipButton = document.getElementById("downloadZipBtn") as HTMLButtonElement | null;
      if (!zipButton) {
        settled = true;
        window.clearTimeout(timer);
        restore();
        reject(new Error("图集还是空的：先在轨道里选帧，再点「追加到图集」"));
        return;
      }
      zipButton.click();
    }, 60);
  });
}

export default function SpriteForgePage() {
  const hostRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const queryClient = useQueryClient();

  const [toastText, setToastText] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [picking, setPicking] = useState<"video" | "atlas" | null>(null);
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toast = useCallback((text: string) => {
    setToastText(text);
    window.setTimeout(() => setToastText((current) => (current === text ? null : current)), 3200);
  }, []);

  const importVideo = useCallback(
    async (id: number) => {
      try {
        const file = await fileFromAsset(id);
        if (!feedInput(document.getElementById("videoInput") as HTMLInputElement | null, file)) {
          toast("工坊还没加载完，稍等一下再试");
        }
      } catch {
        toast("读取这个视频失败，请重试");
      }
    },
    [toast],
  );

  const importAtlas = useCallback(
    async (id: number) => {
      try {
        const file = await fileFromAsset(id);
        const input = document.getElementById("atlasInput") as HTMLInputElement | null;
        if (!feedInput(input, file)) {
          toast("工坊还没加载完，稍等一下再试");
          return;
        }
      } catch {
        toast("读取这个图集失败，请重试");
      }
    },
    [toast],
  );

  // 原版只跑一次：拉源码、注入标记与样式、执行脚本。
  useEffect(() => {
    let disposed = false;

    (async () => {
      try {
        const [html, js] = await Promise.all([
          fetch(MARKUP_URL).then((response) => response.text()),
          fetch(SCRIPT_URL).then((response) => response.text()),
        ]);
        if (disposed) return;

        if (!document.getElementById("sf-tool-css")) {
          const link = document.createElement("link");
          link.id = "sf-tool-css";
          link.rel = "stylesheet";
          link.href = CSS_URL;
          document.head.appendChild(link);
        }

        const host = hostRef.current;
        if (!host) return;

        const parsed = new DOMParser().parseFromString(html, "text/html");
        parsed.querySelectorAll("script").forEach((node) => node.remove());
        host.innerHTML = parsed.body.innerHTML;

        cleanupRef.current = bootTool(js).cleanup;
        setReady(true);

        // 深链：?video=<imageId> / ?asset=<imageId>
        const params = new URLSearchParams(window.location.search);
        const videoId = Number(params.get("video"));
        const assetId = Number(params.get("asset"));
        if (videoId) void importVideo(videoId);
        else if (assetId) void importAtlas(assetId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "工坊加载失败");
      }
    })();

    return () => {
      disposed = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 菜单/选择器点了外面就收起来。
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest("[data-sf-menu]")) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const onPickAsset = useCallback(
    async (image: ImageBrief) => {
      const target = picking;
      setPicking(null);
      if (target === "video") await importVideo(image.id);
      if (target === "atlas") await importAtlas(image.id);
    },
    [picking, importVideo, importAtlas],
  );

  const onSave = useCallback(async () => {
    setSaving(true);
    try {
      const { blob, name } = await captureExport();
      const saved = await saveAsset(blob, name, { prompt: "序列帧工坊导出" });
      toast(`已保存到资产：${saved.name}（批次 #${saved.generation_id}）`);
      void queryClient.invalidateQueries({ queryKey: ["generations"] });
      void queryClient.invalidateQueries({ queryKey: ["images"] });
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }, [queryClient, toast]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-edge/60 px-3">
        <Link
          href="/tools"
          className="icon-btn h-7 w-7"
          title="回到工具"
          aria-label="回到工具"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="m14 6-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <span className="text-sm font-medium text-ink">序列帧工坊</span>
        <span className="hidden text-[11px] text-muted/70 sm:inline">视频抽帧 · 序列帧轨道 · 图集导出</span>

        <div className="ml-auto flex items-center gap-2">
          <div className="relative" data-sf-menu>
            <button
              type="button"
              className="btn h-7 px-2.5 text-[11px]"
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={!ready}
            >
              从资产导入
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="m6 10 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {menuOpen ? (
              <div
                role="menu"
                className="absolute right-0 top-full z-50 mt-1 w-40 overflow-hidden rounded-lg border border-edge bg-surface2/98 p-1 shadow-pop backdrop-blur"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-muted hover:bg-white/[0.06] hover:text-ink"
                  onClick={() => {
                    setMenuOpen(false);
                    setPicking("video");
                  }}
                >
                  导入视频
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-muted hover:bg-white/[0.06] hover:text-ink"
                  onClick={() => {
                    setMenuOpen(false);
                    setPicking("atlas");
                  }}
                >
                  导入图集
                </button>
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className="btn-primary h-7 px-3 text-[11px]"
            onClick={() => void onSave()}
            disabled={!ready || saving}
            title="把工坊导出的 ZIP 存进资产库的「素材」"
          >
            {saving ? "保存中…" : "保存到资产"}
          </button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="sf-app" />
        {!ready && !error ? (
          <div className="absolute inset-0 grid place-items-center bg-bg/60 text-xs text-muted">正在加载工坊…</div>
        ) : null}
        {error ? (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <p className="max-w-sm text-xs text-bad">工坊加载失败：{error}</p>
          </div>
        ) : null}
      </div>

      {toastText ? (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-[70] -translate-x-1/2 rounded-lg border border-edge bg-surface2/95 px-3 py-2 text-[11px] text-ink shadow-pop">
          {toastText}
        </div>
      ) : null}

      <ImagePicker
        open={picking !== null}
        title={picking === "video" ? "从资产导入视频" : "从资产导入图集"}
        hint={picking === "video" ? "只列出视频产物" : "选一个图集 ZIP（或 JSON）"}
        kind={picking === "video" ? "video" : "image"}
        onClose={() => setPicking(null)}
        onPick={(image) => void onPickAsset(image)}
      />
    </div>
  );
}
