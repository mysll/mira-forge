/** 与后端 /api/v1 的响应结构一一对应。 */

export type ComponentStatus = {
  status: string;
  detail: string | null;
};

export type DatabaseStatus = ComponentStatus & { path: string | null };

export type ComfyUIStatus = ComponentStatus & {
  url: string;
  reachable: boolean;
  version: string | null;
  device: string | null;
  error: string | null;
};

export type HealthResponse = {
  status: string;
  app: string;
  version: string;
  database: DatabaseStatus;
  comfyui: ComfyUIStatus;
  storage: ComponentStatus;
  storage_path: string | null;
  max_generation_count: number;
};

export type ModelCapabilities = {
  exposes_steps: boolean;
  exposes_cfg: boolean;
  exposes_sampler: boolean;
  exposes_negative_prompt: boolean;
  sampler_options: string[];
};

export type WorkflowTarget = {
  type: string;
  label: string;
  json_path: string;
  config_path: string;
  validated: boolean;
  available: boolean;
};

export type ModelInfo = {
  id: string;
  label: string;
  description: string;
  defaults: Record<string, unknown>;
  capabilities: ModelCapabilities;
  workflows: WorkflowTarget[];
  available: boolean;
  is_default: boolean;
  /** 有负面提示词、用户又没显式给 CFG 时，后端会自动用的 CFG；null 表示不支持负面提示词 */
  negative_prompt_cfg: number | null;
};

export type GenerationType = "text_to_image" | "image_to_image" | "image_edit";

export type TaskRead = {
  id: number;
  generation_id: number;
  seed: number;
  status: string;
  comfy_prompt_id: string | null;
  progress: number;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
};

/** 作品流里每张图；seed 靠 task_id 从所属批次的 tasks 里取。 */
export type ImageBrief = {
  id: number;
  task_id: number | null;
  width: number;
  height: number;
  file_size: number;
  is_favorite: boolean;
  created_at: string;
};

export type GenerationRead = {
  id: number;
  prompt: string;
  negative_prompt: string | null;
  workflow_id: number | null;
  generation_type: string;
  model_name: string;
  width: number | null;
  height: number | null;
  requested_count: number;
  status: string;
  progress: number;
  reference_image_path: string | null;
  /** 本次生成用到的全部参考图（相对 STORAGE_DIR），图生图最多 2 张 */
  reference_images: string[];
  steps: number | null;
  cfg: number | null;
  sampler: string | null;
  created_at: string;
  completed_at: string | null;
  tasks: TaskRead[];
  images: ImageBrief[];
};

export type GenerationListResponse = {
  items: GenerationRead[];
  total: number;
  limit: number;
  offset: number;
};

export type GenerationCreatePayload = {
  prompt: string;
  model: string;
  generation_type: GenerationType;
  width?: number;
  height?: number;
  count: number;
  negative_prompt?: string | null;
  seed?: number | null;
  steps?: number | null;
  cfg?: number | null;
  sampler?: string | null;
};

export type ImageRead = {
  id: number;
  task_id: number | null;
  generation_id: number | null;
  file_path: string;
  thumbnail_path: string | null;
  original_image_id: number | null;
  width: number;
  height: number;
  file_size: number;
  is_favorite: boolean;
  created_at: string;
};

export type ImageListResponse = {
  items: ImageRead[];
  total: number;
  limit: number;
  offset: number;
};

export type ImageBatchDeleteResponse = {
  deleted: number[];
  missing: number[];
};

export type WorkspaceClearResponse = {
  images: number;
  generations: number;
};

/** 作品流里的一条卡片数据：图片 + 它所属批次的全部上下文。 */
/** 作品流里的一张卡：已完成的是图片，未完成的用占位卡（image 为 null）。 */
export type FeedSlot = {
  key: string;
  generation: GenerationRead;
  image: ImageBrief | null;
  task: TaskRead | null;
  index: number;
  total: number;
  seed: number | null;
};

/** 详情弹窗只接受已经出图的那一张。 */
export type FeedItem = {
  key: string;
  image: ImageBrief;
  generation: GenerationRead;
  seed: number | null;
};
