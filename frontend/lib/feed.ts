import type { FeedSlot, GenerationRead } from "@/types/api";

/**
 * 信息流的格子：一个任务一格，排队/生成中的任务先占位，提交后立刻出现在最终位置。
 *
 * 已完成却没有产物的任务一律跳过——那是图被删掉（或产物被删）留下的空壳，
 * 视频、图片、场景、分层四个页面都走这一份逻辑，不要各写一遍。
 */
export function buildFeedSlots(generations: GenerationRead[]): FeedSlot[] {
  const flat: FeedSlot[] = [];

  for (const generation of generations) {
    const tasks = [...generation.tasks].sort((left, right) => left.id - right.id);
    const imageByTask = new Map(generation.images.map((image) => [image.task_id, image]));

    tasks.forEach((task, position) => {
      const image = imageByTask.get(task.id) ?? null;
      if (!image && task.status === "completed") {
        return; // 产物已经被删掉，不再显示「无产物」占位
      }
      flat.push({
        key: `${generation.id}-t${task.id}`,
        generation,
        image,
        task,
        index: position + 1,
        total: tasks.length,
        seed: task.seed,
      });
    });

    // 兜底：没有对应任务的图（例如任务行被删）也要显示出来
    const orphans = generation.images.filter(
      (image) => image.task_id === null || !tasks.some((task) => task.id === image.task_id),
    );
    orphans.forEach((image, position) => {
      flat.push({
        key: `${generation.id}-i${image.id}`,
        generation,
        image,
        task: null,
        index: tasks.length + position + 1,
        total: tasks.length + orphans.length,
        seed: null,
      });
    });
  }

  return flat;
}
