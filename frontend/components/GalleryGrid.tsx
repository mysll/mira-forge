"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  deleteImage,
  fetchImages,
  imageFileUrl,
  imageThumbnailUrl,
} from "@/lib/api";
import { useReferenceStore } from "@/stores/reference";
import type { ImageRead } from "@/types/api";

const PAGE_SIZE = 24;

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function Tile({
  image,
  onUseAsReference,
  onDelete,
  deleting,
}: {
  image: ImageRead;
  onUseAsReference: (image: ImageRead) => void;
  onDelete: (image: ImageRead) => void;
  deleting: boolean;
}) {
  return (
    <figure className="group relative overflow-hidden rounded-lg border border-edge/70 bg-black/30">
      <a href={imageFileUrl(image.id)} target="_blank" rel="noreferrer" className="block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageThumbnailUrl(image.id)}
          alt={`图片 #${image.id}`}
          loading="lazy"
          className="aspect-square w-full object-cover transition duration-300 group-hover:scale-[1.03]"
        />
      </a>

      <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-2 pb-1.5 pt-6 font-mono text-[10px] text-slate-400 opacity-0 transition group-hover:opacity-100">
        #{image.id} · {image.width}×{image.height} · {formatSize(image.file_size)}
      </figcaption>

      <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition group-hover:opacity-100">
        <button
          type="button"
          onClick={() => onUseAsReference(image)}
          title={`用 #${image.id} 继续编辑`}
          className="rounded-md border border-edge/80 bg-black/70 px-1.5 py-1 text-[10px] text-slate-300 backdrop-blur hover:border-sky-500/60 hover:text-sky-300"
        >
          用作参考图
        </button>
        <a
          href={imageFileUrl(image.id)}
          download
          title="下载原图"
          className="rounded-md border border-edge/80 bg-black/70 px-1.5 py-1 text-[10px] text-slate-300 backdrop-blur hover:border-slate-500 hover:text-slate-100"
        >
          下载
        </a>
        <button
          type="button"
          disabled={deleting}
          onClick={() => onDelete(image)}
          title="删除这张图"
          className="rounded-md border border-edge/80 bg-black/70 px-1.5 py-1 text-[10px] text-slate-400 backdrop-blur hover:border-rose-500/60 hover:text-rose-300 disabled:opacity-50"
        >
          删除
        </button>
      </div>
    </figure>
  );
}

export function GalleryGrid() {
  const [offset, setOffset] = useState(0);
  const queryClient = useQueryClient();
  const router = useRouter();
  const setImage = useReferenceStore((state) => state.setImage);

  const images = useQuery({
    queryKey: ["images", "page", offset],
    queryFn: () => fetchImages({ limit: PAGE_SIZE, offset }),
  });

  const remove = useMutation({
    mutationFn: (image: ImageRead) => deleteImage(image.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["images"] });
      queryClient.invalidateQueries({ queryKey: ["generations"] });
    },
  });

  const total = images.data?.total ?? 0;
  const items = images.data?.items ?? [];
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function useAsReference(image: ImageRead) {
    setImage({ id: image.id, url: imageFileUrl(image.id) });
    router.push("/");
  }

  function handleDelete(image: ImageRead) {
    if (window.confirm(`删除图片 #${image.id}？文件会一起从磁盘移除。`)) {
      remove.mutate(image);
    }
  }

  return (
    <section className="space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-100">画廊</h1>
          <p className="mt-1 text-[11px] text-slate-500">
            共 {total} 张图 · 全部来自真实生成，缩略图按需生成后缓存
          </p>
        </div>
        {total > PAGE_SIZE && (
          <div className="flex items-center gap-2 font-mono text-[11px] text-slate-500">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              className="rounded-md border border-edge px-2 py-1 hover:border-slate-600 disabled:opacity-40"
            >
              上一页
            </button>
            <span>
              {page} / {pageCount}
            </span>
            <button
              type="button"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
              className="rounded-md border border-edge px-2 py-1 hover:border-slate-600 disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        )}
      </header>

      {images.isLoading && <p className="text-xs text-slate-500">加载中…</p>}
      {images.isError && (
        <p className="text-xs text-rose-400">
          {images.error instanceof Error ? images.error.message : "加载失败"}
        </p>
      )}
      {remove.isError && (
        <p className="text-xs text-rose-400">
          {remove.error instanceof Error ? remove.error.message : "删除失败"}
        </p>
      )}

      {images.data && items.length === 0 && (
        <div className="card text-center">
          <p className="text-xs text-slate-500">
            还没有图片。去「生成」页提交一次任务，出图后会自动出现在这里。
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((image) => (
          <Tile
            key={image.id}
            image={image}
            onUseAsReference={useAsReference}
            onDelete={handleDelete}
            deleting={remove.isPending && remove.variables?.id === image.id}
          />
        ))}
      </div>

      {items.length > 0 && (
        <p className="font-mono text-[10px] text-slate-600">
          最新一张的时间：{formatTime(items[0].created_at)}
        </p>
      )}
    </section>
  );
}
