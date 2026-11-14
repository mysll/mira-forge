# API 参考

Base URL：`http://127.0.0.1:8000/api/v1`
交互式文档：`http://127.0.0.1:8000/docs`

## 约定

- 请求/响应均为 `application/json`（P4 的图片编辑为 `multipart/form-data`）。
- 错误统一为 `{"detail": "中文可读原因"}`。
- 状态码：`200` 查询成功 · `201` 创建成功 · `404` 资源不存在 · `422` 参数校验失败。
- 时间字段为 ISO 8601 UTC（`2026-11-14T07:51:03Z`）。

## 健康检查

### `GET /health`

永不返回 5xx；依赖异常通过 `status` 表达。

```json
{
  "status": "ok",
  "app": "MiraForge",
  "version": "0.1.0",
  "database": { "status": "ok", "detail": null, "path": "D:/AI/MiraForge/data/app.db" },
  "comfyui": {
    "status": "ok",
    "detail": null,
    "url": "http://127.0.0.1:8188",
    "reachable": true,
    "version": "0.44.0",
    "device": "cuda:0 NVIDIA GeForce RTX 5070 Ti : cudaMallocAsync",
    "error": null
  },
  "storage": { "status": "ok", "detail": "D:/AI/MiraForge/storage" }
}
```

`status` 取值：`ok`（全部正常）· `degraded`（DB 正常但 ComfyUI 或存储异常）· `error`（DB 不可用）。

## 模型目录

### `GET /models`

```json
{
  "items": [
    {
      "id": "qwen_image_21_turbo",
      "label": "Qwen Image 2.1 Turbo",
      "description": "8 步蒸馏版，速度优先；步数由固定 sigma 表决定，不可调",
      "defaults": { "steps": 8, "cfg": 1.0, "sampler": "euler", "denoise": 1.0, "width": 1024, "height": 1024 },
      "capabilities": { "exposes_steps": false, "exposes_cfg": false, "exposes_sampler": false },
      "workflows": [
        { "type": "text_to_image", "label": "文生图", "json_path": "D:/AI/MiraForge/backend/workflows/qwen_image_21_turbo_t2i.json", "config_path": "D:/AI/MiraForge/backend/workflow_configs/qwen_image_21_turbo_t2i.yaml", "validated": true, "available": true }
      ],
      "available": true,
      "is_default": true
    }
  ]
}
```

- `available`：该模型至少一种工作流的 JSON 落地了。
- `is_default`：前端下拉默认选中项（对应 `registry.yaml` 的 `default: true`）。
- `validated`：该工作流是否真实跑通过（`qwen_image_21` 与 `qwen_image_21_turbo` 的文生图均为 `true`；编辑类待 P4）。

### `GET /models/{model_id}`

返回单个 `ModelInfo`；不存在返回 `404 {"detail": "模型 xxx 不存在"}`。

## 工作流

### `GET /workflows`

数据库镜像，用于排查"注册表与库是否一致"。

```json
{
  "items": [
    { "id": 1, "name": "Qwen Image 2.1", "type": "text_to_image", "json_path": "D:/AI/MiraForge/backend/workflows/qwen_image_21_t2i.json", "config_path": "D:/AI/MiraForge/backend/workflow_configs/qwen_image_21_t2i.yaml", "enabled": true }
  ]
}
```

## 生成

### `POST /generations`

只入库排队，**不在此请求内生成图片**。返回 `201`；随后 Worker 串行接管，前台轮询 `GET /generations/{id}` 或订阅 WS 观察进度。

```json
{
  "prompt": "a copper automaton playing chess in a rain-lit library, cinematic",
  "model": "qwen_image_21",
  "generation_type": "text_to_image",
  "width": 1024,
  "height": 1024,
  "count": 4
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | 是 | 去空白后不能为空 |
| `model` | 是 | 注册表中的模型 id |
| `generation_type` | 是 | `text_to_image` \| `image_edit` |
| `width` / `height` | 否 | 64–4096；缺省回落到模型 defaults。**image_edit 会被忽略并记为 null** |
| `count` | 否 | 1–`MAX_GENERATION_COUNT`（默认 8），每张独立 task + 独立 seed |

响应（`GenerationRead`，含全部子任务；`model_name` 是模型 **id**，不是 label）：

```json
{
  "id": 3,
  "prompt": "a ceramic fox in a rain-soaked neon alley, cinematic",
  "model_name": "qwen_image_21_turbo",
  "generation_type": "text_to_image",
  "width": 1024,
  "height": 1024,
  "requested_count": 2,
  "status": "pending",
  "created_at": "2026-11-14T08:20:03Z",
  "completed_at": null,
  "tasks": [
    { "id": 7, "seed": 1736329652, "status": "pending", "progress": 0, "comfy_prompt_id": null, "error_message": null, "started_at": null, "completed_at": null }
  ]
}
```

执行完成后同一端点返回：

```json
{
  "status": "completed",
  "completed_at": "2026-11-14T08:20:15Z",
  "tasks": [
    { "id": 7, "status": "completed", "progress": 100, "comfy_prompt_id": "f9c1…", "error_message": null,
      "started_at": "2026-11-14T08:20:04Z", "completed_at": "2026-11-14T08:20:09Z" }
  ]
}
```

失败时 `status` 为 `failed`，`error_message` 是中文原因（例如未接入参考图时的
`图片编辑需要参考图，将在 P4 开放（当前仅支持文生图）`）。

校验失败示例：

```
422 {"detail": "单次最多生成 8 张，收到 9"}
422 {"detail": "未知模型 'nope'，可选: qwen_image_21, qwen_image_21_turbo"}
422 {"detail": "prompt 不能为空"}
422 {"detail": "模型 Qwen Image 2.1 不支持 image_edit"}
```

### `GET /generations?limit=20&offset=0`

分页摘要，按创建时间倒序。`items[]` 为 `GenerationSummary`（含 `task_count`，不含 `tasks`）。

```json
{ "items": [ { "id": 2, "status": "pending", "task_count": 2, "model_name": "Qwen Image 2.1", … } ], "total": 2, "limit": 20, "offset": 0 }
```

### `GET /generations/{id}`

返回单个 `GenerationRead`（含 `tasks`）。不存在返回 `404`。

## 任务

### `GET /tasks/{id}`

```json
{ "id": 1, "seed": 545756017, "status": "pending", "progress": 0, "comfy_prompt_id": null, "error_message": null, "started_at": null, "completed_at": null }
```

`progress` 为 0–100 的整数：`1` 表示已提交 ComfyUI，之后由 `progress` 事件推进到 99，完成时置 100。

## 图片

### `GET /images?limit=20&offset=0&generation_id=3`

按 `id` 倒序返回产物。`generation_id` 可选，用于取某次生成的全部图片。

```json
{
  "items": [
    { "id": 6, "task_id": 7, "generation_id": 3, "file_path": "images/3/7_0.png",
      "thumbnail_path": null, "original_image_id": null,
      "width": 1024, "height": 1024, "file_size": 1767626, "created_at": "2026-11-14T08:20:09Z" }
  ],
  "total": 1, "limit": 20, "offset": 0
}
```

`file_path` 相对 `STORAGE_DIR`，因此项目目录可整体搬迁。

### `GET /images/{id}`

返回单个 `ImageRead`；不存在 `404`。

### `GET /images/{id}/file`

返回原始 PNG（`image/png`，`Content-Disposition: attachment`）。可直接作为 `<img src>`：

```html
<img src="http://127.0.0.1:8000/api/v1/images/6/file" />
```

文件在磁盘上缺失时返回 `404` 并说明缺失的 `file_path`。

## WebSocket

### `WS /ws/tasks`

握手后立即收到：

```json
{ "type": "connected", "active_tasks": 2 }
```

之后每次任务状态变化推送一条：

```json
{ "type": "task.updated", "data": { "id": 7, "generation_id": 3, "seed": 1736329652, "status": "running", "progress": 38, "comfy_prompt_id": "f9c1…", "error_message": null, "started_at": "…", "completed_at": null } }
```

`data` 结构与 `GET /tasks/{id}` 相同；一次生成通常产生 `queued → running(多个进度) → completed` 若干条。

## 尚未实现（后续阶段）

| 端点 | 阶段 |
| --- | --- |
| `POST /generations/edit`（multipart 上传参考图） | P4 |
| `POST /tasks/{id}/retry` | P6 |
| `POST /tasks/{id}/cancel` | P6 |
| `DELETE /images/{id}` | P5 |
| `GET /images/{id}/thumbnail`（缩略图） | P5 |
