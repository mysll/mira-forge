# 架构说明

## 全景

```
浏览器
  │  HTTP/JSON（同源或 CORS 白名单 127.0.0.1:3000）
  ▼
Next.js (3000)  ── 只与 FastAPI 通信，不知道 ComfyUI 的存在
  │  NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000/api/v1
  ▼
FastAPI (8000)
  ├─ api/ 同步端点：校验 → 写库 → 立即返回"任务已排队"
  ├─ services/ 注册表解析、参数回落、记录创建
  └─ workers/（P2）单 Worker 取 pending task → 提交 ComfyUI → 轮询/WS → 落盘
  │  httpx
  ▼
ComfyUI (8188)  ── 只有 Worker 访问
  │
  ▼
storage/images + data/app.db
```

三条不可动摇的边界：

1. **前端不碰 ComfyUI**，也拿不到 ComfyUI 地址。
2. **HTTP 请求里不生成图片**。`POST /generations` 只写库并返回；耗时工作全部交给 Worker。
3. **单 Worker、串行执行**。`WORKER_CONCURRENCY=1`，`/generations` 的 count 只是排队数量。

## 后端分层

| 目录 | 职责 | 不该做的事 |
| --- | --- | --- |
| `app/api/` | 解析请求、调用 service、映射 HTTP 状态码 | 直接调 ComfyUI、写业务规则 |
| `app/services/` | 注册表解析、参数校验与回落、创建记录 | 处理 HTTP 细节 |
| `app/models/` | SQLAlchemy 表定义与枚举 | 业务判断 |
| `app/schemas/` | 对外契约（请求/响应） | 访问数据库 |
| `app/workers/` | 消费任务、驱动 ComfyUI、更新状态与进度 | 被 HTTP 请求同步调用 |
| `app/core/` | 配置、事件广播、迁移 | 领域逻辑 |

依赖方向单向：`api → services → models`；`workers → services/models`。`core` 可被任何层引用。

## 数据模型

四张表，字段与 `doc/PROJECT.md` 一致：

```
workflows 1 ──< generations 1 ──< generation_tasks 1 ──< images
```

- **workflows** —— 注册表在数据库里的镜像。`enabled` 表示工作流 JSON 是否真的落地。
- **generations** —— 一次用户请求。`requested_count` 是期望图片数，`status` 是聚合状态。
- **generation_tasks** —— 单张图片的执行单元，各自持有 `seed` / `comfy_prompt_id` / `progress`。
- **images** —— 产出文件。`original_image_id` 预留给后续的图片编辑链（编辑结果可追溯到原图）。

`UniqueConstraint("name", "type")` 保证同模型的文生图与编辑各占一行。

### 几个刻意的设计

- **一图一 task**：批量生成不合并成一个 ComfyUI 批次。原因是要支持单张重试、单张取消、单张进度，以及每图独立 seed。
- **image_edit 不记宽高**：Qwen Image 2.1 编辑链路的潜空间由参考图编码器输出决定，宽高仅在切换到空 latent 时才生效。记录 `None` 比记录一个不生效的数字更诚实，前端显示"跟随参考图"。
- **相对路径一律以项目根为基准**：`DATABASE_URL=sqlite:///./data/app.db` 与 `STORAGE_DIR=./storage` 在 `config.py` 中被解析成绝对路径，因此从任何目录启动 uvicorn 都指向同一个库。

## 状态机

```
pending ──► queued ──► running ──► completed
   │           │          │
   └───────────┴──────────┴──► failed / cancelled
```

P1 只会产生 `pending`（没有 Worker 消费）。P2 起由 Worker 推进；`pending → queued` 在取任务时发生，`running` 对应已提交 ComfyUI 且收到首个进度事件。

Derived：`Generation.status` 由子任务聚合——全部 completed 才算 completed，任一 failed 且无运行中任务即 failed。

## 模型注册表

`backend/workflow_configs/registry.yaml` 是**模型目录的唯一数据源**。新增一个模型 = 加一个 `models:` 条目 + 落两个工作流 JSON，不改 Python 代码。`/api/v1/models` 每次请求都重新读取该文件，因此新加的模型刷新页面即可出现。

```yaml
models:
  qwen_image_21:
    label: "Qwen Image 2.1"
    defaults: { steps: 25, cfg: 1.0, sampler: euler, scheduler: simple, denoise: 1.0, width: 1024, height: 1024 }
    capabilities: { exposes_steps: true, exposes_cfg: true, exposes_sampler: true }
    workflows:
      - { type: text_to_image, json: workflows/qwen_image_21_t2i.json, config: workflow_configs/qwen_image_21_t2i.yaml, validated: false }
      - { type: image_edit,   json: workflows/qwen_image_21_edit.json, config: workflow_configs/qwen_image_21_edit.yaml, validated: true }
```

- `capabilities` 控制前端**显示哪些控件**，避免出现"调了不生效"的假参数。Turbo 的步数由固定 sigma 表决定，因此 `exposes_steps: false`。
- `validated` 记录该工作流是否被真实执行过；`available` 由 JSON 文件是否存在决定。
- 启动时 `sync_workflows()` 幂等 upsert 进 `workflows` 表。

## 错误处理约定

- 校验类错误 → `422`，`detail` 是中文可读句子（如"单次最多生成 8 张，收到 9"）。
- 找不到资源 → `404`。
- `/health` **永不返回 5xx**：用 `status=ok|degraded|error` 表达各依赖健康度，让前端能显示"ComfyUI 掉了"而不是整页崩。
- CORS 只放行 `FRONTEND_ORIGIN`。

## P1 的边界

已实现：配置、迁移、四张表、注册表解析、创建记录（含校验与参数回落）、查询接口、WebSocket 握手、健康检查、前端表单与列表。

未实现（刻意留到 P2+）：Worker、ComfyUI 提交与轮询、图片落盘与缩略图、上传参考图、真实工作流 JSON、画廊。
