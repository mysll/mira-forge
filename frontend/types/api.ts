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
};

export type ModelCapabilities = {
  exposes_steps: boolean;
  exposes_cfg: boolean;
  exposes_sampler: boolean;
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
};

export type GenerationType = "text_to_image" | "image_edit";

export type GenerationSummary = {
  id: number;
  prompt: string;
  generation_type: string;
  model_name: string;
  width: number | null;
  height: number | null;
  requested_count: number;
  status: string;
  progress: number;
  created_at: string;
  completed_at: string | null;
  task_count: number;
};

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

export type GenerationRead = {
  id: number;
  prompt: string;
  workflow_id: number | null;
  generation_type: string;
  model_name: string;
  width: number | null;
  height: number | null;
  requested_count: number;
  status: string;
  created_at: string;
  completed_at: string | null;
  tasks: TaskRead[];
};

export type GenerationListResponse = {
  items: GenerationSummary[];
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
  created_at: string;
};

export type ImageListResponse = {
  items: ImageRead[];
  total: number;
  limit: number;
  offset: number;
};
