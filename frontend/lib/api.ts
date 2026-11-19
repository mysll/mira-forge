import type {
  FreeMemoryResponse,
  GenerationCreatePayload,
  GenerationListResponse,
  GenerationRead,
  HealthResponse,
  ImageBatchDeleteResponse,
  ImageListResponse,
  ImageRead,
  ModelInfo,
  ProjectListResponse,
  ProjectRead,
  TaskRead,
  WorkspaceClearResponse,
} from "@/types/api";

/**
 * 后端地址。
 *
 * 没有配 `NEXT_PUBLIC_API_BASE_URL` 时按「当前页面的主机名 + 8000 端口」推导：
 * 这样用 127.0.0.1 打开就走 127.0.0.1，用局域网 IP（如 10.236.134.52）打开就走同一个 IP，
 * 不用为每台机器改环境变量。配了这个变量则以它为准（例如把后端放到另一台机器）。
 */
function resolveApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (configured) {
    return configured;
  }
  if (typeof window !== "undefined") {
    return `http://${window.location.hostname}:8000/api/v1`;
  }
  return "http://127.0.0.1:8000/api/v1";
}

const API_BASE = resolveApiBase();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = init?.body instanceof FormData;
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      // FormData 必须让浏览器自己加带 boundary 的 Content-Type
      ...(init?.body && !isFormData ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "detail" in body) {
        const raw = (body as { detail: unknown }).detail;
        detail = typeof raw === "string" ? raw : JSON.stringify(raw);
      }
    } catch {
      // 保留默认文本
    }
    throw new ApiError(response.status, detail);
  }

  return (await response.json()) as T;
}

export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/health");
}

/** 让 ComfyUI 卸载模型、把显存还回来（设置页的「释放显存」按钮） */
export function unloadComfyModels(): Promise<FreeMemoryResponse> {
  return request<FreeMemoryResponse>("/comfyui/unload", { method: "POST" });
}

export async function fetchModels(): Promise<ModelInfo[]> {
  const body = await request<{ items: ModelInfo[] }>("/models");
  return body.items;
}

export function fetchGenerations(params?: {
  limit?: number;
  offset?: number;
  q?: string;
  model?: string | null;
  media?: "image" | "video" | "asset";
  favorite?: boolean;
  /** 只取「有产物或有任务在跑」的批次，跳过只剩空壳的批次 */
  hasImages?: boolean;
  dateFrom?: string;
  dateTo?: string;
}): Promise<GenerationListResponse> {
  const search = new URLSearchParams();
  search.set("limit", String(params?.limit ?? 40));
  if (params?.offset) {
    search.set("offset", String(params.offset));
  }
  if (params?.q?.trim()) {
    search.set("q", params.q.trim());
  }
  if (params?.model) {
    search.set("model", params.model);
  }
  if (params?.media) {
    search.set("media", params.media);
  }
  if (params?.hasImages) {
    search.set("has_products", "true");
  }
  if (params?.favorite) {
    search.set("favorite", "true");
  }
  if (params?.dateFrom) {
    search.set("date_from", params.dateFrom);
  }
  if (params?.dateTo) {
    search.set("date_to", params.dateTo);
  }
  return request<GenerationListResponse>(`/generations?${search.toString()}`);
}

export function fetchGeneration(id: number): Promise<GenerationRead> {
  return request<GenerationRead>(`/generations/${id}`);
}

export function createGeneration(
  payload: GenerationCreatePayload,
): Promise<GenerationRead> {
  return request<GenerationRead>("/generations", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** 图片编辑：参考图必须走 multipart，字段名是 images（后端只接受 1 张）。 */
export function createEditGeneration(form: FormData): Promise<GenerationRead> {
  return request<GenerationRead>("/generations/edit", {
    method: "POST",
    body: form,
  });
}

/** 图生图：参考图走 multipart，字段名同样是 images，后端接受 1–2 张。 */
export function createImageToImageGeneration(form: FormData): Promise<GenerationRead> {
  return request<GenerationRead>("/generations/image-to-image", {
    method: "POST",
    body: form,
  });
}

/** 图生视频：首帧 / 尾帧都走 multipart，字段名是 files（最多 2 张，按顺序）。 */
export function createImageToVideoGeneration(form: FormData): Promise<GenerationRead> {
  return request<GenerationRead>("/generations/image-to-video", {
    method: "POST",
    body: form,
  });
}

/** 把画廊里已有的图取回成 File，供编辑时复用，避免再让用户选一次文件。 */
export async function imageAsFile(imageId: number): Promise<File> {
  const response = await fetch(`${API_BASE}/images/${imageId}/file`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new ApiError(response.status, "参考图读取失败");
  }
  const blob = await response.blob();
  return new File([blob], `reference-${imageId}.png`, {
    type: blob.type || "image/png",
  });
}

export function fetchImage(imageId: number): Promise<ImageRead> {
  return request<ImageRead>(`/images/${imageId}`);
}

export function fetchImages(params?: {
  limit?: number;
  offset?: number;
  generationId?: number;
}): Promise<ImageListResponse> {
  const search = new URLSearchParams();
  search.set("limit", String(params?.limit ?? 20));
  if (params?.offset !== undefined) {
    search.set("offset", String(params.offset));
  }
  if (params?.generationId !== undefined) {
    search.set("generation_id", String(params.generationId));
  }
  return request<ImageListResponse>(`/images?${search.toString()}`);
}

/* ---------------------------------------------------------------- 本地编辑器 */

export type EditorAnalysis = {
  width: number;
  height: number;
  /** 边框像素估计出的背景色，[r, g, b] */
  background: number[];
  has_alpha: boolean;
  /** 建议容差下，「背景色」占画布的比例，用来提示这张图适不适合直接抠 */
  background_share: number;
  suggested_tolerance: number;
  /** 主体内部被包住的背景比例：>0 说明「只删边缘连通」会留下色块 */
  enclosed_background_share: number;
};

export type RemoveBackgroundOptions = {
  mode?: "edge" | "color";
  tolerance?: number;
  feather?: number;
  /** 去杂点：填掉主体内部的小孔、丢掉背景里的小碎块（面积按 40 px² × 档位算） */
  denoise?: number;
  /** #rrggbb；不给就让后端按边框估 */
  color?: string;
  channel?: "max" | "mean" | "luma";
};

async function postImage(
  path: string,
  form: FormData,
  method: "POST" | "PUT" = "POST",
): Promise<{ blob: Blob; headers: Headers }> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    body: form,
    cache: "no-store",
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "detail" in body) {
        const raw = (body as { detail: unknown }).detail;
        detail = typeof raw === "string" ? raw : JSON.stringify(raw);
      }
    } catch {
      // 保留默认文本
    }
    throw new ApiError(response.status, detail);
  }
  return { blob: await response.blob(), headers: response.headers };
}

/** 读尺寸、估背景色与建议容差。 */
export async function analyzeForEditor(file: Blob | File): Promise<EditorAnalysis> {
  const form = new FormData();
  form.append("image", file, file instanceof File ? file.name : "image.png");
  const { blob } = await postImage("/editor/analyze", form);
  return JSON.parse(await blob.text()) as EditorAnalysis;
}

/** 抠底：返回带透明通道的 PNG。 */
export async function removeBackgroundFromImage(
  file: Blob | File,
  options: RemoveBackgroundOptions = {},
): Promise<Blob> {
  const form = new FormData();
  form.append("image", file, file instanceof File ? file.name : "image.png");
  form.append("mode", options.mode ?? "edge");
  form.append("tolerance", String(options.tolerance ?? 22));
  form.append("feather", String(options.feather ?? 1));
  form.append("denoise", String(options.denoise ?? 0));
  form.append("channel", options.channel ?? "max");
  if (options.color) {
    form.append("color", options.color);
  }
  const { blob } = await postImage("/editor/remove-background", form);
  return blob;
}

/** 裁掉透明边，返回新 PNG（bbox 在响应头里，这里只关心图）。 */
export async function trimTransparentImage(file: Blob | File, padding = 0): Promise<Blob> {
  const form = new FormData();
  form.append("image", file, file instanceof File ? file.name : "image.png");
  form.append("padding", String(padding));
  const { blob } = await postImage("/editor/trim", form);
  return blob;
}

/** 本地编辑器「保存到资产」的返回。 */
export type LocalEditSaved = {
  generation_id: number;
  image_id: number;
  width: number;
  height: number;
  file_size: number;
};

/** 把编辑器导出的成品存进资产库：后端会起一条 `local_edit` 记录，与生成图同构。 */
export async function saveEditedImage(
  blob: Blob,
  options: { sourceImageId?: number; prompt?: string } = {},
): Promise<LocalEditSaved> {
  const form = new FormData();
  form.append("image", new File([blob], "edited.png", { type: "image/png" }));
  if (options.sourceImageId) {
    form.append("source_image_id", String(options.sourceImageId));
  }
  if (options.prompt) {
    form.append("prompt", options.prompt);
  }
  const { blob: body } = await postImage("/editor/save", form);
  return (await JSON.parse(await body.text())) as LocalEditSaved;
}

/** 素材（工坊导出的 atlas.png / atlas.json / 图集 ZIP）保存进资产库。 */
export type AssetSaved = {
  replaced?: boolean;
  generation_id: number;
  image_id: number;
  name: string;
  file_size: number;
  width: number;
  height: number;
  media_type: string;
};

export async function saveAsset(
  blob: Blob,
  name: string,
  options: { sourceImageId?: number; prompt?: string; assetId?: number } = {},
): Promise<AssetSaved> {
  const form = new FormData();
  form.set("file", blob, name);
  form.set("name", name);
  if (options.sourceImageId !== undefined) {
    form.set("source_image_id", String(options.sourceImageId));
  }
  if (options.prompt) {
    form.set("prompt", options.prompt);
  }
  // 传 assetId = 覆盖那条素材；不传 = 新建一条件
  const target = options.assetId === undefined ? "/assets" : `/assets/${options.assetId}`;
  const { blob: body } = await postImage(target, form, options.assetId === undefined ? "POST" : "PUT");
  return (await JSON.parse(await body.text())) as AssetSaved;
}

export type FrameSetSaved = {
  generation_id: number;
  image_id: number;
  name: string;
  frame_count: number;
  fps: number | null;
  width: number;
  height: number;
};

/** 抽帧台：把整包 ZIP 与封面帧存成一条「帧集」资产。 */
export async function saveFrameSet(params: {
  bundle: Blob;
  cover: Blob;
  name: string;
  count: number;
  width: number;
  height: number;
  fps?: number;
  sourceVideoId?: number;
  /** 传了就是覆盖这一条帧集（PUT），不再新建。 */
  replaceImageId?: number;
}): Promise<FrameSetSaved> {
  const form = new FormData();
  form.set("bundle", params.bundle, `${params.name || "frames"}.zip`);
  form.set("cover", params.cover, "cover.png");
  form.set("name", params.name);
  form.set("count", String(params.count));
  form.set("width", String(params.width));
  form.set("height", String(params.height));
  if (params.fps) form.set("fps", String(params.fps));
  if (params.sourceVideoId !== undefined) {
    form.set("source_video_id", String(params.sourceVideoId));
  }
  const { blob } = await postImage(
    params.replaceImageId ? `/frames/${params.replaceImageId}` : "/frames",
    form,
    params.replaceImageId ? "PUT" : "POST",
  );
  return (await JSON.parse(await blob.text())) as FrameSetSaved;
}

/** 按产物 id 取回文件（连同像扩展名的文件名），用于塞进工坊的 file input。 */
export async function imageAsNamedFile(image: { id: number }, name?: string): Promise<File> {
  const response = await fetch(imageFileUrl(image), { cache: "no-store" });
  if (!response.ok) {
    throw new ApiError(response.status, "读取产物失败");
  }
  const blob = await response.blob();
  const type = blob.type || "application/octet-stream";
  const suffix =
    type === "video/mp4" ? "mp4"
      : type === "application/zip" ? "zip"
        : type === "application/json" ? "json"
          : type === "image/jpeg" ? "jpg"
            : type === "image/webp" ? "webp"
              : "png";
  return new File([blob], name ?? `asset-${image.id}.${suffix}`, { type });
}
/** 图片原始文件的绝对地址，用于 <img src>。 */
/**
 * 图片地址带上版本号：SQLite 会复用被删除行的最大 id，而缩略图响应是 immutable 缓存，
 * 只按 id 拼 URL 会让新图沿用旧图的缓存。用 created_at 做版本串可以彻底避开这个坑。
 */
function stamp(createdAt?: string): string {
  if (!createdAt) {
    return "";
  }
  const value = Date.parse(createdAt.endsWith("Z") ? createdAt : `${createdAt}Z`);
  return Number.isNaN(value) ? "" : `?v=${value}`;
}

export function imageFileUrl(image: { id: number; created_at?: string }): string {
  return `${API_BASE}/images/${image.id}/file${stamp(image.created_at)}`;
}

/** 参考图地址；index 从 0 开始，图生图最多 2 张。 */
export function referenceImageUrl(generationId: number, createdAt?: string, index = 0): string {
  const version = stamp(createdAt);
  const query = `?index=${index}${version ? `&${version.slice(1)}` : ""}`;
  return `${API_BASE}/generations/${generationId}/reference${query}`;
}

/** 画廊用缩略图（后端首次访问时生成并缓存）。 */
export function imageThumbnailUrl(image: { id: number; created_at?: string }): string {
  return `${API_BASE}/images/${image.id}/thumbnail${stamp(image.created_at)}`;
}

/** 局部编辑的遮罩（灰度 PNG，白色=重绘区域）；只有 image_inpaint 批次才有。 */
export function maskImageUrl(generationId: number, createdAt?: string): string {
  return `${API_BASE}/generations/${generationId}/mask${stamp(createdAt)}`;
}

export type PromptTemplate = {
  id: number;
  label: string;
  prompt: string;
  sort_order: number;
};

/** 视频创作框下面那排「动作模板」按钮 */
export async function fetchPromptTemplates(): Promise<PromptTemplate[]> {
  const body = await request<{ items: PromptTemplate[] }>("/prompt-templates");
  return body.items;
}

export function createPromptTemplate(payload: {
  label: string;
  prompt: string;
}): Promise<PromptTemplate> {
  return request<PromptTemplate>("/prompt-templates", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updatePromptTemplate(
  id: number,
  payload: { label?: string; prompt?: string },
): Promise<PromptTemplate> {
  return request<PromptTemplate>(`/prompt-templates/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function deletePromptTemplate(id: number): Promise<void> {
  const response = await fetch(`${API_BASE}/prompt-templates/${id}`, {
    method: "DELETE",
    cache: "no-store",
  });
  if (response.status === 204) {
    return;
  }
  if (!response.ok) {
    throw new ApiError(response.status, `删除模板失败（${response.status}）`);
  }
}

export async function resetPromptTemplates(): Promise<PromptTemplate[]> {
  const body = await request<{ items: PromptTemplate[] }>("/prompt-templates/reset", {
    method: "POST",
  });
  return body.items;
}

export async function deleteImage(imageId: number): Promise<void> {
  const response = await fetch(`${API_BASE}/images/${imageId}`, {
    method: "DELETE",
    cache: "no-store",
  });
  if (response.status === 204) {
    return;
  }
  if (!response.ok) {
    throw new ApiError(response.status, `删除失败（${response.status}）`);
  }
}

export type TaskDeleted = { task_id: number; generation_deleted: boolean };

/** 删掉一个批次后返回的计数：多少件产物、多少个任务一起进了回收站。 */
export type GenerationDeleted = { generation_id: number; images: number; tasks: number };

/** 给批次改名；传空字符串就是清掉名字，回到「批次 #id」 */
export function renameGeneration(generationId: number, name: string): Promise<GenerationRead> {
  return request<GenerationRead>(`/generations/${generationId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

/** 删掉一整个批次：名下任务与产物一起进回收站（30 天内可恢复） */
export function deleteGeneration(generationId: number): Promise<GenerationDeleted> {
  return request<GenerationDeleted>(`/generations/${generationId}`, { method: "DELETE" });
}

/** 删掉一个任务（连同它名下的产物）；批次里没有别的任务时，批次也会一起进回收站。 */
export function deleteTask(taskId: number): Promise<TaskDeleted> {
  return request<TaskDeleted>(`/tasks/${taskId}`, { method: "DELETE" });
}

export function setImageFavorite(imageId: number, favorite: boolean): Promise<ImageRead> {
  return request<ImageRead>(`/images/${imageId}/favorite`, {
    method: "POST",
    body: JSON.stringify({ favorite }),
  });
}

/** 批量删除。返回真正删掉的 id 与本来就不存在的 id。 */
export function deleteImages(ids: number[]): Promise<ImageBatchDeleteResponse> {
  return request<ImageBatchDeleteResponse>("/images/batch-delete", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

/** 清空工作区：所有产物进回收站，30 天内可以恢复。 */
export function clearWorkspace(): Promise<WorkspaceClearResponse> {
  return request<WorkspaceClearResponse>("/images/clear", { method: "POST" });
}

/* ---------------------------------------------------------------- 回收站 */

export type RecycleItem = {
  id: number;
  generation_id: number | null;
  task_id: number | null;
  file_path: string;
  thumbnail_path: string | null;
  media_type: string;
  width: number;
  height: number;
  file_size: number;
  duration_seconds: number | null;
  fps: number | null;
  frame_count: number | null;
  created_at: string;
  deleted_at: string | null;
  expires_at: string | null;
  /** 还剩几天被自动彻底删除，0 表示已经过期 */
  days_left: number;
  prompt: string;
  model_name: string;
  generation_type: string;
};

export type RecycleListResponse = {
  items: RecycleItem[];
  total: number;
  limit: number;
  offset: number;
  /** 保留天数（后端 30） */
  retention_days: number;
};

export type RecycleRestored = { restored: number[]; missing: number[] };
export type RecycleCleared = { deleted: number };

export function fetchRecycleBin(
  params: { limit?: number; offset?: number; media?: "image" | "video" | "asset" } = {},
): Promise<RecycleListResponse> {
  const search = new URLSearchParams();
  search.set("limit", String(params.limit ?? 60));
  if (params.offset) {
    search.set("offset", String(params.offset));
  }
  if (params.media) {
    search.set("media", params.media);
  }
  return request<RecycleListResponse>(`/recycle-bin?${search.toString()}`);
}

/** 恢复：产物回到作品流，所属任务与批次一起解冻。 */
export function restoreRecycleItems(ids: number[]): Promise<RecycleRestored> {
  return request<RecycleRestored>("/recycle-bin/restore", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

/** 彻底删除单件产物（删文件，不可恢复）。 */
export function deleteRecycleItem(imageId: number): Promise<RecycleCleared> {
  return request<RecycleCleared>(`/recycle-bin/${imageId}`, { method: "DELETE" });
}

/** 清空回收站：立刻删掉所有文件和记录。 */
export function clearRecycleBin(): Promise<RecycleCleared> {
  return request<RecycleCleared>("/recycle-bin/clear", { method: "POST" });
}

export function cancelTask(taskId: number): Promise<TaskRead> {
  return request<TaskRead>(`/tasks/${taskId}/cancel`, { method: "POST" });
}

export function retryTask(taskId: number): Promise<TaskRead> {
  return request<TaskRead>(`/tasks/${taskId}/retry`, { method: "POST" });
}

/** WS 事件地址：与 `API_BASE` 同一套推导规则，只把 http(s) 换成 ws(s)。 */
export const TASK_EVENTS_URL = `${API_BASE.replace(/^http/, "ws")}/ws/tasks`;

export function fetchProjects(): Promise<ProjectListResponse> {
  return request<ProjectListResponse>("/projects");
}

export function createProject(name: string): Promise<ProjectRead> {
  return request<ProjectRead>("/projects", {
    method: "POST",
    body: JSON.stringify({ name, activate: true }),
  });
}

export function renameProject(id: string, name: string): Promise<ProjectRead> {
  return request<ProjectRead>(`/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function activateProject(id: string): Promise<ProjectRead> {
  return request<ProjectRead>(`/projects/${encodeURIComponent(id)}/activate`, { method: "POST" });
}

export function deleteProject(id: string): Promise<ProjectListResponse> {
  return request<ProjectListResponse>(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
}
