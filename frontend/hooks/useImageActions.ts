"use client";

import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";

import { deleteImage, imageFileUrl, setImageFavorite } from "@/lib/api";
import { useComposerStore } from "@/stores/composer";
import { useReferenceStore } from "@/stores/reference";
import type { GenerationRead, ImageBrief } from "@/types/api";

export type AssetRef = { image: ImageBrief; generation: GenerationRead };

type Options = {
  onToast: (text: string) => void;
  /** 删掉当前正在详情里看的那张图时，调用方负责关掉弹窗 */
  onDeleted?: (imageId: number) => void;
  /** 「继续编辑」后调用方负责关弹窗 */
  onEdited?: () => void;
};

/**
 * 作品流和资产库共用的一批图片操作：收藏、下载、删除、作为参考图、参数回填。
 * 两处页面的差别只在「操作之后要不要关弹窗」，用回调留给调用方决定。
 */
export function useImageActions({ onToast, onDeleted, onEdited }: Options) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();

  /** 资产库里点「继续编辑 / 重新生成」时要回到创作页，否则参数填回了却没地方用 */
  const goCompose = useCallback(() => {
    if (pathname !== "/") {
      router.push("/");
    }
  }, [pathname, router]);

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["generations"] });
    queryClient.invalidateQueries({ queryKey: ["images"] });
  }, [queryClient]);

  const favorite = useCallback(
    (item: AssetRef) => {
      const next = !item.image.is_favorite;
      void setImageFavorite(item.image.id, next)
        .then(() => {
          refresh();
          onToast(next ? "已收藏" : "已取消收藏");
        })
        .catch((error: Error) => onToast(error.message || "操作失败"));
    },
    [onToast, refresh],
  );

  const download = useCallback(
    async (item: AssetRef) => {
      try {
        const response = await fetch(imageFileUrl(item.image));
        if (!response.ok) {
          throw new Error("图片下载失败");
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `miraforge-${item.image.id}.png`;
        anchor.click();
        URL.revokeObjectURL(url);
      } catch (error) {
        onToast((error as Error).message || "下载失败");
      }
    },
    [onToast],
  );

  const remove = useCallback(
    async (item: AssetRef) => {
      if (!window.confirm("删除这张图？文件会从磁盘移除。")) {
        return;
      }
      try {
        await deleteImage(item.image.id);
        onDeleted?.(item.image.id);
        refresh();
        onToast("已删除");
      } catch (error) {
        onToast((error as Error).message || "删除失败");
      }
    },
    [onDeleted, onToast, refresh],
  );

  const edit = useCallback(
    (item: AssetRef) => {
      onEdited?.();
      useReferenceStore.getState().setImage({
        id: item.image.id,
        url: imageFileUrl(item.image),
      });
      onToast("已作为参考图，写在下方提示词里描述要改成什么");
      goCompose();
    },
    [goCompose, onEdited, onToast],
  );

  const regenerate = useCallback(
    (item: AssetRef) => {
      const store = useComposerStore.getState();
      const { generation } = item;
      store.setMode(generation.generation_type === "image_edit" ? "image_edit" : "text_to_image");
      store.setPrompt(generation.prompt);
      store.setModelId(generation.model_name);
      if (generation.width && generation.height) {
        store.setCustomSize(generation.width, generation.height);
      }
      onEdited?.();
      onToast("参数已填回创作框，点「生成」即可再跑一批");
      goCompose();
    },
    [goCompose, onEdited, onToast],
  );

  return { favorite, download, remove, edit, regenerate, refresh };
}
