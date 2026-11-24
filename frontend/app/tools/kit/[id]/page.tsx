"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createPortal } from "react-dom";

import ImagePicker from "@/components/ImagePicker";
import {
  addKitItem,
  deleteKit,
  deleteKitItem,
  elementFileUrl,
  fetchKit,
  fetchKitPreview,
  imageThumbnailUrl,
  kitAtlasUrl,
  kitExportUrl,
  startDownload,
  updateKit,
  updateKitItem,
} from "@/lib/api";
import type { ImageBrief, KitItemRead } from "@/types/api";

export default function KitEditorPage() {
  const params = useParams<{ id: string }>();
  const kitId = Number(params.id);
  const router = useRouter();
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [padding, setPadding] = useState(6);
  const [maxWidth, setMaxWidth] = useState(2048);
  const [cell, setCell] = useState(64);
  const [bump, setBump] = useState(0);
  const [picking, setPicking] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [showGrid, setShowGrid] = useState(true);

  const kit = useQuery({
    queryKey: ["kit", kitId],
    queryFn: () => fetchKit(kitId),
    enabled: Number.isFinite(kitId),
  });

  const preview = useQuery({
    queryKey: ["kit-preview", kitId, bump],
    queryFn: () => fetchKitPreview(kitId),
    enabled: Number.isFinite(kitId),
  });

  const data = kit.data;
  useEffect(() => {
    if (!data) return;
    setName(data.name);
    setPadding(data.padding);
    setMaxWidth(data.max_width);
    setCell(data.cell);
  }, [data]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const refresh = (bust = true) => {
    queryClient.invalidateQueries({ queryKey: ["kit", kitId] });
    queryClient.invalidateQueries({ queryKey: ["kits"] });
    if (bust) setBump((value) => value + 1);
  };

  const save = useMutation({
    mutationFn: () => updateKit(kitId, { name: name.trim() }),
    onSuccess: () => {
      setToast("已保存");
      refresh();
    },
    onError: (error: unknown) =>
      setToast(error instanceof Error ? error.message : "保存失败"),
  });

  // 宽度 / 间距 / 格子是"立刻生效"的：改完就写库，预览跟着重排，
  // 不用先点保存（用户改宽度就是为了马上看到重新打包的结果）。
  const applyLayout = useMutation({
    mutationFn: (patch: { padding?: number; max_width?: number; cell?: number }) =>
      updateKit(kitId, patch),
    onSuccess: () => refresh(),
    onError: (error: unknown) =>
      setToast(error instanceof Error ? error.message : "改不了，稍后再试"),
  });

  const commitLayout = (patch: { padding?: number; max_width?: number; cell?: number }) => {
    if (!data) return;
    const changed =
      (patch.padding ?? padding) !== data.padding ||
      (patch.max_width ?? maxWidth) !== data.max_width ||
      (patch.cell ?? cell) !== data.cell;
    if (changed) applyLayout.mutate(patch);
  };

  // 打字时也自动生效：停下 600ms 就写库，不用等失焦。
  useEffect(() => {
    if (!data) return;
    if (maxWidth === data.max_width && padding === data.padding) return;
    const timer = window.setTimeout(() => {
      if (maxWidth !== data.max_width) applyLayout.mutate({ max_width: maxWidth });
      else if (padding !== data.padding) applyLayout.mutate({ padding });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [maxWidth, padding, data, applyLayout]);

  const addItem = useMutation({
    mutationFn: (image: ImageBrief) =>
      addKitItem(kitId, {
        image_id: image.id,
        key: `item_${image.id}`,
        anchor: image.height > image.width ? "bottom" : "top",
      }),
    onSuccess: () => refresh(),
    onError: (error: unknown) =>
      setToast(error instanceof Error ? error.message : "添加失败"),
  });

  const patchItem = useMutation({
    mutationFn: ({
    id,
    patch,
  }: {
    id: number;
    patch: { key?: string; anchor?: "top" | "bottom"; scale?: number };
  }) =>
      updateKitItem(id, patch),
    onSuccess: () => refresh(false),
    onError: (error: unknown) =>
      setToast(error instanceof Error ? error.message : "更新失败"),
  });

  const removeItem = useMutation({
    mutationFn: (itemId: number) => deleteKitItem(itemId),
    onSuccess: () => refresh(),
  });

  const removeKit = useMutation({
    mutationFn: () => deleteKit(kitId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["kits"] });
      router.push("/tools/kit");
    },
  });

  const items = data?.items ?? [];
  // 间距 / 宽度 / 格子改完就写库，所以"保存"只管名字
  const dirty = useMemo(() => {
    if (!data) return false;
    return name.trim() !== data.name;
  }, [data, name]);

  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <header className="flex flex-wrap items-center gap-2 border-b border-edge/70 px-5 py-3">
        <Link href="/tools/kit" className="text-xs text-muted hover:text-ink">
          ← 图集
        </Link>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="min-w-[8rem] max-w-[18rem] rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-medium text-ink hover:border-edge focus:border-edge focus:outline-none"
        />
        <span className="text-xs text-muted">{items.length} 个件</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
            className="rounded-lg border border-edge px-3 py-1.5 text-xs text-muted hover:text-ink disabled:opacity-40"
          >
            保存
          </button>
          <button
            type="button"
            onClick={() => startDownload(kitExportUrl(kitId))}
            className="btn-primary px-3 py-1.5 text-xs"
          >
            导出 ZIP
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`删除图集「${data?.name ?? ""}」？`)) removeKit.mutate();
            }}
            className="rounded-lg border border-edge px-3 py-1.5 text-xs text-muted hover:text-red-400"
          >
            删除
          </button>
        </div>
      </header>

      <div className="grid gap-4 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-xs font-medium text-muted">图集内容</h2>
            <div className="ml-auto flex items-center gap-2 text-[11px] text-muted">
              <label className="flex items-center gap-1">
                间距
                <input
                  type="number"
                  min={0}
                  max={64}
                  value={padding}
                  onChange={(event) => setPadding(Number(event.target.value))}
                  onBlur={(event) => commitLayout({ padding: Number(event.currentTarget.value) })}
                  className="w-14 rounded border border-edge bg-surface2 px-1.5 py-0.5 text-ink"
                />
              </label>
              <label className="flex items-center gap-1">
                宽度
                <input
                  type="number"
                  min={512}
                  max={8192}
                  step={256}
                  value={maxWidth}
                  onChange={(event) => setMaxWidth(Number(event.target.value))}
                  onBlur={(event) => commitLayout({ max_width: Number(event.currentTarget.value) })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      commitLayout({ max_width: Number(event.currentTarget.value) });
                    }
                  }}
                  className="w-20 rounded border border-edge bg-surface2 px-1.5 py-0.5 text-ink"
                />
              </label>
              <label className="flex items-center gap-1">
                格子
                <select
                  value={cell}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setCell(next);
                    commitLayout({ cell: next });
                  }}
                  className="rounded border border-edge bg-surface2 px-1 py-0.5 text-ink"
                >
                  <option value={0}>不对齐</option>
                  <option value={16}>16</option>
                  <option value={32}>32</option>
                  <option value={48}>48</option>
                  <option value={64}>64</option>
                  <option value={96}>96</option>
                  <option value={128}>128</option>
                </select>
              </label>
            </div>
            <button
              type="button"
              onClick={() => setPicking(true)}
              className="rounded-lg border border-edge px-2.5 py-1 text-xs text-muted hover:text-ink"
            >
              + 添加图片
            </button>
          </div>

          {items.length === 0 ? (
            <div className="rounded-xl2 border border-dashed border-edge/70 px-6 py-14 text-center text-xs text-muted">
              还没有图。添加透明的模块图（平台、柱子、拱门…），打包时会自动裁边。
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {items.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  onPatch={(patch) => patchItem.mutate({ id: item.id, patch })}
                  onRemove={() => removeItem.mutate(item.id)}
                />
              ))}
            </div>
          )}
        </section>

        <section className="lg:sticky lg:top-2 lg:self-start">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-xs font-medium text-muted">打包预览</h2>
            {preview.data ? (
              <span className="text-[11px] text-muted">
                {preview.data.width}×{preview.data.height}
                {preview.data.cell > 0 ? ` · ${preview.data.cell} 格` : " · 自由装箱"} · 占用{" "}
                {Math.round(preview.data.fill * 100)}%
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => setShowGrid((value) => !value)}
              className="ml-auto text-[11px] text-muted hover:text-ink"
            >
              {showGrid ? "隐藏格子" : "显示格子"}
            </button>
            <button
              type="button"
              onClick={() => setBump((value) => value + 1)}
              className="text-[11px] text-muted hover:text-ink"
            >
              刷新
            </button>
          </div>
          <div
            className="overflow-auto rounded-xl2 border border-edge p-2"
            style={{
              backgroundImage:
                "linear-gradient(45deg, #1b2028 25%, transparent 25%), linear-gradient(-45deg, #1b2028 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #1b2028 75%), linear-gradient(-45deg, transparent 75%, #1b2028 75%)",
              backgroundSize: "16px 16px",
              backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
              backgroundColor: "#12161c",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`${kitAtlasUrl(kitId, `${bump}-${items.length}`)}${showGrid ? "&grid=1" : ""}`}
              alt="atlas 预览"
              className="mx-auto block max-h-[70vh] w-auto"
            />
          </div>
          {preview.data && preview.data.shrunk && preview.data.shrunk.length > 0 ? (
            <p className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 py-1.5 text-[11px] text-amber-200/90">
              {preview.data.shrunk.length} 件比画布宽，已自动等比缩小：
              {preview.data.shrunk.slice(0, 3).join("、")}
              {preview.data.shrunk.length > 3 ? "…" : ""}。想保持原尺寸就把上面的「宽度」调大，
              或者去元素页把它的比例调小。
            </p>
          ) : null}
          {preview.data && preview.data.items.some((item) => item.rect) ? (
            <div className="mt-2 max-h-40 overflow-auto rounded-lg border border-edge text-[11px]">
              <table className="w-full">
                <tbody>
                  {preview.data.items
                    .filter((item) => item.rect)
                    .map((item) => (
                      <tr key={item.id} className="border-b border-edge/50 last:border-0">
                        <td className="px-2 py-1 text-muted">{item.key || `#${item.image_id ?? item.element_id}`}</td>
                        <td className="px-2 py-1 text-right text-muted">
                          {item.rect!.x},{item.rect!.y} · {item.rect!.w}×{item.rect!.h}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      </div>

      <ImagePicker
        open={picking}
        title="添加到图集"
        hint="选透明的模块图；打包时会自动按 alpha 裁边并留 3px 扩边。"
        onClose={() => setPicking(false)}
        onPick={(image) => {
          setPicking(false);
          addItem.mutate(image);
        }}
      />

      {toast && typeof document !== "undefined"
        ? createPortal(
            <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-edge bg-surface px-3 py-1.5 text-xs text-ink shadow-pop">
              {toast}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

// 下拉里放常用比例；当前值不在常用列表里时也要能显示出来（否则浏览器会回落到第一项）
const SCALE_PRESETS = [0.1, 0.15, 0.2, 0.25, 0.33, 0.4, 0.5, 0.6, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2];

function scaleOptions(current: number): number[] {
  const rounded = Math.round(current * 1000) / 1000;
  if (SCALE_PRESETS.includes(rounded)) return SCALE_PRESETS;
  return [...SCALE_PRESETS, rounded].sort((a, b) => a - b);
}

function ItemCard({
  item,
  onPatch,
  onRemove,
}: {
  item: KitItemRead;
  onPatch: (patch: { key?: string; anchor?: "top" | "bottom"; scale?: number }) => void;
  onRemove: () => void;
}) {
  const [key, setKey] = useState(item.key);
  useEffect(() => setKey(item.key), [item.key]);

  return (
    <div className="rounded-xl2 border border-edge bg-surface p-2">
      <div className="flex h-24 items-center justify-center rounded-lg bg-surface2/60 p-1">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={
            item.element_id
              ? elementFileUrl(item.element_id)
              : imageThumbnailUrl({ id: item.image_id ?? 0 })
          }
          alt={key}
          className="max-h-full max-w-full object-contain"
        />
      </div>
      <input
        value={key}
        onChange={(event) => setKey(event.target.value)}
        onBlur={() => {
          const next = key.trim();
          if (next && next !== item.key) onPatch({ key: next });
          else setKey(item.key);
        }}
        className="mt-1.5 w-full rounded border border-edge bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-ink"
      />
      <div className="mt-1 flex items-center gap-1">
        <select
          value={item.scale ?? 1}
          onChange={(event) => onPatch({ scale: Number(event.target.value) })}
          title="存进图集前先缩放，用来统一各件的视觉大小"
          className="rounded border border-edge bg-surface2 px-1 py-0.5 text-[11px] text-muted"
        >
          {scaleOptions(item.scale ?? 1).map((value) => (
            <option key={value} value={value}>
              {Math.round(value * 100)}%
            </option>
          ))}
        </select>
        <select
          value={item.anchor}
          onChange={(event) => onPatch({ anchor: event.target.value as "top" | "bottom" })}
          className="flex-1 rounded border border-edge bg-surface2 px-1 py-0.5 text-[11px] text-muted"
        >
          <option value="top">对齐顶边</option>
          <option value="bottom">对齐底边</option>
        </select>
        <button
          type="button"
          onClick={onRemove}
          className="rounded border border-edge px-1.5 py-0.5 text-[11px] text-muted hover:text-red-400"
        >
          删
        </button>
      </div>
    </div>
  );
}
