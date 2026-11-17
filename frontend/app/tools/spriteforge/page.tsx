"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";

import ImagePicker from "@/components/ImagePicker";
import { imageFileUrl, saveAsset as saveAssetToLibrary } from "@/lib/api";
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
 * 把 `tool.css`（加了 `.sf-app` 前缀的那份）挂上，再用 `(0, eval)` 执行 `app.js`。
 * 原版代码只有三处改动（都是这份仓库里的适配，上游不用跟着改）：
 *   1. 启动改成 `readyState` 判断，注入即跑，不再等 `DOMContentLoaded`；
 *   2. 四个导入按钮都先问 `window.MiraForgeToolBridge.chooseSource()`，没有宿主就回落到本机文件框；
 *   3. 导出弹层多一个「保存到资产」，把同一个 ZIP 交给 `bridge.saveAsset()`。
 * 页面这一侧只提供这两条通路，其余一律交给原版自己。
 */

const MARKUP_URL = "/tools/spriteforge/index.html";
const CSS_URL = "/tools/spriteforge/tool.css";
const SCRIPT_URL = "/tools/spriteforge/app.js";

type SourceKind = "video" | "atlas";
type ImportChoice = { action: "local" } | { action: "asset"; file: File };

type SpriteForgeApi = {
  boot?: () => void;
  destroy?: () => void;
  importFile?: (kind: SourceKind, file: File) => boolean;
};

const api = (): SpriteForgeApi | null =>
  (window as unknown as { MiraSpriteForge?: SpriteForgeApi }).MiraSpriteForge ?? null;

export default function SpriteForgePage() {
  const hostRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<((choice: ImportChoice | null) => void) | null>(null);
  const queryClient = useQueryClient();
  // 正在编辑哪条素材：从资产打开（或从资产挑图集）就记下它的 id，保存时覆盖它；
  // 本地导入 / 新视频一律清空，保存时新建。
  const boundRef = useRef<number | null>(null);

  const [toastText, setToastText] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ kind: SourceKind; left: number; top: number } | null>(null);
  const [picking, setPicking] = useState<SourceKind | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bound, setBound] = useState<number | null>(null);

  const bindAsset = useCallback((assetId: number | null) => {
    boundRef.current = assetId;
    setBound(assetId);
  }, []);


  const toast = useCallback((text: string) => {
    setToastText(text);
    window.setTimeout(() => setToastText((current) => (current === text ? null : current)), 3200);
  }, []);

  /** 交付用户的选择给工坊，并清掉菜单。 */
  const settle = useCallback((choice: ImportChoice | null) => {
    const resolve = pendingRef.current;
    pendingRef.current = null;
    setMenu(null);
    resolve?.(choice);
  }, []);

  /** 工坊点「导入视频 / 导入图集」时调这里：弹一个两项菜单，等用户选完再 resolve。 */
  const chooseSource = useCallback(
    (kind: SourceKind, anchor: HTMLElement | null) =>
      new Promise<ImportChoice | null>((resolve) => {
        pendingRef.current?.(null);
        pendingRef.current = resolve;
        const rect = anchor?.getBoundingClientRect();
        setMenu({
          kind,
          left: rect ? Math.max(12, Math.min(rect.left, window.innerWidth - 208)) : 160,
          top: rect ? Math.min(rect.bottom + 6, window.innerHeight - 96) : 120,
        });
      }),
    [],
  );

  // 宿主桥接：工坊脚本启动时会读它。
  useEffect(() => {
    const bridge = {
      chooseSource,
      // 导出弹层上的按钮文案：有绑定素材时改成「保存并覆盖」。
      saveLabel: () => (boundRef.current ? `保存并覆盖 #${boundRef.current}` : "保存到资产"),
      saveAsset: async (blob: Blob, name: string) => {
        const target = boundRef.current;
        const saved = await saveAssetToLibrary(blob, name, {
          prompt: "序列帧工坊导出",
          ...(target === null ? {} : { assetId: target }),
        });
        // 新建之后就绑定到这条素材：同一次会话里再保存是覆盖，不会越存越多。
        if (target === null) bindAsset(saved.image_id);
        await queryClient.invalidateQueries({ queryKey: ["generations"] });
        await queryClient.invalidateQueries({ queryKey: ["images"] });
        return saved;
      },
      saved: (built: { name: string }) =>
        boundRef.current
          ? `已覆盖素材 #${boundRef.current}（${built.name}）`
          : `已存入资产库：${built.name}`,
    };
    (window as unknown as { MiraForgeToolBridge?: unknown }).MiraForgeToolBridge = bridge;
    return () => {
      delete (window as unknown as { MiraForgeToolBridge?: unknown }).MiraForgeToolBridge;
    };
  }, [chooseSource, queryClient, bindAsset]);


  // 拉源码、注入标记与样式、执行脚本；卸载时调工坊自己的 destroy 摘掉全局监听。
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

        (0, eval)(js);
        const tool = api();
        tool?.boot?.();
        setReady(true);

        // 深链：?video=<imageId> / ?asset=<imageId>
        const params = new URLSearchParams(window.location.search);
        const videoId = Number(params.get("video"));
        const assetId = Number(params.get("asset"));
        const deepId = videoId || assetId;
        if (deepId) {
          try {
            const file = await fileFromAsset(deepId);
            tool?.importFile?.(videoId ? "video" : "atlas", file);
            // 从素材打开 = 编辑这条素材；从视频打开 = 新作品
            bindAsset(videoId ? null : assetId);
          } catch {
            toast("读取资产失败，请重试");
          }
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "工坊加载失败");
      }
    })();

    return () => {
      disposed = true;
      api()?.destroy?.();
      pendingRef.current?.(null);
      pendingRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 菜单点了外面或按 Esc 就取消这次导入。
  useEffect(() => {
    if (!menu) return;
    const onDown = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest("[data-sf-menu]")) settle(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") settle(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, settle]);

  // 用「从本机上传」或直接拖文件进来 = 换了一份内容，不再是原来那条素材。
  // 我们自己的注入是脚本派发的 change（isTrusted 为 false），只认用户真实操作。
  useEffect(() => {
    if (!ready) return;
    const host = hostRef.current;
    if (!host) return;
    const onLocalChange = (event: Event) => {
      if (event.isTrusted) bindAsset(null);
    };
    const inputs = Array.from(host.querySelectorAll<HTMLInputElement>("#videoInput, #atlasInput"));
    inputs.forEach((input) => input.addEventListener("change", onLocalChange));
    return () => {
      inputs.forEach((input) => input.removeEventListener("change", onLocalChange));
    };
  }, [ready, bindAsset]);

  const onAssetPicked = useCallback(
    async (image: ImageBrief) => {
      const kind = picking;
      setPicking(null);
      if (!kind) return;
      // 挑图集 = 打开这条素材（保存时覆盖它）；挑视频 = 新作品
      bindAsset(kind === "atlas" ? image.id : null);
      try {
        settle({ action: "asset", file: await fileFromAsset(image.id) });
      } catch {
        toast("读取这个文件失败，请重试");
        settle(null);
      }
    },
    [picking, settle, toast, bindAsset],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 工具自己有一整条顶栏（品牌 + 状态 + 导入导出），左侧栏也有「工具」入口，这里不再叠一层标题栏。 */}
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="sf-app" />
        {/* 覆盖提示：从资产打开时告诉用户「这次保存会改原来那条」，点 × 就转为新素材。 */}
        {bound !== null ? (
          <div className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-accent/40 bg-accent/15 px-3 py-1.5 text-[11px] text-accentSoft shadow-pop backdrop-blur">
            <span>正在编辑素材 #{bound} · 保存会覆盖它</span>
            <button
              type="button"
              title="改成另存为新素材"
              aria-label="改成另存为新素材"
              className="grid h-4 w-4 place-items-center rounded-full text-accentSoft/80 hover:bg-white/10 hover:text-ink"
              onClick={() => {
                bindAsset(null);
                toast("已改为另存为新素材");
              }}
            >
              ×
            </button>
          </div>
        ) : null}
        {!ready && !error ? (
          <div className="absolute inset-0 grid place-items-center bg-bg/60 text-xs text-muted">正在加载工坊…</div>
        ) : null}
        {error ? (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <p className="max-w-sm text-xs text-bad">工坊加载失败：{error}</p>
          </div>
        ) : null}
      </div>

      {menu ? (
        <div
          role="menu"
          data-sf-menu
          className="fixed z-[80] w-48 overflow-hidden rounded-lg border border-edge bg-surface2/98 p-1 shadow-pop backdrop-blur"
          style={{ left: menu.left, top: menu.top }}
        >
          <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted/60">
            导入{menu.kind === "video" ? "视频" : "图集"}
          </p>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-muted hover:bg-white/[0.06] hover:text-ink"
            onClick={() => {
              // 本机上传 = 新内容，交回原版文件框前先解绑
              bindAsset(null);
              settle({ action: "local" });
            }}
          >
            从本机上传
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-muted hover:bg-white/[0.06] hover:text-ink"
            onClick={() => {
              setPicking(menu.kind);
              setMenu(null);
            }}
          >
            从资产选
          </button>
        </div>
      ) : null}

      {toastText ? (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-[70] -translate-x-1/2 rounded-lg border border-edge bg-surface2/95 px-3 py-2 text-[11px] text-ink shadow-pop">
          {toastText}
        </div>
      ) : null}

      <ImagePicker
        open={picking !== null}
        title={picking === "video" ? "从资产导入视频" : "从资产导入图集"}
        hint={picking === "video" ? "只列出视频产物" : "选一个图集 ZIP，或素材里的图集"}
        kind={picking === "video" ? "video" : "image"}
        onClose={() => {
          setPicking(null);
          settle(null);
        }}
        onPick={(image) => void onAssetPicked(image)}
      />
    </div>
  );
}
