"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import ImagePicker from "@/components/ImagePicker";
import { imageAsNamedFile, saveAsset } from "@/lib/api";
import type { ImageBrief } from "@/types/api";

const TOOL_URL = "/tools/spriteforge/index.html";

type Captured = { name: string; blob: Blob };

type AnchorPrototype = {
  click: () => void;
  __miraforgePatched?: boolean;
};

type ToolWindow = Window & {
  __miraforgeAnchorPatched?: boolean;
  HTMLAnchorElement: { prototype: HTMLAnchorElement & AnchorPrototype };
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 序列帧工坊的外壳。
 *
 * 工坊本身是原样托管的静态页面，这里只做三件事：
 * 1) 把 MiraForge 的视频资产喂进工坊的 file input（同源，DataTransfer 就行）；
 * 2) 给工坊的 `downloadBlob` 加一层钩子，把「导出图集」产出的 blob 记下来；
 * 3) 把记下来的 blob 通过 /api/v1/assets 存进资产库（storage/assets/）。
 */
export default function SpriteForgePage() {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);
  const [picker, setPicker] = useState(false);
  const [captured, setCaptured] = useState<Captured[]>([]);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const toolWindow = useCallback((): ToolWindow | null => {
    const frame = frameRef.current;
    return (frame?.contentWindow as ToolWindow | null) ?? null;
  }, []);

  // 钩住工坊的下载：它把导出的 blob 变成 <a download> 再点一下，
  // 我们在 anchor 的 click 里把同一个 blob 读出来留一份（工坊是 IIFE，
  // 没法直接改它的 downloadBlob，只能从原型入手）。
  const attachBridge = useCallback(() => {
    const win = toolWindow();
    if (!win || win.__miraforgeAnchorPatched) {
      setReady(true);
      return;
    }
    const proto = win.HTMLAnchorElement.prototype;
    const originalClick = proto.click;
    if (typeof originalClick === "function") {
      proto.click = function patched(this: HTMLAnchorElement) {
        try {
          const name = this.download;
          const href = this.href;
          if (name && href?.startsWith("blob:")) {
            void win
              .fetch(href)
              .then((response) => response.blob())
              .then((blob) => {
                setCaptured((list) => [
                  ...list.filter((item) => item.name !== name),
                  { name, blob },
                ]);
              })
              .catch(() => undefined);
          }
        } catch {
          /* 抓不到就抓不到，不该影响下载本身 */
        }
        return originalClick.call(this);
      };
      proto.__miraforgePatched = true;
    }
    win.__miraforgeAnchorPatched = true;
    setReady(true);
  }, [toolWindow]);

  // iframe 可能在 React 水合之前就加载完了，onLoad 不一定触发；
  // 这里再轮询几次，等到工坊的 DOM 就绪就把钩子挂上（attachBridge 幂等）。
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const tick = () => {
      if (cancelled) return;
      const doc = toolWindow()?.document;
      if (doc && doc.readyState === "complete" && doc.getElementById("videoInput")) {
        attachBridge();
        return;
      }
      attempts += 1;
      if (attempts < 40) {
        window.setTimeout(tick, 250);
      }
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [attachBridge, toolWindow]);

  /** 把一个资产文件塞进工坊的某个 file input。 */
  const feedInput = useCallback(
    async (selector: string, file: File) => {
      const win = toolWindow();
      const input = win?.document.querySelector<HTMLInputElement>(selector);
      if (!input) {
        setNote("工坊还没准备好，稍等一下再试。");
        return;
      }
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    [toolWindow],
  );

  const importVideo = useCallback(
    async (image: ImageBrief) => {
      const file = await imageAsNamedFile(image, `miraforge-${image.id}.mp4`);
      await feedInput("#videoInput", file);
      setNote(`已导入视频（${formatSize(image.file_size)}），可以开始抽帧了。`);
    },
    [feedInput],
  );

  // 支持 ?video=<id> / ?asset=<id> 直接带进来（资产页的「在工坊打开」）。
  useEffect(() => {
    if (!ready) return;
    const params = new URLSearchParams(window.location.search);
    const video = params.get("video");
    const asset = params.get("asset");
    if (!video && !asset) return;
    let cancelled = false;
    (async () => {
      try {
        const id = Number(video ?? asset);
        if (!Number.isFinite(id)) return;
        const file = await imageAsNamedFile({ id });
        if (cancelled) return;
        await feedInput(video ? "#videoInput" : "#atlasInput", file);
        if (!cancelled) setNote(video ? "已从资产导入视频。" : "已从资产导入图集文件。");
      } catch (error) {
        if (!cancelled) setNote(error instanceof Error ? error.message : "导入失败");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, feedInput]);

  const saveAll = useCallback(async () => {
    if (!captured.length || saving) return;
    setSaving(true);
    try {
      const saved = [];
      for (const item of captured) {
        saved.push(
          await saveAsset(item.blob, item.name, { prompt: `序列帧工坊 · ${item.name}` }),
        );
      }
      await queryClient.invalidateQueries({ queryKey: ["generations"] });
      setCaptured([]);
      setNote(
        `已存入资产库：${saved.map((item) => item.name).join("、")}。到「资产 → 素材」里能看到。`,
      );
    } catch (error) {
      setNote(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }, [captured, queryClient, saving]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-edge/70 px-5 py-2.5">
        <Link
          href="/tools"
          className="shrink-0 rounded-lg border border-edge px-2 py-1 text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-ink"
        >
          ← 工具
        </Link>
        <h1 className="shrink-0 whitespace-nowrap text-[13px] font-medium text-ink">序列帧工坊</h1>
        <span className="hidden truncate text-[11px] text-muted/70 lg:inline">
          视频抽帧 · 抠透明背景 · 按行列打图集 · 导出 PNG + JSON
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setPicker(true)}
            className="rounded-lg border border-edge px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-ink"
          >
            从资产导入视频
          </button>
          <button
            type="button"
            onClick={saveAll}
            disabled={captured.length === 0 || saving}
            title={
              captured.length
                ? captured.map((item) => item.name).join("\n")
                : "先在工坊里点「导出图集」，导出的文件会被这里捕获"
            }
            className="rounded-lg border border-accent/50 bg-accent/15 px-2.5 py-1 text-[11px] text-accentSoft transition-colors disabled:cursor-not-allowed disabled:border-edge disabled:bg-transparent disabled:text-muted/50"
          >
            {saving ? "保存中…" : captured.length ? `保存到资产 · ${captured.length}` : "保存到资产"}
          </button>
          <a
            href={TOOL_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-edge px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-ink"
          >
            在新标签页打开 ↗
          </a>
        </div>
      </header>

      {note ? (
        <p className="shrink-0 border-b border-edge/40 bg-surface/40 px-5 py-1.5 text-[11px] text-muted">
          {note}
        </p>
      ) : null}

      <iframe
        ref={frameRef}
        src={TOOL_URL}
        title="序列帧工坊"
        onLoad={attachBridge}
        className="min-h-0 w-full flex-1 border-0 bg-bg"
        allow="clipboard-write; fullscreen"
      />

      <ImagePicker
        open={picker}
        kind="video"
        title="从资产导入视频"
        hint="选一条 MiraForge 生成的视频，直接送进工坊抽帧"
        onClose={() => setPicker(false)}
        onPick={(image) => {
          setPicker(false);
          void importVideo(image);
        }}
      />
    </div>
  );
}
