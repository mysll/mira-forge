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
  vram_total: number | null;
  vram_free: number | null;
};

/** POST /comfyui/unload 的结果：卸载模型前后各读一次显存 */
export type FreeMemoryResponse = {
  ok: boolean;
  url: string;
  vram_total: number | null;
  vram_free_before: number | null;
  vram_free_after: number | null;
  freed: number | null;
  detail: string | null;
};

export type HealthResponse = {
  status: string;
  app: string;
  version: string;
  database: DatabaseStatus;
  comfyui: ComfyUIStatus;
  storage: ComponentStatus;
  storage_path: string | null;
  project_id: string;
  project_name: string;
  project_path: string;
  max_generation_count: number;
};

/** 视频的可选分辨率档位（来自 registry，前端不写死） */
export type VideoResolution = {
  width: number;
  height: number;
  label: string;
};

export type ModelCapabilities = {
  /** image | video：决定放在哪个创作页、产物用哪种卡片 */
  media: string;
  exposes_steps: boolean;
  exposes_cfg: boolean;
  exposes_sampler: boolean;
  exposes_negative_prompt: boolean;
  sampler_options: string[];
  exposes_duration: boolean;
  /** 快捷档位 */
  durations: number[];
  /** 滑块允许的区间（秒） */
  duration_min: number;
  duration_max: number;
  /** 一次最多出几个；count_options 是快捷按钮 */
  max_count: number | null;
  count_options: number[];
  resolutions: VideoResolution[];
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

export type GenerationType =
  | "text_to_image"
  | "image_to_image"
  | "image_edit"
  | "text_to_video"
  | "image_to_video"
  // 场景底图与从底图拆出来的分层图：类型本身就是隔离边界
  | "scene"
  | "scene_layer"
  | "local_edit"
  | "local_asset";

export type TaskRead = {
  id: number;
  generation_id: number;
  seed: number | null;
  status: string;
  comfy_prompt_id: string | null;
  progress: number;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
};

/** 作品流里的一个产物（图片或视频）；seed 靠 task_id 从所属批次的 tasks 里取。 */
export type ImageBrief = {
  id: number;
  task_id: number | null;
  width: number;
  height: number;
  file_size: number;
  file_path: string;
  /** 所属场景；非空的产物只在场景页出现 */
  scene_id?: number | null;
  /** image | video | asset */
  media_type: string;
  duration_seconds: number | null;
  fps: number | null;
  frame_count: number | null;
  /** 「批次名 · 第 N 个」，后端按批内顺序算好 */
  label?: string;
  is_favorite: boolean;
  created_at: string;
};

export type GenerationRead = {
  id: number;
  prompt: string;
  /** 所属场景（scenes.id）；为空是普通批次，进作品流 */
  scene_id: number | null;
  /** 所属图层（layers.id）；分层页签按它查自己的批次 */
  layer_id: number | null;
  /** 所属元素（elements.id）；元素页签按它查自己的批次 */
  element_id: number | null;
  /** 批次名，可编辑；空着时显示「批次 #id」 */
  name: string | null;
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
  /** 局部编辑是否带遮罩（遮罩字节走 /generations/{id}/mask） */
  has_mask: boolean;
  steps: number | null;
  cfg: number | null;
  sampler: string | null;
  duration_seconds: number | null;
  fps: number | null;
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
  /** 场景 id：给了就落成场景产物（不进主图片流） */
  scene_id?: number | null;
  layer_id?: number | null;
  generation_type: GenerationType;
  width?: number;
  height?: number;
  count: number;
  negative_prompt?: string | null;
  seed?: number | null;
  steps?: number | null;
  cfg?: number | null;
  sampler?: string | null;
  duration_seconds?: number | null;
  fps?: number | null;
};

export type ImageRead = {
  id: number;
  task_id: number | null;
  generation_id: number | null;
  /** 所属场景（scenes.id）；非空的产物不进主图片流 */
  scene_id: number | null;
  file_path: string;
  thumbnail_path: string | null;
  original_image_id: number | null;
  width: number;
  height: number;
  file_size: number;
  media_type: string;
  duration_seconds: number | null;
  fps: number | null;
  frame_count: number | null;
  /** 「批次名 · 第 N 个」，后端按批内顺序算好 */
  label?: string;
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

/** 一个项目 = data/projects/<id> 下一个独立文件夹（库 + 图片）。 */
export type ProjectRead = {
  id: string;
  name: string;
  created_at: string;
  is_active: boolean;
  path: string;
  database_path: string;
  storage_path: string;
};

export type ProjectListResponse = {
  items: ProjectRead[];
  active: string;
};

/** 场景：一组围绕同一地点/事件的图，产物单独成目录、不进主图片流。 */
export type SceneRead = {
  id: number;
  name: string;
  description: string | null;
  cover_image_id: number | null;
  /** 封面的创建时间，缩略图 URL 的版本号（跨项目 / 跨图 id 复用时不串图） */
  cover_image_created_at: string | null;
  sort_order: number;
  created_at: string;
  image_count: number;
  generation_count: number;
};

export type SceneListResponse = {
  items: SceneRead[];
  total: number;
};

export type SceneDeleted = {
  scene_id: number;
  generations: number;
  images: number;
};

/** 引擎槽位：远景 / 中景 / 近景 / 玩法层 / 前景（系数与 z 由后端按槽位算）。 */
export type LayerSlot = "far" | "mid" | "near" | "behind" | "gameplay" | "foreground";

/** 分层方案里的一层：LLM 给的语义 + 可编辑的提示词，不含坐标。 */
export type LayerRead = {
  id: number;
  set_id: number;
  ord: number;
  key: string;
  name: string;
  role: string | null;
  /** 引擎槽位：far / mid / near / gameplay / foreground */
  slot: LayerSlot;
  /** 槽内序号（0 最远） */
  depth: number;
  scroll_scale: number;
  z_index: number;
  prompt: string;
  negative_prompt: string | null;
  occluded_by: string | null;
  supports: string | null;
  note: string | null;
  generation_id: number | null;
  /** 导出时用哪一张；null = 这一层最新的那张 */
  selected_image_id: number | null;
  has_mask: boolean;
  /** 这一层现在还有没有产物（批次删掉后立刻变 false，不能只看 generation_id） */
  has_images: boolean;
  status: string;
  created_at: string;
};

/** 一次发给 LLM 的请求和它的应答（分层页按对话展示）。 */
export type LLMExchangeEntry = {
  attempt: number;
  system: string;
  user: string;
  has_image: boolean;
  response: string;
  error: string | null;
  duration_ms: number | null;
};

/** 一套层方案 = 一次「分析分层」的结果；analyzing 时 layers 为空。 */
export type LayerSetRead = {
  id: number;
  scene_id: number;
  source_image_id: number | null;
  model_name: string;
  layer_count: number;
  count_per_layer: number;
  brief: string | null;
  negative_prompt: string | null;
  status: "analyzing" | "planned" | "failed" | string;
  error_message: string | null;
  llm_meta: string | null;
  llm_exchange: LLMExchangeEntry[];
  created_at: string;
  completed_at: string | null;
  layers: LayerRead[];
};

export type LayerSetListResponse = {
  items: LayerSetRead[];
  total: number;
};

export type LayerSetCreatePayload = {
  source_image_id: number;
  model: string;
  layer_count: number;
  count_per_layer: number;
  brief?: string | null;
  negative_prompt?: string | null;
};

export type LayerCreatePayload = {
  name: string;
  slot?: LayerSlot;
  prompt: string;
  negative_prompt?: string | null;
  key?: string | null;
  role?: string | null;
};

export type LayerUpdatePayload = {
  name?: string;
  prompt?: string;
  negative_prompt?: string | null;
  /** 换槽位：系数与 z 由后端重算 */
  slot?: LayerSlot;
  depth?: number;
  /** 指定导出用哪一张；null = 回到「用最新的那张」 */
  selected_image_id?: number | null;
};

/** 按层出图：参考图固定是分层源图，只调这一批的参数。 */
export type LayerRenderPayload = {
  count: number;
  prompt?: string | null;
  negative_prompt?: string | null;
  model?: string | null;
  seed?: number | null;
  steps?: number | null;
  cfg?: number | null;
  sampler?: string | null;
  save_prompt?: boolean;
};

/** 「生成所有层」的结果：每层各排一条批次，跳过的是提交失败的层。 */
export type LayerRenderAllResult = {
  generations: GenerationRead[];
  submitted: number;
  images: number;
  skipped: string[];
};

/** 设置页里的 LLM 配置（密钥只回掩码，拿不到明文）。 */
export type LLMSettingsRead = {
  enabled: boolean;
  base_url: string;
  model: string;
  api_key_masked: string;
  api_key_set: boolean;
  timeout_seconds: number;
};

export type LLMSettingsUpdate = {
  enabled?: boolean;
  base_url?: string;
  model?: string;
  api_key?: string;
  clear_api_key?: boolean;
  timeout_seconds?: number;
};

export type LLMTestResult = {
  ok: boolean;
  detail: string;
};

/** 设置页里的「分层提示词」：发给 LLM 的系统提示词，只有这一份。 */
export type LayerPromptRead = {
  prompt: string;
  is_default: boolean;
  max_length: number;
};
/** 图集里的一个件：来源要么是项目里的一张图，要么是元素提取出来的小图。 */
export type KitItemRead = {
  id: number;
  kit_id: number;
  image_id: number | null;
  element_id: number | null;
  key: string;
  anchor: "top" | "bottom";
  note: string | null;
  /** 进图集前按这个比例缩放（1.0 = 原尺寸） */
  scale: number;
  sort_order: number;
  created_at: string;
  rect?: { x: number; y: number; w: number; h: number; bleed: number } | null;
};

export type KitRead = {
  id: number;
  name: string;
  description: string | null;
  padding: number;
  max_width: number;
  cell: number;
  scene_id: number | null;
  created_at: string;
  item_count: number;
  items: KitItemRead[];
};

export type KitListResponse = {
  items: KitRead[];
  total: number;
};

export type KitCreatePayload = {
  name: string;
  description?: string | null;
  padding?: number;
  max_width?: number;
  cell?: number;
  scene_id?: number | null;
};

export type KitUpdatePayload = {
  name?: string;
  description?: string | null;
  padding?: number;
  max_width?: number;
  cell?: number;
};

export type KitItemCreatePayload = {
  image_id?: number;
  element_id?: number;
  key?: string;
  anchor?: "top" | "bottom";
  note?: string | null;
  scale?: number;
};

export type KitItemUpdatePayload = {
  key?: string;
  anchor?: "top" | "bottom";
  note?: string | null;
  sort_order?: number;
  scale?: number;
};

export type AtlasSummary = {
  width: number;
  height: number;
  cell: number;
  fill: number;
  item_count: number;
  items: KitItemRead[];
  /** 比画布还宽、被自动等比缩小的件名 */
  shrunk: string[];
};

/** 元素提取：一张场景图里拆出来的可复用件。 */
export type ElementKind = "terrain" | "structure" | "prop" | "decor";

export type ElementStatus = "draft" | "queued" | "running" | "ready" | "failed";

export type ElementRead = {
  id: number;
  set_id: number;
  kind: ElementKind;
  name: string;
  key: string;
  anchor: "top" | "bottom";
  note: string | null;
  prompt: string | null;
  status: ElementStatus;
  sort_order: number;
  image_id: number | null;
  /** 图集这张用哪张：用户指定过就是指定的那张，否则是最新一张 */
  selected_image_id: number | null;
  /** 这一件被加进了几个图集（页签上标「已在图集」） */
  kit_count: number;
  kit_ids: number[];
  /** 这一件是否手画过遮罩（有的话出图按遮罩裁参考图） */
  has_mask: boolean;
  /** 最近那次出图是不是真透明背景（模型偶尔交出整张不透明的图） */
  has_alpha: boolean;
  created_at: string;
};

export type ElementSetRead = {
  id: number;
  scene_id: number;
  source_image_id: number | null;
  source_image: ImageBrief | null;
  status: "analyzing" | "ready" | "failed";
  brief: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  elements: ElementRead[];
  llm_exchange: LLMExchangeEntry[];
};

export type ElementSetListResponse = {
  items: ElementSetRead[];
  total: number;
};

export type ElementSetCreatePayload = {
  source_image_id: number;
  brief?: string | null;
};

export type ElementUpdatePayload = {
  name?: string;
  key?: string;
  anchor?: "top" | "bottom";
  note?: string | null;
  prompt?: string;
  selected_image_id?: number | null;
};

export type ElementExtractPayload = {
  element_ids: number[];
  negative_prompt?: string | null;
  seed?: number | null;
  steps?: number | null;
  cfg?: number | null;
  sampler?: string | null;
  count?: number;
  model?: string | null;
  prompt_suffix?: string | null;
};

export type ElementPromptRead = {
  prompt: string;
  is_default: boolean;
  max_length: number;
};
