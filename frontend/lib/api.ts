import type {
  GenerationCreatePayload,
  GenerationListResponse,
  GenerationRead,
  HealthResponse,
  ImageListResponse,
  ModelInfo,
  TaskRead,
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

export async function fetchModels(): Promise<ModelInfo[]> {
  const body = await request<{ items: ModelInfo[] }>("/models");
  return body.items;
}

export function fetchGenerations(limit = 20): Promise<GenerationListResponse> {
  return request<GenerationListResponse>(`/generations?limit=${limit}`);
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

/** 图片原始文件的绝对地址，用于 <img src>。 */
export function imageFileUrl(imageId: number): string {
  return `${API_BASE}/images/${imageId}/file`;
}

/** 编辑记录的参考图地址（P4 才有值）。 */
export function referenceImageUrl(generationId: number): string {
  return `${API_BASE}/generations/${generationId}/reference`;
}

/** 画廊用缩略图（后端首次访问时生成并缓存）。 */
export function imageThumbnailUrl(imageId: number): string {
  return `${API_BASE}/images/${imageId}/thumbnail`;
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
