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
data/projects/default/{storage/{images,videos,assets}, app.db}
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

## 多项目：一个项目一个文件夹

```
data/projects/
  catalog.json                  项目清单（id / 名称 / 创建时间 / 激活项），原子写
  default/
    app.db                      这个项目自己的 SQLite（WAL）
    storage/{images,videos,assets,thumbnails,uploads}/
  p-20261116-160248-cce4/       新建的项目同样一套
```

为什么是「一项目一文件夹」而不是「一个库加 `project_id` 列」：

| | 一项目一文件夹 | 单库加 project_id |
| --- | --- | --- |
| 隔离 | 物理隔离，删项目 = 删目录 | 每个查询都得带 `where project_id`，漏一处就串数据 |
| 备份/搬走 | 复制目录即可 | 要导数据 |
| 代价 | 连接与存储路径要按项目取 | 只有一处连接 |

代价部分的落法：`models/database.py` 提供 `engine_for(db_path)` / `session_for(project)`，按 db 路径缓存引擎与 session factory；`services/image_service.py` 的每个函数都接受 `storage_root`，Worker 处理哪个项目就传哪个项目的 storage。Worker 主循环按 `list_projects()` 轮转（`self._cursor`），每轮只处理一个任务，保证串行且切项目不影响其它项目的排队任务。

迁移只发生一次：首次启动时 `ensure_catalog()` 建清单，若发现旧的 `data/app.db` 与 `storage/` 存在，就把它们搬进 `data/projects/default/`。之后 `DATABASE_URL` / `STORAGE_DIR` 两个环境变量只作为「迁移来源」保留。

## 数据模型

四张表，字段与 `doc/PROJECT.md` 一致（**每个项目各一套**）：

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
- **image_edit 的宽高只决定像素量级**：Qwen Image 2.1 编辑链路的潜空间由参考图编码器输出决定（`TextEncodeQwenImage21` 的第 3 个输出），宽高仅在切换到空 latent 时才生效。因此编辑时 `width/height` 不会写进 `EmptyLatentImage`，而是换算成 `resolution = round(sqrt(w×h)/32)×32` 交给编码器——输出比例跟随参考图，像素量级由用户选的尺寸决定。前端据此显示"输出比例跟随这张图"。
- **image_to_image 复用同一条编码链路，只换潜空间**：参考图仍然接到 `TextEncodeQwenImage21.images`（1–2 个槽位），但 `latent_image` 来自 `EmptyLatentImage`，所以宽高生效、输出比例由用户决定，参考图只影响条件。三种生成类型因此共用同一套节点与绑定 YAML，区别只在 latent 的来源（编辑 = `["6",2]`，图生图/文生图 = `["6",0]`）。
- **参考图的槽位是配置驱动的**：`workflow_configs/*.yaml` 里 `reference_image.loaders` 列出 `[20, 21]` 两个 `LoadImage`，`prompt_builder` 按张数保留/摘除节点——给 1 张时节点 `21` 与被它引用的 `images.image_2` 一起消失，避免 ComfyUI 去找模版占位文件 `placeholder.png`。
- **相对路径一律以项目根为基准**：`PROJECTS_DIR=./data/projects` 由 `config.py` 解析成绝对路径，因此从任何目录启动 uvicorn 都指向同一批项目；每个项目的库与 storage 再由项目目录推导，不靠环境变量。

## 状态机

```
pending ──► queued ──► running ──► completed
   │           │          │
   └───────────┴──────────┴──► failed / cancelled
```

P1 只会产生 `pending`（没有 Worker 消费）。P2 起由 Worker 推进：`pending → queued` 在 `_claim_pending()` 取任务时落库，`running` 表示已拿到 `prompt_id`；`progress` 由 ComfyUI 的 `progress` 事件写 1–99，`completed` 写 100 并回填 `images` 行。

取消是"旁路"操作：`POST /tasks/{id}/cancel` 直接改库（必要时顺手 `POST /interrupt`），Worker 每轮轮询 `_is_cancelled()`，发现被取消就丢弃结果；`_set_task()` 与 `_fail()` 都拒绝覆盖 `cancelled`，避免竞态把状态改回去。

Derived：`Generation.status` 由子任务聚合（`aggregate_generation_status`）——还有活跃任务就跟随它（running > queued > pending），全部终态后：**任意一张 completed 就算 `completed`**（部分取消不该让已有的图变成失败），全 cancelled → `cancelled`，否则 `failed`。终态时写 `completed_at`。

崩溃恢复：启动时 `reset_interrupted_tasks()` 把上次残留的 `queued`/`running` 任务复位成 `pending` 并清空进度与 `comfy_prompt_id`，Worker 随即续跑。因为产物的唯一真相是 ComfyUI 的 `/history`，残留任务重跑不会产生半成品记录。

## Worker 实现要点

`app/workers/generation_worker.py`，随 lifespan 启动/停止（`WORKER_ENABLED=false` 可关，测试就是这样关掉的）。

一轮：`_claim_pending()`（取最小 id 的 pending，改 queued）→ `_build_plan()`（组装 API 图）→ `submit()` → `_wait_for_history()` → 下载 → 写 `images` → 更新状态并广播。

几个刻意的选择：

- **进度走 WS，结果以 `/history` 为准**：WS 只用来做进度条，断线/丢消息不影响正确性；`_wait_for_history()` 每秒轮询一次 `/history/{prompt_id}`，直到出现记录或 30 分钟超时。
- **`client_id` 全程一致**：ComfyUI 按 `client_id` 把进度事件路由给提交者，所以 `submit` 和 `progress_messages` 用同一个实例字段。
- **进度写库有节流**（`PROGRESS_MIN_STEP=2`）：ComfyUI 每步都发事件，不做节流会把 SQLite 写爆。
- **失败写 `error_message` 而非抛异常**：任务状态是唯一真相，用户能在 UI 上看到具体原因（ComfyUI 未启动、工作流 JSON 缺失、参数落点不存在……）。
- **`build_prompt` 落点校验**：参数落点不存在直接判失败，不提交一个参数没生效的图。
- **编辑先上传参考图**：`_execute()` 用 `POST /upload/image` 把参考图送进 ComfyUI 的 `input/`，拿回 `name` 再写进 `LoadImage.image`。这样 ComfyUI 与 MiraForge 的存储互不依赖路径，重启后也能重跑。

产物流转：`GET /history` 的 `outputs[output_node]["images"]` 给出 `filename/subfolder/type` → `GET /view` 取字节 → 写 `<项目>/storage/{images|videos}/{generation_id}/{task_id}_{i}.{png|mp4}`（按 `media_type` 分目录，视频的封面帧另外压进 `thumbnails/`）→ 插 `images` 行（宽高优先用 ComfyUI 返回的 `metadata`，缺失时解析 PNG IHDR）。

缩略图是**首次请求时生成**的：`GET /images/{id}/thumbnail` 若 `thumbnail_path` 为空就用 Pillow 转 480px JPEG 写盘并回填数据库，之后一直走磁盘缓存（响应带 immutable 的 `Cache-Control`）。普通删除只打 `deleted_at`（文件与缩略图都留在磁盘上，30 天内可从回收站恢复）；只有彻底删除、清空回收站、过期清理这三条路才走 `remove_files`，把原图与缩略图一起移除。

## 前端结构

一期前端是「左窄导航 + 右创作工作区」的两栏工作台，没有第三栏。导航七项，用两条细分隔线分成三组：首页 `/`（落地页，两个创作入口）、资产 `/gallery`、工具 `/tools`（本地处理，不吃 GPU）、回收站 `/trash`、图片 `/compose`（默认文生图，框内可切图片编辑）、视频 `/video`、设置 `/settings`。详细设计见 [FRONTEND.md](FRONTEND.md)。

| 位置 | 作用 |
| --- | --- |
| `app/layout.tsx` | 两栏外壳：72px `Sidebar` + `main`（顶栏 / 内容 / 创作框三段式） |
| `app/page.tsx` | 首页：创作入口、本机状态（设备 / 显存 / 项目）、最近作品、模型卡与灵感提示词 |
| `app/compose/page.tsx` | 创作页：筛选状态、`GET /generations` 拉取、扁平化为 `FeedSlot`（每个任务一格，未出图为占位卡）、各类操作的 Toast |
| `app/settings/page.tsx` | 系统状态（后端版本、SQLite、ComfyUI、GPU、存储路径） |
| `app/gallery/page.tsx` | 资产页：图片级平铺网格，按日期分组、按 `image.created_at` 倒序，不带批次分组 |
| `app/tools/page.tsx` | 工具目录：卡片网格，第一张是图片编辑器，其余为「计划中」占位 |
| `app/tools/editor/page.tsx` | 本地图片编辑器：抠背景、改画布、等比放置、导出 PNG（`?image=<id>` 从资产带图进来） |
| `components/editor/*` · `lib/editor.ts` · `stores/editor.ts` | 画布舞台、右侧参数面板、纯几何放置算法、撤销栈 |
| `hooks/useImageActions.ts` | 收藏 / 下载 / 删除 / 继续编辑 / 重新生成，两个页面共用 |
| `components/Composer.tsx` | 底部创作框：模式、提示词、参考图、参数 pill、高级面板、提交 |
| `components/Feed.tsx` / `FeedCard.tsx` | 按日期分组的作品流与单张卡片 |
| `components/ImageDetail.tsx` | 大图详情弹窗与五类操作 |
| `components/TopBar.tsx` / `Sidebar.tsx` / `Popover.tsx` / `ToastStack.tsx` | 顶栏、导航、参数弹层、轻提示 |
| `stores/composer.ts` | Zustand：创作框状态，模式各存一份提示词 |
| `stores/reference.ts` | Zustand：参考图来源（本地文件 / 已生成图片）与 `autoEdit` 标记 |
| `hooks/useTaskEvents.ts` | 订阅 `/ws/tasks`，收到事件后节流 invalidate React Query |

跨页面的共享状态有两处：创作框草稿（切到设置页再回来不丢）和参考图（作品流点「继续编辑」写入 store，创作框消费 `autoEdit` 自动切编辑模式）。界面状态走 Zustand 而不是 URL query，因为 `useSearchParams()` 在 layout 层会破坏静态生成，且未提交的提示词不该进浏览器历史。

## 模型注册表

`backend/workflow_configs/registry.yaml` 是**模型目录的唯一数据源**。新增一个模型 = 加一个 `models:` 条目 + 落两个工作流 JSON，不改 Python 代码。`/api/v1/models` 每次请求都重新读取该文件，因此新加的模型刷新页面即可出现。

```yaml
models:
  - id: qwen_image_21_turbo
    label: "Qwen Image 2.1 Turbo"
    default: true            # 前端下拉默认选中它
    defaults: { steps: 8, cfg: 1.0, sampler: euler, denoise: 1.0, width: 1024, height: 1024 }
    capabilities: { exposes_steps: false, exposes_cfg: true, exposes_sampler: true }
    workflows:
      - { type: text_to_image, json: workflows/qwen_image_21_turbo_t2i.json, config: workflow_configs/qwen_image_21_turbo_t2i.yaml, validated: true }
```

- `capabilities` 控制前端**显示哪些控件**，避免出现"调了不生效"的假参数。Turbo 的步数由固定 sigma 表决定，因此 `exposes_steps: false`；但它的 CFG 是 `CFGGuider.cfg`、采样器是 `KSamplerSelect.sampler_name`，两者都与 sigma 表无关、改了真生效（CFG>1 时负面提示词才进采样，换采样器仍沿用那张固定 8 步表），所以 `exposes_cfg` 与 `exposes_sampler` 都是 `true`。
- `default` 标记默认模型；没有标记时前端取第一个。
- `validated` 记录该工作流是否被真实执行过；`available` 由 JSON 文件是否存在决定。
- 启动时 `sync_workflows()` 幂等 upsert 进 `workflows` 表。

## 错误处理约定

- 校验类错误 → `422`，`detail` 是中文可读句子（如"单次最多生成 8 张，收到 9"）。
- 找不到资源 → `404`。
- `/health` **永不返回 5xx**：用 `status=ok|degraded|error` 表达各依赖健康度，让前端能显示"ComfyUI 掉了"而不是整页崩。
- CORS 只放行 `FRONTEND_ORIGIN`。

## 一期的完成状态

P1：配置、迁移、四张表、注册表解析、创建记录（含校验与参数回落）、查询接口、WebSocket 握手、健康检查、前端表单与列表。

P2：四个 API 格式工作流 JSON + 参数绑定 YAML、`prompt_builder`、`comfyui_client`、`generation_worker`、图片落盘、`/images` 接口、WS 事件广播、真实出图。

P3：任务进度均值、生成记录展开详情（每 task 的 seed 与进度）、比例 + 分辨率档的尺寸面板、图片墙。

P4：`POST /generations/edit`（multipart）、参考图上传到 ComfyUI、`GET /generations/{id}/reference`、`reference_image_path` 列（迁移 `0002`）、编辑链路真实出图。

P5：Pillow 缩略图与缓存、`DELETE /images/{id}`、画廊页与分页、Zustand 参考图 store、"用作参考图"跨页跳转。

P6：任务取消（含 `POST /interrupt`）、任务重试（同记录下追加新 seed）、启动时残留任务复位、前端实时刷新（WS + 轮询）、`_set_task`/`_fail` 的取消竞态防护。

P7：前端重构为两栏工作台（作品流 / 底部创作框 / 详情弹窗 / 设置页）；后端相应增补——`generations` 增加 `negative_prompt / steps / cfg / sampler`（迁移 `0003`）、`images` 增加 `is_favorite`、`GET /generations` 支持 `q / model / favorite / date_from / date_to` 且直接返回批次内图片、`POST /images/{id}/favorite`、`/health` 暴露 `storage_path` 与 `max_generation_count`。

P8：多项目（一个项目一个文件夹，`engine_for` / `session_for` 按项目取引擎）、参考图生成（`image_to_image`，1–2 张参考图，迁移 `0004`）、资产库与批量删除 / 清空工作区。

P9（视频二期，MiniMax H3）：`text_to_video` / `image_to_video` 两种类型、`images` 表扩成「产物表」（`media_type` / `duration_seconds` / `fps` / `frame_count`，迁移 `0005`）、首帧 / 尾帧可选（都不给即退化为文生视频）、`/video` 工作台、`<video>` 播放与海报帧。

## 视频：为什么复用同一张 `images` 表

视频产物和图片产物在业务上是同一种东西——「某次生成的一张产出」，都要进作品流、收藏、删除、详情。差别只在文件类型与几个元信息，所以 `images` 加了 `media_type`（`image` / `video`）和 `duration_seconds` / `fps` / `frame_count`，而不是新开一张 `videos` 表（那会让作品流、收藏、清空工作区全部出现两条代码路径）。

`GET /images/{id}/file` 按 `media_type` 决定 `Content-Type`（`image/png` / `video/mp4`）并加 `Accept-Ranges`，因为浏览器播放视频要先发 Range 请求。缩略图对视频来说就是**海报帧**：Worker 用 `ImageFromBatch` 抽第 0 帧，Pillow 压成 `thumbnails/{generation_id}/{id}.jpg`，列表与 hover 都用它；`ensure_thumbnail` 遇到没有海报的视频会直接报错，而不是拿 Pillow 去解 mp4。

视频只有一条产物：`count` 必须是 1（一次请求一条），所以 Worker 的「每任务一张图」逻辑不需要改，只是扩展名变成 `.mp4`、落盘时多写几个 metadata 字段。

二期（视频）已落地；参考视频（r2v）与视频编辑仍不在范围内。

## 本地编辑器：为什么不在 ComfyUI 里

`/editor/*` 是唯一一条**不经过 ComfyUI** 的图片处理链路，理由是它要解决的问题不需要生成模型：

- 「抠纯色背景」「按主体裁边」「把主体放进指定画布」都是确定的像素运算，用 AI 反而会引入不可控的重绘（主体会被悄悄改掉五官或衣服花纹），而这个工具的价值恰恰是**一个像素都不动主体**。
- 它跑在 FastAPI 进程的 CPU 上（numpy + scipy + Pillow），不占那 16 GB 显存，也不跟生成任务抢 GPU；1024×1024 一张抠底约 1.3 秒，足够交互。
- 它不写 `images` 表、不产生生成记录，产物由浏览器直接下载。因为它是「修图」，不是「生成」——把编辑器产物混进作品流会让「哪些是模型生成的」这件事变得模糊。

算法只有两条路径，都作用在 alpha 通道上：`edge` 先用 `scipy.ndimage.label` 做连通域标记，只把接触画布边缘的同色区抠掉（保住主体内部的白衬衫、白眼睛）；`color` 直接按颜色距离删所有同色像素（用来清主体内部残留的封闭背景块）。颜色距离可选 `max` / `mean` / `luma`，底色默认取边框像素的中位数（渐变背景也不会只挑到一个色）。

放置永远等比：`placementFor()` 只按「画布高度 × 高度百分比」算高度，宽度由原图 `naturalWidth / naturalHeight` 推出来，因此不可能变形；`bottom` 是主体底边到画布底边的最小间距，`offsetX` 是相对画布中心线的水平偏移。
### 清晰度：预览、导出、和物理上限

三件事必须分开看，否则很容易把「预览放大后模糊」当成 bug：

1. **预览** 是 `缩放 × devicePixelRatio` 重绘的画布（最高 4×）。所以 256×256 的画布放到 270% 时，是用 1024px 的原图重新画的，看着清楚——但它**不代表导出文件也是这个密度**，状态条因此同时显示「画布 256×256」与「导出 256×256」。
2. **导出** 的像素数是 `画布 × 倍率`（1×/2×/4×，最长边 8192 封顶）。倍率只乘像素、不乘构图：主体在 1× 是 230px、2× 就是 460px，位置和比例完全一致。想要大图就调倍率，因为主体是从原图直接重采样的，比「先导出 256 再放大」干净得多。
3. **物理上限**：把主体高度百分比拖到超过 100%、或画布大于原图，就是在要求插值补细节，一定发软。面板在 `upscaleRatio() > 1.02` 时直接给出黄色警告，指向倍率而不是拖大。

顺带把「大幅缩小」这一路也做干净了：`drawScene` 在目标小于源图一半时先按 1/2 逐级降采样再落笔（最多 5 级），1024 → 230 这种 4 倍以上缩小不会因为一次性重采样而边缘发虚。
### 保存成品：一条 `local_edit` 记录，而不是新表

编辑器导出的是「已经完成的字节」，没有采样过程，但用户希望它在资产库里和生成图一样能看、能收藏、能删。所以保存时后端不建新表，而是补一条最小的 `generations` 行（`generation_type = local_edit`、`model_name = local_editor`、`status = completed`）+ 一条 `generation_tasks` 行（`progress = 100`、`seed` 为空）+ 一张 `images` 行，产物照常落在 `storage/images/{generation_id}/`。

这样做的好处是资产页、详情弹窗、收藏、下载、删除、`GET /generations?media=image` 全都不用改；代价是 `generation_tasks.seed` 必须可空（迁移 `0006_local_edit`），以及前端类型标签要认识 `local_edit`。带原图保存时，`images.original_image_id` 与 `generations.reference_image_path` 记录来源，详情弹窗里就能看到「来自图 #N」。
## 序列帧工坊：原版就地改造后内嵌

工坊这条线绕了三圈，值得记下来，因为它解释了「为什么最后是改上游源码」。

1. **第一版：同源 iframe**。原版是三件套静态文件（`index.html` / `app.js` / `styles.css`，无构建、无依赖、无网络），放进 `public/` 再用 `<iframe>` 套起来最省事。代价是壳和工具是两份文档：工具自己的「导入视频 / 导入图集」永远只开本机文件框，壳上挂「从资产导入」只能拿 `DataTransfer` 伪造一次 `change`；导出要靠「覆写 `HTMLAnchorElement.prototype.click` 截 blob」，还得轮询 iframe 的 `readyState` 才挂得上钩子。
2. **第二版：自己重写**。照它写了一个原生 React 三栏页，输入走「本机 / 资产」两条同构路径，导出直接 `saveAsset()`。但功能上丢了原版的序列帧轨道、播放预览、多序列、分页弹窗、取色与透明度——**重写等于把上游每个细节都重新实现一遍，还永远追不上**。
3. **现在：原版就地改造，同一文档内挂载**。上游 `D:\AI\SpriteForge` 是我们自己的项目、不会再动，所以直接改 vendor 副本而不是在运行期打补丁。

`frontend/public/tools/spriteforge/` 三件套相对上游只有三处改动（详见该目录的 `README.md`）：

- **启动时机**：末尾暴露 `window.MiraSpriteForge = { boot, destroy, importFile, snapshot }`，页面在 `(0, eval)` 之后再调 `boot()`。不能在这个文件里直接 `init()`——`init()` 会同步走到 `renderFrameGrid` → `hideFramePeek`，而 `framePeekShowTimer` 等几个 `let` 声明在它后面，直接调用会踩 TDZ（`Cannot access 'framePeekShowTimer' before initialization`，表现为「视频载入失败」）。
- **导入来源**：四个导入入口（顶栏两个 + 左栏两个）统一走 `requestImport(kind, anchor)`，先问 `window.MiraForgeToolBridge.chooseSource()` 弹「从本机上传 / 从资产选」；没有宿主桥接时自动回落到原版文件框。选资产时页面用 `DataTransfer` 把文件塞进 `#videoInput` / `#atlasInput` 并派发 `change`，工具无感。
- **保存到资产**：`exportAtlasZip()` 拆成 `buildAtlasZip()`（拿 blob）+ `exportAtlasZip()`（下载）+ `saveAtlasZip()`（交给 `bridge.saveAsset`）；导出弹层因此多一个「保存到资产」按钮，点击后走 `POST /assets`，不再经手 `<a download>`。

另外把全局监听统一登记到 `hostListeners`（`destroy()` 时逐个摘掉），并给 `loadVideoFile()` 加了 `videoLoadToken`：连续导入两支视频时，晚到的旧一次 `loadedmetadata` 不会覆盖新的那支。

页面侧 `frontend/app/tools/spriteforge/page.tsx` 只负责：`fetch` 三件套 → `DOMParser` 注入 body 标记 → 挂 `tool.css`（选择器都加了 `.sf-app` 前缀，样式不会外泄）→ `(0, eval)` → `boot()`；同时提供 `window.MiraForgeToolBridge`（`chooseSource` / `saveAsset`）与 `?video=` / `?asset=` 两条深链。顶栏不再叠标题——工具自己有品牌条，左侧栏也有「工具」入口。

## 素材（assets）：为什么复用 `images` 表

序列帧工坊导出的是 `.zip`（图集 + `atlas.json`）或单张 PNG，它们既要出现在资产库、又要能收藏 / 下载 / 删除。如果新开一张 `assets` 表，就得把 `GET /images`、`POST /images/{id}/favorite`、批量删除、清空工作区、缩略图、`/images/{id}/file` 全部复制一遍。

所以素材就是 `images` 里 `media_type = "asset"` 的一行，文件落 `<项目>/storage/assets/<generation_id>/<task_id>_0.<ext>`（和 `images/`、`videos/` 同级，这也是用户要求的目录结构），并且：

- 每条素材同时有一条 `GenerationType.LOCAL_ASSET` 的 generation + 一条已完成的 task，`seed` 为 `null`——这样作品流的时间线、批次号、`GET /generations?media=asset` 都不用特殊分支；
- 缩略图不一定是「解码出来的」：ZIP 由后端取里面第一张 PNG 交给 Pillow 压成 `thumbnails/`，JSON 没有图，`/thumbnail` 就返回 404，前端退化成文件牌；
- `GET /images/{id}/file` 的 `Content-Type` 按后缀给（`application/zip` / `application/json` / 图片类型），否则浏览器会把 ZIP 当图片渲染失败。

## 序列帧工坊的帧与图集约定

- 抽帧结果在内存里是 `HTMLCanvasElement`，导出时才编码；抠背景作用在 canvas 上，所以「先抠色再打图集」与「先打图集再抠色」结果一致。
- 图集是「按页」的：`cols × rows` 决定每页容量，超出自动开新页；`cellWidth/cellHeight` 是格子的像素尺寸，帧在格内等比缩放居中（`scale` 控制格内占比上限）。
- 导入时按 `pages[].file` 的名字匹配 ZIP 里的 PNG（数值排序），再按 `sequences[].frames[]` 逐帧 `drawImage(page, x, y, width, height, ...)` 还原成独立 canvas——所以「导出 zip → 存进资产 → 从资产打开」能拿回一模一样的帧数（实测 73 帧 / 2 页 / 6912×2880）。

## 回收站：删除为什么是打戳

用户要的「删错了能捞回来」和「30 天后自动清掉」在存储上是两件互相拉扯的事：要能恢复，文件就不能在删除那一刻消失；要能自动清掉，就必须有人知道「什么时候删的」。最简单的做法是**就地把删除记成时间戳**，而不是把文件挪进 `.trash/` 目录、或者建一张 `deleted_images` 影子表：

- 挪文件会让 `file_path` 在删除与恢复之间变化，缩略图缓存、`/images/{id}/file` 的 URL、工坊里打开的深链全部要跟着搬；打戳则文件原地不动，恢复只是把时间戳清掉，零拷贝。
- 影子表要把 `images` 的每一列抄一遍，还得同步缩略图、素材、视频三种 `media_type` 的特殊字段；打戳只加一列。
- 三张表都要标记：`images`、`generation_tasks`、`generations`（迁移 `0007_recycle_bin`，每张表加 `deleted_at` + 索引）。批次被整批删时三者一起打戳；只删了其中几张图时批次还在，只是那几格的产物不见了。

写入侧只有一处入口：`app/services/recycle_service.py` 的 `soft_delete_images` / `soft_delete_task` / `soft_delete_generation`，`DELETE /images/{id}`、`POST /images/batch-delete`、`POST /images/clear`、`DELETE /tasks/{id}`、`DELETE /generations/{id}` 全部改调它们（`clear_workspace` 也是给全表打戳，不再 rmtree）。

读取侧统一在查询里过滤：`list_images`、`GenerationRepository._filtered`、`_to_read`（过滤批次下的 `images` 与 `tasks`，`progress` 只按未删任务算）都带 `deleted_at.is_(None)`。**例外是 `/images/{id}/file` 与 `/images/{id}/thumbnail`**——回收站里的卡片要有预览，这两个端点故意不过滤。

恢复不是「只把图放回来」：`restore_images` 在清掉产物的戳之后，还要把它的 `task` 与 `generation` 的 `deleted_at` 一起清掉。否则图回来了、所属批次却还在回收站里，作品流里根本看不见它，用户会以为恢复失败。

真正删文件只发生在三处，都只删记录与文件、不做别的：`delete_forever`（回收站里点「彻底删除」）、`clear_bin`（「清空回收站」）、`purge_expired`（`deleted_at <= now - 30 天`）。`purge_expired` 在 **lifespan 启动时**与**每次 `GET /recycle-bin`** 时各跑一次，所以不需要定时任务或外部调度；`delete_forever` 之后还会调 `_drop_empty_generations`，把回收站里已经没有产物的批次连同任务一起清掉。

```text
删除 → soft_delete_*  只打 deleted_at（文件不动）
恢复 → restore_images 清戳 + 解冻 task/generation
彻底删除 / 清空 / 过期 → remove_files 才删原图与缩略图
```

