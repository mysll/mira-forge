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

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000/api/v1";

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
  media?: "image" | "video";
  favorite?: boolean;
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

async function postImage(path: string, form: FormData): Promise<{ blob: Blob; headers: Headers }> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
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

/** 清空工作区：删除全部图片与生成记录，不可撤销。 */
export function clearWorkspace(): Promise<WorkspaceClearResponse> {
  return request<WorkspaceClearResponse>("/images/clear", { method: "POST" });
}

export function cancelTask(taskId: number): Promise<TaskRead> {
  return request<TaskRead>(`/tasks/${taskId}/cancel`, { method: "POST" });
}

export function retryTask(taskId: number): Promise<TaskRead> {
  return request<TaskRead>(`/tasks/${taskId}/retry`, { method: "POST" });
}

/** WS 事件地址：把 http(s) 换成 ws(s)，用于任务状态实时推送。 */
export const TASK_EVENTS_URL = `${(
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000/api/v1"
).replace(/^http/, "ws")}/ws/tasks`;

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
