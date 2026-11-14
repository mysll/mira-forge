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
  ├─ services/ 注册表解析、参数回落、记录创建、参数注入、图片落盘
  ├─ workers/ 单协程 Worker：取 pending → 提交 ComfyUI → 收进度 → 下载产物
  └─ core/events.py 向浏览器 WS 广播 task.updated
  │  httpx / websockets
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

P1 只会产生 `pending`（没有 Worker 消费）。P2 起由 Worker 推进：`pending → queued` 在 `_claim_pending()` 取任务时落库，`running` 表示已拿到 `prompt_id`；`progress` 由 ComfyUI 的 `progress` 事件写 1–99，`completed` 写 100 并回填 `images` 行。

Derived：`Generation.status` 由子任务聚合（`aggregate_generation_status`）——还有活跃任务就跟随它（running > queued > pending），全部终态后：全 completed → completed，全 cancelled → cancelled，否则 failed。终态时写 `completed_at`。

## Worker 实现要点

`app/workers/generation_worker.py`，随 lifespan 启动/停止（`WORKER_ENABLED=false` 可关，测试就是这样关掉的）。

一轮：`_claim_pending()`（取最小 id 的 pending，改 queued）→ `_build_plan()`（组装 API 图）→ `submit()` → `_wait_for_history()` → 下载 → 写 `images` → 更新状态并广播。

几个刻意的选择：

- **进度走 WS，结果以 `/history` 为准**：WS 只用来做进度条，断线/丢消息不影响正确性；`_wait_for_history()` 每秒轮询一次 `/history/{prompt_id}`，直到出现记录或 30 分钟超时。
- **`client_id` 全程一致**：ComfyUI 按 `client_id` 把进度事件路由给提交者，所以 `submit` 和 `progress_messages` 用同一个实例字段。
- **进度写库有节流**（`PROGRESS_MIN_STEP=2`）：ComfyUI 每步都发事件，不做节流会把 SQLite 写爆。
- **失败写 `error_message` 而非抛异常**：任务状态是唯一真相，用户能在 UI 上看到"图片编辑需要参考图，将在 P4 开放"这样的具体原因。
- **`build_prompt` 落点校验**：参数落点不存在直接判失败，不提交一个参数没生效的图。

产物流转：`GET /history` 的 `outputs[output_node]["images"]` 给出 `filename/subfolder/type` → `GET /view` 取字节 → 写 `storage/images/{generation_id}/{task_id}_{i}.png` → 插 `images` 行（宽高优先用 ComfyUI 返回的 `metadata`，缺失时解析 PNG IHDR）。

## 模型注册表

`backend/workflow_configs/registry.yaml` 是**模型目录的唯一数据源**。新增一个模型 = 加一个 `models:` 条目 + 落两个工作流 JSON，不改 Python 代码。`/api/v1/models` 每次请求都重新读取该文件，因此新加的模型刷新页面即可出现。

```yaml
models:
  - id: qwen_image_21_turbo
    label: "Qwen Image 2.1 Turbo"
    default: true            # 前端下拉默认选中它
    defaults: { steps: 8, cfg: 1.0, sampler: euler, denoise: 1.0, width: 1024, height: 1024 }
    capabilities: { exposes_steps: false, exposes_cfg: false, exposes_sampler: false }
    workflows:
      - { type: text_to_image, json: workflows/qwen_image_21_turbo_t2i.json, config: workflow_configs/qwen_image_21_turbo_t2i.yaml, validated: true }
```

- `capabilities` 控制前端**显示哪些控件**，避免出现"调了不生效"的假参数。Turbo 的步数由固定 sigma 表决定，因此 `exposes_steps: false`。
- `default` 标记默认模型；没有标记时前端取第一个。
- `validated` 记录该工作流是否被真实执行过；`available` 由 JSON 文件是否存在决定。
- 启动时 `sync_workflows()` 幂等 upsert 进 `workflows` 表。

## 错误处理约定

- 校验类错误 → `422`，`detail` 是中文可读句子（如"单次最多生成 8 张，收到 9"）。
- 找不到资源 → `404`。
- `/health` **永不返回 5xx**：用 `status=ok|degraded|error` 表达各依赖健康度，让前端能显示"ComfyUI 掉了"而不是整页崩。
- CORS 只放行 `FRONTEND_ORIGIN`。

## 当前阶段的边界

P1 已实现：配置、迁移、四张表、注册表解析、创建记录（含校验与参数回落）、查询接口、WebSocket 握手、健康检查、前端表单与列表。

P2 已实现：四个 API 格式工作流 JSON + 参数绑定 YAML、`prompt_builder`、`comfyui_client`、`generation_worker`、图片落盘、`/images` 接口、WS 事件广播、真实出图。

未实现（刻意留到后续阶段）：缩略图、`POST /generations/edit` 上传参考图、取消与重试、断线恢复、画廊页面（P5）。图片编辑任务在 P2 会被 Worker 判失败并给出明确原因——宁可失败得清楚，也不假装支持。
