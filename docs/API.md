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
      "id": "qwen_image_21",
      "label": "Qwen Image 2.1",
      "description": "Qwen Image 2.1 int8，25 步标准采样…",
      "defaults": { "steps": 25, "cfg": 1.0, "sampler": "euler", "scheduler": "simple", "denoise": 1.0, "width": 1024, "height": 1024 },
      "capabilities": { "exposes_steps": true, "exposes_cfg": true, "exposes_sampler": true },
      "workflows": [
        { "type": "text_to_image", "label": "文生图", "json_path": "workflows/qwen_image_21_t2i.json", "config_path": "workflow_configs/qwen_image_21_t2i.yaml", "validated": false, "available": false }
      ],
      "available": false
    }
  ]
}
```

`available` 反映该模型至少有一种可用工作流；P1 阶段 JSON 未落地，因此为 `false`。

### `GET /models/{model_id}`

返回单个 `ModelInfo`；不存在返回 `404 {"detail": "模型 xxx 不存在"}`。

## 工作流

### `GET /workflows`

数据库镜像，用于排查"注册表与库是否一致"。

```json
{
  "items": [
    { "id": 1, "name": "Qwen Image 2.1", "type": "text_to_image", "json_path": "workflows/qwen_image_21_t2i.json", "config_path": "workflow_configs/qwen_image_21_t2i.yaml", "enabled": false }
  ]
}
```

## 生成

### `POST /generations`

只入库排队，**不在此请求内生成图片**。返回 `201`。

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

响应（`GenerationRead`，含全部子任务）：

```json
{
  "id": 1,
  "prompt": "a copper automaton …",
  "model_name": "Qwen Image 2.1",
  "generation_type": "text_to_image",
  "width": 1024,
  "height": 1024,
  "requested_count": 4,
  "status": "pending",
  "created_at": "2026-11-14T07:51:03Z",
  "completed_at": null,
  "tasks": [
    { "id": 1, "seed": 545756017, "status": "pending", "progress": 0, "comfy_prompt_id": null, "error_message": null, "started_at": null, "completed_at": null }
  ]
}
```

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

`progress` 为 0–100 的整数；P2 起由 ComfyUI 的 `progress` 事件驱动。

## WebSocket

### `WS /ws/tasks`

握手后立即收到：

```json
{ "type": "connected", "active_tasks": 0 }
```

P1 只做连接维持；P2 起广播 `{"type": "task.progress" | "task.completed" | "task.failed", "task_id": …, "progress": …}`。

## 尚未实现（后续阶段）

| 端点 | 阶段 |
| --- | --- |
| `POST /generations/edit`（multipart 上传参考图） | P4 |
| `POST /tasks/{id}/retry` | P6 |
| `POST /tasks/{id}/cancel` | P6 |
| `GET /images`、`DELETE /images/{id}` | P3/P5 |
| `GET /images/{id}/file`、`/thumbnail` | P3/P5 |
