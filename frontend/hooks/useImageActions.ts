"use client";

import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";

import {
  deleteGeneration,
  deleteImage,
  deleteTask,
  imageFileUrl,
  referenceImageUrl,
  renameGeneration,
  setImageFavorite,
} from "@/lib/api";
import { useComposerStore } from "@/stores/composer";
import { useGenerationRefStore } from "@/stores/generationRefs";
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
/**
 * 下载时用的扩展名：优先取 file_path 的后缀，取不到再按 media_type 兜底。
 */
function downloadSuffix(image: ImageBrief): string {
  const match = /\.([a-z0-9]+)$/i.exec(image.file_path ?? "");
  if (match) return match[1].toLowerCase();
  if (image.media_type === "video") return "mp4";
  if (image.media_type === "frameset") return "zip";
  return image.media_type === "asset" ? "bin" : "png";
}

/**
 * 把上一单的参考图从服务端取回来，做成能再提交的 File。
 * 取不到的跳过，绝不挡住提示词与参数的填充。
 */
async function referenceFiles(generation: GenerationRead): Promise<File[]> {
  const count = generation.reference_images?.length ?? 0;
  const files: File[] = [];
  for (let index = 0; index < count; index += 1) {
    try {
      const response = await fetch(
        referenceImageUrl(generation.id, generation.created_at, index),
      );
      if (!response.ok) {
        continue;
      }
      const blob = await response.blob();
      const type = blob.type || "image/png";
      const extension = type.split("/")[1] || "png";
      files.push(
        new File([blob], `reference-${index + 1}.${extension}`, { type }),
      );
    } catch {
      // 少一张也比什么都不填强
    }
  }
  return files;
}

export function useImageActions({ onToast, onDeleted, onEdited }: Options) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();

  /** 资产库里点「继续编辑 / 重新生成」时要回到创作页，否则参数填回了却没地方用 */
  const goCompose = useCallback(() => {
    if (pathname !== "/compose") {
      router.push("/compose");
    }
  }, [pathname, router]);

  /**
   * 场景里的图要留在场景里编辑：跳到 /compose 会把用户带出场景，
   * 而场景页自己的创作框读的是同一批 store，原地就能继续。
   */
  const goComposerFor = useCallback(
    (sceneId?: number | null) => {
      if (typeof sceneId === "number" && sceneId > 0) {
        if (!pathname.startsWith("/scenes/")) {
          router.push(`/scenes/${sceneId}`);
        }
        return;
      }
      goCompose();
    },
    [goCompose, pathname, router],
  );

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["generations"] });
    queryClient.invalidateQueries({ queryKey: ["images"] });
    // 分层工作台按层查批次，主列表的 key 变了它不会跟着变
    queryClient.invalidateQueries({ queryKey: ["layer-generations"] });
    queryClient.invalidateQueries({ queryKey: ["layer-sets"] });
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
        // 扩展名按产物自己的文件走：帧集是 .zip、视频是 .mp4，素材可能是 .png/.json/.zip。
        // 写死 .png 会让下载下来的帧集变成一个打不开的 png。
        anchor.download = `miraforge-${item.image.id}.${downloadSuffix(item.image)}`;
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

  /** 整条任务连产物一起删：格子上的「删除任务」和详情里的同名按钮都走这里 */
  const removeTask = useCallback(
    async (generation: GenerationRead, taskId: number) => {
      const count = generation.images.filter((image) => image.task_id === taskId).length;
      const message =
        count > 0
          ? `删除这个任务和它名下的 ${count} 件产物？文件会从磁盘移除。`
          : "删除这个任务？";
      if (!window.confirm(message)) {
        return;
      }
      try {
        const result = await deleteTask(taskId);
        refresh();
        onToast(result.generation_deleted ? "任务已删除，批次也空了，一并清掉" : "任务已删除");
      } catch (error) {
        onToast((error as Error).message || "删除任务失败");
      }
    },
    [onToast, refresh],
  );

  /** 给批次起名：产物随即变成「名字 · 第 N 个」；传空字符串就是清掉 */
  const renameBatch = useCallback(
    async (generation: GenerationRead, name: string) => {
      const trimmed = name.trim();
      if (trimmed === (generation.name ?? "")) {
        return;
      }
      try {
        await renameGeneration(generation.id, trimmed);
        refresh();
        onToast(trimmed ? `批次改名为「${trimmed}」` : "已清掉批次名");
      } catch (error) {
        onToast((error as Error).message || "改名失败");
      }
    },
    [onToast, refresh],
  );

  /** 整批删除：这次生成的所有任务与产物一起清掉 */
  const removeBatch = useCallback(
    async (generation: GenerationRead) => {
      const count = generation.images.length;
      const message =
        count > 0
          ? `删除批次 #${generation.id} 和它名下的 ${count} 件产物？文件会从磁盘移除。`
          : `删除批次 #${generation.id}？`;
      if (!window.confirm(message)) {
        return;
      }
      try {
        await deleteGeneration(generation.id);
        refresh();
        onToast("批次已删除");
      } catch (error) {
        onToast((error as Error).message || "删除批次失败");
      }
    },
    [onToast, refresh],
  );

  const edit = useCallback(
    (item: AssetRef) => {
      // 帧集不是一张图：继续编辑 = 回抽帧台调偏移，塞进创作框当参考图没有意义
      if (item.image.media_type === "frameset") {
        onEdited?.();
        router.push(`/tools/frames?frameset=${item.image.id}`);
        onToast("在抽帧台里调偏移，保存会覆盖这条帧集");
        return;
      }
      onEdited?.();
      const store = useReferenceStore.getState();
      store.clear();
      store.putImage({ id: item.image.id, url: imageFileUrl(item.image) }, 0);
      onToast("已作为参考图，写在下方提示词里描述要改成什么");

      goComposerFor(item.image.scene_id);
    },
    [goComposerFor, onEdited, onToast, router],
  );

  const regenerate = useCallback(
    (item: AssetRef) => {
      const store = useComposerStore.getState();
      const { generation } = item;
      const editing =
        generation.generation_type === "image_edit" ||
        generation.generation_type === "image_inpaint";
      store.setMode(editing ? "image_edit" : "text_to_image");
      store.setPrompt(generation.prompt);
      store.setModelId(generation.model_name);
      if (generation.width && generation.height) {
        store.setCustomSize(generation.width, generation.height);
      }
      store.setNegative(generation.negative_prompt ?? "");
      store.setSteps(generation.steps === null ? "" : String(generation.steps));
      store.setCfg(generation.cfg === null ? "" : String(generation.cfg));
      store.setSampler(generation.sampler ?? "");
      // 遮罩不跟着回填：那是画在上一张构图上的，换一批图就没意义了
      store.setMask(null);

      // 参考图也从服务端取回来：图生图进「参考图」槽位，编辑进第 1/2 张
      const expected = generation.reference_images?.length ?? 0;
      useReferenceStore.getState().clear();
      useGenerationRefStore.getState().clear();
      if (expected > 0) {
        void referenceFiles(generation).then((files) => {
          if (!files.length) {
            return;
          }
          if (editing) {
            useReferenceStore.getState().putFiles(files);
          } else {
            useGenerationRefStore.getState().addFiles(files);
          }
        });
      }

      onEdited?.();
      onToast(
        expected > 0
          ? "提示词、参数和参考图已填回创作框，点「生成」即可再跑一批"
          : "参数已填回创作框，点「生成」即可再跑一批",
      );
      goComposerFor(item.image.scene_id);
    },
    [goComposerFor, onEdited, onToast],
  );

  return {
    favorite,
    download,
    remove,
    removeTask,
    removeBatch,
    renameBatch,
    edit,
    regenerate,
    refresh,
  };
}
