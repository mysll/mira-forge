import type {
  GenerationCreatePayload,
  GenerationListResponse,
  GenerationRead,
  HealthResponse,
  ModelInfo,
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
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
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

export function createGeneration(
  payload: GenerationCreatePayload,
): Promise<GenerationRead> {
  return request<GenerationRead>("/generations", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
