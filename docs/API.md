# API 参考

Base URL：`http://127.0.0.1:8000/api/v1`
交互式文档：`http://127.0.0.1:8000/docs`

## 约定

- 请求/响应均为 `application/json`（P4 的图片编辑为 `multipart/form-data`）。
- 错误统一为 `{"detail": "中文可读原因"}`。
- 状态码：`200` 查询成功 · `201` 创建成功 · `404` 资源不存在 · `422` 参数校验失败。
- 时间字段为 ISO 8601 UTC（`2026-11-14T07:51:03Z`）。
- **所有生成、任务、图片接口都作用于「当前激活项目」**：一个项目一套库与图片目录，切换项目后同一个 `GET /generations` 看到的是另一批数据。

## 项目

一个项目 = `data/projects/<id>/` 一个文件夹（`app.db` + `storage/images|videos|thumbnails|uploads`），项目清单在 `data/projects/catalog.json`。

### `GET /projects`

```json
{
  "active": "default",
  "items": [
    {
      "id": "default",
      "name": "默认项目",
      "created_at": "2026-11-16T08:00:12",
      "is_active": true,
      "path": "D:/AI/MiraForge/data/projects/default",
      "database_path": "D:/AI/MiraForge/data/projects/default/app.db",
      "storage_path": "D:/AI/MiraForge/data/projects/default/storage"
    }
  ]
}
```

### `POST /projects`

```json
{ "name": "角色设定", "activate": true }
```

`201`，返回新建项目的 `ProjectRead`。创建时就会建目录、跑迁移、把工作流同步进这个新库（所以新项目一建好就有 6 个工作流、0 张图）。名称：去空后 1–40 字、大小写不敏感查重（重名 `422 已经有叫「x」的项目了`）。`activate` 默认 `true`，即建完立刻切过去。

### `PATCH /projects/{id}`

`{ "name": "新名字" }` → 改名（只改清单，不动文件夹，id 不变）。

### `POST /projects/{id}/activate`

切到某个项目。之后所有接口都读写这个项目的库与图片目录。

### `DELETE /projects/{id}`

返回删除后的 `ProjectListResponse`。

- `422`：`至少要保留一个项目`（默认项目也不例外）。
- `409`：`项目「x」还有 N 个任务在排队或生成，请先等完成或取消`。
- 成功时先释放 SQLite 连接再删文件夹（Windows 上不释放会删不掉 `app.db`）；删掉的是激活项目时会自动切到剩下的第一个。

## 健康检查

### `GET /health`

永不返回 5xx；依赖异常通过 `status` 表达。

```json
{
  "status": "ok",
  "app": "MiraForge",
  "version": "0.1.0",
  "project_id": "default",
  "project_name": "默认项目",
  "project_path": "D:/AI/MiraForge/data/projects/default",
  "database": { "status": "ok", "detail": null, "path": "D:/AI/MiraForge/data/projects/default/app.db" },
  "comfyui": {
    "status": "ok",
    "detail": null,
    "url": "http://127.0.0.1:8188",
    "reachable": true,
    "version": "0.44.0",
    "device": "cuda:0 NVIDIA GeForce RTX 5070 Ti : cudaMallocAsync",
    "error": null,
    "vram_total": 17066033152,
    "vram_free": 2380563372
  },
  "storage": { "status": "ok", "detail": "D:/AI/MiraForge/data/projects/default/storage" },
  "storage_path": "D:/AI/MiraForge/data/projects/default/storage",
  "max_generation_count": 8
}
```

`status` 取值：`ok`（全部正常）· `degraded`（DB 正常但 ComfyUI 或存储异常）· `error`（DB 不可用）。
`storage_path` 与 `max_generation_count` 供前端「设置 → 系统状态」页展示，不用再读环境变量。
`project_id / project_name / project_path` 说明当前激活的是哪个项目——多项目下，`/health` 报的 DB 与存储路径都是激活项目自己的。`comfyui.vram_total / vram_free` 是显存字节数（ComfyUI 不可达时为 `null`），设置页用它显示占用比例。

### `POST /comfyui/unload`

让 ComfyUI 卸载已加载的模型、把显存还回来（对应 ComfyUI 的 `POST /free`，body `{"unload_models": true, "free_memory": true}`）。
设置页「ComfyUI」卡片上的「卸载模型 · 释放显存」按钮就是调它。

因为 ComfyUI 收到 `/free` 只是给队列打标记、真正卸载发生在它跑下一轮队列时，这个接口会**轮询最多约 3 秒**，等空闲显存涨上来（或超时）再返回。

```json
{
  "ok": true,
  "url": "http://127.0.0.1:8188",
  "vram_total": 17066033152,
  "vram_free_before": 2380170156,
  "vram_free_after": 15647637504,
  "freed": 13267467348,
  "detail": null
}
```

ComfyUI 不可达时不抛 5xx，而是 `{"ok": false, "detail": "ConnectionError: ..."}`，前端直接把 `detail` 显示出来。
副作用：下一次生成会重新加载模型，首张会慢一些（约 10–15 秒）；已生成的图片与工作流不受影响。

## 模型目录

### `GET /models`

```json
{
  "items": [
    {
      "id": "qwen_image_21_turbo",
      "label": "Qwen Image 2.1 Turbo",
      "description": "8 步蒸馏版，速度优先；步数由固定 sigma 表决定，CFG 与采样器可调（sigma 表按 euler 调过）",
      "defaults": { "steps": 8, "cfg": 1.0, "sampler": "euler", "denoise": 1.0, "width": 1024, "height": 1024 },
      "capabilities": { "exposes_steps": false, "exposes_cfg": true, "exposes_sampler": true },
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
- `validated`：该工作流是否真实跑通过。当前图片侧 9 条（Qwen Image 2.1 三条、Qwen Turbo 三条、Z-Image Turbo / Klein Distilled / Klein Base 各一条文生图）都是 `true`，视频两条是 `true`。
- 当前注册表里有 6 个模型、13 条工作流：Qwen Image 2.1（4）、Qwen Image 2.1 Turbo（4）、Z-Image Turbo（1）、FLUX.2 Klein 4B Distilled（1）、FLUX.2 Klein 4B Base（1）、MiniMax H3（2）。

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
| `generation_type` | 是 | `text_to_image` \| `image_edit` \| `text_to_video` |
| `width` / `height` | 否 | 64–4096；缺省回落到模型 defaults。**image_edit 时它只决定像素量级**（输出比例跟随参考图），见下文编辑接口 |
| `count` | 否 | 1–`MAX_GENERATION_COUNT`（默认 8），每张独立 task + 独立 seed |
| `seed` | 否 | 给定则固定 seed，N 张时按 `seed, seed+1, …` 递增；缺省随机且批内不重复 |
| `steps` / `cfg` / `sampler` | 否 | 高级参数，落库并在 Worker 组装工作流时注入；工作流绑定表里没有对应落点的模型（如 Turbo）会被自动跳过 |
| `negative_prompt` | 否 | 负面提示词；缺省空串。**不填 `cfg` 时后端会自动把 CFG 提到模型的 `negative_prompt_cfg`**（标准 3.0 / Turbo 2.0）——因为 ComfyUI 在 cfg=1 时会跳过负面分支，写了也等于没写；显式填了 `cfg` 就一律用你的值 |

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

失败时 `status` 为 `failed`，`error_message` 是中文原因（例如 ComfyUI 未启动、工作流 JSON 缺失、模型名不在 ComfyUI 的清单里）。
取消或部分取消时 `status` 可能是 `cancelled` / `completed`（有图就算完成，见「任务」一节）。

校验失败示例：

```
422 {"detail": "单次最多生成 8 张，收到 9"}
422 {"detail": "未知模型 'nope'，可选: qwen_image_21, qwen_image_21_turbo"}
422 {"detail": "prompt 不能为空"}
422 {"detail": "模型 Qwen Image 2.1 不支持 image_edit"}
```

### `GET /generations?limit=20&offset=0`

分页列表，按创建时间倒序。`items[]` 为完整的 `GenerationRead`（含 `tasks`、`images`、`progress`），作品流一次请求就能渲染出图墙，不需要再按批次逐条查图片。

| 查询参数 | 说明 |
| --- | --- |
| `limit` / `offset` | 分页，`limit` 1–100 |
| `q` | 提示词模糊匹配（`LIKE %q%`） |
| `model` | 模型 id，多个用逗号分隔 |
| `media` | `image` / `video` / `asset`：只要图片批次、视频批次或素材批次；其它值 422（`media 只能是 image、video 或 asset`）。创作页固定传 `image`，视频页固定传 `video`，资产页按用户筛选传 |
| `favorite` | `true` 时只返回「批次内至少有一张被收藏」的记录 |
| `has_products` | `true` 时只返回「已经有产物」或「有任务在 pending/queued/running」的批次，跳过只剩空壳的批次（图被删光、失败且没产物）。首页「最近作品」与图片/视频计数用的就是这条 |
| `date_from` / `date_to` | ISO 时间，按 epoch 比较（避开 SQLite 时区字符差异）；非法值 422 |

```json
{ "items": [ { "id": 15, "status": "completed", "progress": 100, "model_name": "qwen_image_21_turbo", "tasks": [ … ], "images": [ { "id": 32, "width": 1024, "height": 1024, "is_favorite": false, … } ] } ], "total": 15, "limit": 20, "offset": 0 }
```

`progress` 是该记录下所有任务进度的平均值（8 张里前 7 张完成也不会显示 99%）。

### `GET /generations/{id}`

返回单个 `GenerationRead`（含 `tasks`、`images`、`reference_images`）。不存在返回 `404`。

`reference_images` 是**相对 `STORAGE_DIR`** 的路径数组：文生图为空，编辑为 1–2 张，图生图为 1–2 张。

### `POST /generations/edit`

图片编辑：`multipart/form-data`。除参考图外字段与 `POST /generations` 相同。

带 `mask` 时返回的 `generation_type` 是 **`image_inpaint`**（局部编辑）：只有遮罩涂到的地方会被重绘，其余像素由 `VAEEncode + SetLatentNoiseMask` 原样保留；不带 `mask` 就还是 `image_edit`（整图重绘）。前端「图片编辑」页签下面这两个是同一个输入区，区别只在于画不画遮罩。

**第 1 张决定被编辑的画面**（结构、比例、构图都跟着它），**第 2 张可选**，只当补充信息用——典型用法是「第 1 张放角色、第 2 张放服装」，让模型把第 2 张的衣服换到第 1 张身上。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | 是 | 编辑指令，例如「把服装换成第二张图的样式，其余保持不变」 |
| `model` | 是 | 支持 `image_edit` 的模型 id |
| `images` | 是 | 1–2 张（第 2 张可选）；PNG / JPEG / WEBP；单张 ≤ 20 MB；按文件魔数校验 |
| `count` | 否 | 1–8，同一次编辑出多张变体 |
| `width` / `height` | 否 | 只决定像素量级：Worker 传 `resolution = round(sqrt(w×h)/32)×32`（夹在 256–4096） |
| `mask` | 否 | 遮罩 PNG（灰度：**白色 = 要重绘**，黑色 = 保持原样），尺寸建议与第 1 张参考图一致；带上就走局部编辑 |

```bash
curl -X POST http://127.0.0.1:8000/api/v1/generations/edit \
  -F "prompt=把服装换成第二张图的样式，其余保持不变" \
  -F "model=qwen_image_21_turbo" \
  -F "count=1" \
  -F "images=@D:/AI/MiraForge/data/case-ref1.png" \
  -F "images=@D:/AI/MiraForge/data/case-ref2.png"

# 局部编辑：只有遮罩覆盖的地方会被重绘
curl -X POST http://127.0.0.1:8000/api/v1/generations/edit \
  -F "prompt=胸口加一条红围巾，其余保持不变" \
  -F "model=qwen_image_21_turbo" \
  -F "images=@D:/AI/MiraForge/data/case-ref1.png" \
  -F "mask=@D:/AI/MiraForge/data/case-mask.png"
```

返回结构与 `POST /generations` 相同（`201`）。错误：

```
422 {"detail": "图片编辑至少需要 1 张参考图（第 1 张定结构）"}
422 {"detail": "图片编辑最多 2 张参考图（第 2 张可选），收到 3 张"}
422 {"detail": "第 2 张参考图需要是 PNG / JPEG / WEBP 图片"}
422 {"detail": "参考图不能超过 20 MB"}
```

工作流侧：两张图分别接到编码器的 `images.image_1` / `images.image_2`，潜空间取编码器输出的 `[6, 2]`（**按第 1 张的尺寸对齐**，所以编辑结果的尺寸跟随第 1 张，与 `width` / `height` 无关）；只给 1 张时第二个 `LoadImage` 节点与 `images.image_2` 会被自动摘掉。

局部编辑换一套图（`qwen_image_21_inpaint.json` / `qwen_image_21_turbo_inpaint.json`）：第 1 张参考图同时进编码器条件与 `VAEEncode`，遮罩进独立的 `LoadImage` → `ImageToMask(red)` → `SetLatentNoiseMask`，采样在带噪声掩码的 latent 上跑。遮罩缺失或工作流没配 `mask` 落点时直接拒绝（`422`），不会静默退化成整图重绘。

### `GET /generations/{id}/mask`

回吐这条局部编辑的遮罩 PNG（`image/png`）。只对 `image_inpaint` 有意义，其余类型返回 `404 {"detail": "generation 12 没有遮罩"}`；记录在但文件被挪走时返回 `404 {"detail": "遮罩文件缺失：uploads/xxx.png"}`。

`GenerationRead` 里的 `has_mask` 就是这条记录的摘要位——前端据此在详情里画「遮罩」缩略图，不必先请求字节。

### `POST /generations/image-to-image`

图生图：`multipart/form-data`，字段与 `POST /generations` 相同，外加 `images`（1–2 张）。`generation_type` 固定为 `image_to_image`。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | 是 | 想要的画面；参考图只影响构图/材质，不会被原样复制 |
| `model` | 是 | 支持 `image_to_image` 的模型 id |
| `images` | 是 | 1–2 张；PNG / JPEG / WEBP；单张 ≤ 20 MB；按文件魔数校验 |
| `width` / `height` | 否 | **生效**（与文生图一致，落到工作流里的 `EmptyLatentImage`） |
| `count` | 否 | 1–8 |

```bash
curl -X POST http://127.0.0.1:8000/api/v1/generations/image-to-image \
  -F "prompt=put the teapot and the lamp on a stone table in a rainy neon alley" \
  -F "model=qwen_image_21_turbo" \
  -F "width=1024" -F "height=1024" -F "count=1" \
  -F "images=@D:/AI/MiraForge/storage/images/22/52_0.png" \
  -F "images=@D:/AI/MiraForge/storage/images/21/48_0.png"
```

返回结构与 `POST /generations` 相同（`201`）。错误：

```
422 {"detail": "图生图最多 2 张参考图，收到 3 张"}
422 {"detail": "图生图需要至少 1 张参考图"}
422 {"detail": "第 2 张参考图需要是 PNG / JPEG / WEBP 图片"}
```

工作流侧：参考图接到编码器的 `images.image_1` / `images.image_2`，潜空间来自 `EmptyLatentImage`（这点与图片编辑相反），只有 1 张参考图时第二张的 `LoadImage` 节点会被自动摘掉。

### `POST /generations/image-to-video`

图生视频：`multipart/form-data`，字段同上，外加 `files`（0–2 张，第一张当首帧、第二张当尾帧）。`generation_type` 固定为 `image_to_video`；**一张都不给时后端自动按 `text_to_video` 落库**（所以前端也可以直接走 `POST /generations`）。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | 是 | 镜头描述：主体、动作、镜头运动、光线 |
| `model` | 是 | 支持 `image_to_video` 的模型 id（当前 `minimax_h3`） |
| `files` | 否 | 0–2 张；按顺序是首帧、尾帧；PNG / JPEG / WEBP；单张 ≤ 20 MB |
| `duration_seconds` | 否 | 1–15 秒的整数（`capabilities.duration_min/max`）；3 / 5 / 8 / 10 是前端快捷档，缺省取模型默认 |
| `fps` | 否 | 1–120，缺省 24 |
| `width` / `height` | 否 | 必须是 32 的倍数；前端按「比例 × 480p/720p/1080p」算，例如 864×480、1280×736、1920×1088 |
| `count` | 否 | 1–4，缺省 1；串行生成，每条独立 seed |
| `seed` | 否 | 0–2³¹−1；批量时按 `seed, seed+1, …` 依次派生 |

```bash
curl -X POST http://127.0.0.1:8000/api/v1/generations/image-to-video \
  -F "prompt=the teapot slowly starts steaming, rain intensifies, gentle push in" \
  -F "model=minimax_h3" \
  -F "duration_seconds=5" -F "width=864" -F "height=480" \
  -F "files=@D:/AI/MiraForge/data/probe-video-frame.png"
```

错误：

```
422 {"detail": "视频一次最多生成 4 条，收到 5"}
422 {"detail": "视频时长需要在 1–15 秒之间，收到 20"}
422 {"detail": "视频宽度必须是 32 的倍数，收到 900"}
422 {"detail": "图生视频最多 2 张图（首帧 + 尾帧），收到 3 张"}
```

工作流侧：首帧接 `MiniMaxH3ImageToVideo.first_frame`、尾帧接 `last_frame`；缺哪一帧，那个输入与对应的 `LoadImage` 节点都会被 `prompt_builder` 摘掉，所以「只给首帧」「两帧都不给」都是干净的图。

### `GET /generations/{id}/reference`

回显该次生成用的参考图（`FileResponse`，按扩展名给 `image/png` / `image/jpeg` / `image/webp`）。查询参数 `index` 从 `0` 开始，缺省 `0`。没有参考图、文件缺失、或 `index` 越界时 `404`（例如「generation 25 只有 2 张参考图，没有第 3 张」）。

## 任务

### `GET /tasks/{id}`

```json
{ "id": 1, "seed": 545756017, "status": "pending", "progress": 0, "comfy_prompt_id": null, "error_message": null, "started_at": null, "completed_at": null }
```

`progress` 为 0–100 的整数：`1` 表示已提交 ComfyUI，之后由 `progress` 事件推进到 99，完成时置 100。

### `POST /tasks/{id}/cancel`

取消单个任务，返回 `TaskRead`。

- `pending` / `queued`：直接标为 `cancelled`，Worker 不会再去执行它。
- `running`：先尽力 `POST /interrupt {prompt_id}` 打断 ComfyUI，再标 `cancelled`；Worker 拿到结果后发现任务已取消会丢弃产物。
- 已结束（`completed` / `failed` / `cancelled`）的任务返回 `409 {"detail": "task 7 已经结束（completed），无法取消"}`。

取消后会把整条生成记录的状态重新聚合：还有别的任务在跑就仍是 `running`，全部结束且**有任意一张成功就记为 `completed`**（部分取消不该让已有的图变成失败），全都被取消才是 `cancelled`，否则 `failed`。

### `POST /tasks/{id}/retry`

重试 = **在同一个 `generation` 下追加一个新任务**（新 seed、`pending`），返回 `201` + 新 `TaskRead`，生成记录回到 `pending`。

- 只对 `failed` / `cancelled` 的任务开放；`queued` / `running` 时返回 `409 {"detail": "任务正在执行，先取消再重试"}`。
- 新 seed 不会与该生成记录下已有任务的 seed 重复。
- 接口是同步的；图片仍然由 Worker 异步产出。

### `DELETE /tasks/{id}`

删掉一个任务，连同它名下的产物。返回 `{"task_id": 7, "generation_deleted": false}`。

- 为什么需要它：图删光之后，任务仍然占着作品流的一格（显示成「无产物」），
  用户在这里决定要不要把这一格清掉。
- **删除是软删除**：产物打上 `deleted_at` 进回收站（文件留在磁盘，30 天内可恢复），
  详见 [回收站](#回收站)。
- `queued` / `running` 的任务返回 `409 {"detail": "task 7 还在执行，先取消再删除"}`。
- 批次里**一个任务都不剩**时，批次本身也一起进回收站，`generation_deleted` 为 `true`，
  避免留下点进去是空的壳；批次还有别的任务就只删这一个。

## 图片

### `GET /images?limit=20&offset=0&generation_id=3&favorite=true`

按 `id` 倒序返回产物。`generation_id` 可选（取某次生成的全部图片），`favorite=true` 只看收藏。

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

每个 `ImageRead` 都带 `label`（`「批次名 · 第 N 个」`，见 `PATCH /generations/{id}`）、`media_type`（`image` / `video` / `asset`）与视频专用的 `duration_seconds` / `fps` / `frame_count`；素材另外带 `file_path`（前端靠后缀区分 PNG 与 ZIP / JSON）；`GenerationRead` 也带 `duration_seconds` / `fps`，所以前端不需要再单独查任务表。

### `GET /images/{id}`

返回单个 `ImageRead`；不存在 `404`。

### `GET /images/{id}/file`

返回原始文件，`Content-Type` 按 `media_type` 决定：图片是 `image/png`，视频是 `video/mp4`，素材按后缀给 `image/png` / `image/jpeg` / `image/webp` / `application/zip` / `application/json`；视频与素材的缩略图由服务端生成。可直接作为 `<img src>` / `<video src>`：

```html
<img src="http://127.0.0.1:8000/api/v1/images/6/file" />
<video src="http://127.0.0.1:8000/api/v1/images/1/file" controls></video>
```

文件在磁盘上缺失时返回 `404` 并说明缺失的 `file_path`。

### `GET /images/{id}/thumbnail`

480px 长边的 JPEG 缩略图（`image/jpeg`，`Cache-Control: public, max-age=31536000, immutable`）。第一次请求时用 Pillow 生成并写回 `thumbnail_path`，之后直接读磁盘缓存。列表页请用这个，别用原图。

### `POST /images/{id}/favorite`

收藏 / 取消收藏，body `{"favorite": true}`，返回更新后的 `ImageRead`。不存在 `404`。

### `PATCH /generations/{id}`

给这一批起个名字，body `{"name": "走路 3 秒"}`（最多 60 字，前后空白会被去掉）。传空字符串就是清掉名字、回到默认的「批次 #id」。返回更新后的 `GenerationRead`。

名字只存在 `generations.name` 一列，产物本身不改名——文件名、`file_path` 都不动，**展示用的名字由读取接口现算**：

- `GenerationRead.name`：原始值（没起名就是 `null`），前端没名字时显示 `批次 #id`。
- `ImageRead.label` / `ImageBrief.label`：`「名字 · 第 N 个」`，`N` 是这张图在**未删除**的产物里按 `id` 排第几；没起名时是 `批次 #id · 第 N 个`。删掉第 1 张之后，第 2 张会变成「第 1 个」。

```json
{ "name": "走路 3 秒" }
```

为什么算在读取侧：产物名要跟着批次名与删除情况变，存成列的话每次改名、每次删图都要批量回写；现算只有一次 `IN` 查询（`label_images()`），而且回收站里的图不会占号。

### `DELETE /generations/{id}`

删掉一整个批次：名下的任务与产物**一起进回收站**（软删除，30 天内可恢复）。返回
`{"generation_id": 12, "images": 4, "tasks": 4}`。

- 一次生成 4 张图时，一次请求就能把这一批连同它的 4 条任务移出作品流，
  不用逐张删（对应前端的「删除这个批次」）。
- 批次里只要有 `queued` / `running` 的任务就返回
  `409 {"detail": "批次里还有 2 个任务在执行，先取消再删除"}`，
  避免把正在写盘的结果删掉。
- 不存在返回 `404 {"detail": "generation 12 不存在"}`。
- 真正删文件只在「彻底删除 / 清空回收站 / 30 天过期」时发生，见 [回收站](#回收站)。

### `DELETE /images/{id}`

把这张图移进回收站（打 `deleted_at`，文件与缩略图留在磁盘），返回 `204`。不存在返回 `404`。
已删除的图片若是某次生成的唯一产物，生成记录本身保留。

### `POST /images/batch-delete`

批量移进回收站，body `{"ids": [12, 14, 15]}`（最多 500 个）。

```json
{ "deleted": [12, 14], "missing": [15] }
```

本来就不存在的 id 进 `missing` 而不是整批失败——多标签页同时删是常态。已经删过的 id 也算 `missing`，不会刷新它的删除时间。

### `POST /images/clear`

清空工作区：把**全部**图片与**全部**生成记录（含任务）移进回收站。30 天内可以恢复，文件不会被当场删掉。

```json
{ "images": 70, "generations": 40 }
```

- 响应 `409` 的条件：还有任务处于 `queued / running`——此时清空会打断正在写的文件，必须先等完成或取消：

  ```json
  { "detail": "还有 1 个任务在排队或生成，清空会丢掉它们，请先等完成或取消" }
  ```
- 不动的东西：模型注册表、工作流 JSON 与绑定配置、数据库文件本身、`storage/uploads/` 里的参考图（恢复批次后详情页还要显示它们）。

### `POST /assets`

把序列帧工坊导出的图集（`.zip` / `.json`）或者单张图片存进「素材」类别。素材与图片、视频同级，走同一套收藏 / 下载 / 删除 / 画廊接口。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `file` | file | 必填。PNG / JPEG / WebP / JSON / ZIP，≤ 64 MB |
| `name` | string | 可选，默认用上传文件名 |
| `prompt` | string | 可选，作为素材的说明（默认 `序列帧工坊导出`） |
| `source_image_id` | int | 可选，记录来源（写进 `images.original_image_id`） |

ZIP 会用里面**第一张 PNG** 当封面帧生成 `thumbnails/`，所以素材卡有真实预览；JSON 没有预览，前端显示文件牌。

```json
{ "generation_id": 1, "image_id": 1, "name": "sprite_atlas.zip", "file_size": 2135700,
  "width": 1024, "height": 1024, "media_type": "asset" }
```

错误：后缀不在白名单 → 422 `素材只支持 PNG / JPEG / WebP / JSON / ZIP，收到 .txt`；空文件 → 422 `素材内容为空`；过大 → 422 `素材不能超过 64 MB，收到 65.0 MB`。

素材落盘在 `<项目>/storage/assets/<generation_id>/<task_id>_0.<ext>`，和 `images/`、`videos/`、`frames/` 同级。

### `PUT /assets/{image_id}`

**覆盖**已有素材（工坊里从资产打开、改完再保存时走这条）。

- 请求体与 `POST /assets` 相同，但不需要 `source_image_id`（来源本来就是它自己）。
- 语义是替换而不是新建：**批次 id 不变、产物 id 不变、资产条数不变**；旧文件与旧缩略图当场删除，新内容写回同一个路径。
- 产物 `created_at` 会刷新，前端用 `?v=<created_at>` 的缓存键因此拿到新文件，不会撞上旧 ZIP。
- 返回体多一个 `"replaced": true`；找不到、或 id 不是素材 → 404 `没有 id 为 3 的素材`。

```json
{ "generation_id": 1, "image_id": 1, "name": "sprite_atlas.zip", "file_size": 988171,
  "width": 1024, "height": 1024, "media_type": "asset", "replaced": true }
```

**什么时候用哪条**：资产里点「在序列帧工坊打开」（`?asset=<id>`）或从工坊里「从资产选」图集 → 这条会话绑定该素材，导出弹层的按钮变成「保存并覆盖 #id」，走 `PUT`；本机导入、拖入文件、或从视频开始的新作品 → 未绑定，走 `POST` 新建一条（首次保存成功后也会自动绑定，同一次会话里再保存就是覆盖）。

### `POST /frames`

抽帧台把导出的序列帧打包上传，登记成一条**帧集**资产（`media_type = "frameset"`，`generation_type = "local_frameset"`）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `bundle` | file | 必填。ZIP 包（`frames/0001.png…` + `frames.json`），≤ 256 MB |
| `cover` | file | 必填。封面帧 PNG / JPEG，写成这张产物的缩略图 |
| `name` | string | 必填。帧集名字，≤ 60 字；产物名是「名字 · 第 N 个」 |
| `count` | int | 必填。帧数 1–2000 |
| `width` / `height` | int | 必填。导出画布的尺寸，**恒等于源帧尺寸**（抽帧台不再缩放或裁到主体） |
| `fps` | float | 可选。抽帧时用的帧率 |
| `source_video_id` | int | 可选。来源视频的产物 id（写进 `original_image_id`） |

```json
{ "generation_id": 73, "image_id": 105, "name": "走路测试", "frame_count": 22,
  "fps": 12.0, "width": 757, "height": 736 }
```

- 只把来源视频记在 `images.original_image_id`，**不占用 `generations.reference_images`**：帧集不是「参考了这张图」，早先这么写会让详情弹窗把 mp4 当参考图画成破图（读接口对 `local_frameset` 也会直接返回空数组兜住老数据）。
- 整包入库，**不是**每帧一条 `images` 记录：73 帧 × 几条视频就足以把画廊与数据库冲垮。帧集在画廊里是一张卡，右上角标「N 帧」。
- `frames.json` 记 `{ name, fps, width, height, stepX, stepY, fill, keying, tolerance, source, frames: [{ index, time, offsetX, offsetY, manual }] }`：`offset` 是这一帧在导出时被平移的像素，`manual` 标出哪些帧是手调过的（其余是按「选中顺序 × 步进」算的）。
- 落盘在 `<项目>/storage/frames/<generation_id>/<task_id>_0.zip`；`GET /images/{id}/thumbnail` 给封面、`GET /images/{id}/file` 直接吐 ZIP（`content-type: application/zip`）。
- 帧集算「资产」：`GET /generations?media=asset` 与回收站的 `media=asset` 都能查到它；但图片选择器（`media=image`）与帧集互相排除，不会把 ZIP 当图选。
### PUT /frames/{image_id}

用抽帧台重新导出的包**覆盖**同一条帧集（`multipart/form-data`，字段与 `POST /frames` 相同，但没有 `source_video_id`）。

- 覆盖 = 删旧 ZIP 与缩略图，在同一批次 / 任务下写一份新的；**批次与产物 id 都不变**，资产库里不会多一条，详情弹窗也不会跳批次；
- 缓存靠 `created_at` 变化后的 `?v=` 失效；返回体与 `POST /frames` 相同（`image_id` 还是原来那个）；
- 不是帧集 / 不存在 → 404 `没有 id 为 3 的帧集`；
- 前端入口：帧集详情弹窗的「在抽帧台打开」→ `/tools/frames?frameset=<image_id>`，看完偏移点「覆盖保存」。

- 错误：不是 ZIP → 400 `不是 ZIP 文件`；空包 → 400 `帧集压缩包是空的`；超 256 MB → 413 `帧集压缩包超过 256 MB`；帧数越界 → 400 `帧数要在 1–2000 之间`；名字为空 → 400 `帧集名字不能为空`。

## 回收站

所有「删除」都是软删除：给 `images` / `generation_tasks` / `generations` 打一个 `deleted_at`，文件留在磁盘上。这样删错的图、删空的批次、清空的工作区都能在 30 天内捞回来。**只有这三件事会真正删文件**：在回收站里点「彻底删除」、「清空回收站」、或者条目过期满 30 天。

软删除的影响面：

- 列表接口（`GET /generations`、`GET /images`、收藏）都看不到 `deleted_at` 非空的记录；`GET /images/{id}` 对已删的图也是 404。
- `GET /images/{id}/file` 与 `/thumbnail` **不过滤**——回收站里的卡片要能预览，恢复后原来的 URL 也还成立。
- 恢复一张图时，它所属的任务与批次会一起解冻（`deleted_at` 清空），否则图回来了却卡在被删批次里看不见。
- 过期清理在服务启动时（每个项目跑一次）和每次 `GET /recycle-bin` 时都会执行，不需要背后的定时任务。

### `GET /recycle-bin?limit=60&offset=0&media=image`

按删除时间倒序返回回收站内容。`media` 可选 `image` / `video` / `asset`。

```json
{
  "items": [
    {
      "id": 12, "generation_id": 5, "task_id": 9,
      "file_path": "images/5/9_0.png", "thumbnail_path": "thumbnails/12.jpg",
      "media_type": "image", "width": 1024, "height": 1024, "file_size": 1767626,
      "duration_seconds": null, "fps": null, "frame_count": null,
      "created_at": "2026-11-17T08:20:09Z", "deleted_at": "2026-11-17T09:41:00Z",
      "expires_at": "2026-12-17T09:41:00Z", "days_left": 30,
      "prompt": "一个穿风衣的侦探", "model_name": "qwen_image_21_turbo", "generation_type": "text_to_image"
    }
  ],
  "total": 1, "limit": 60, "offset": 0, "retention_days": 30
}
```

`days_left` 是 `expires_at` 剩下的整天数（向上取整，过期条目返回 0 且不会再出现在列表里）；`prompt` / `model_name` / `generation_type` 从所属批次带出来，前端不用再查一次。

### `POST /recycle-bin/restore`

body `{"ids": [12, 13]}`（最多 500 个）。恢复的图重新出现在作品流与资产库里，所属任务和批次一并解冻。

```json
{ "restored": [12], "missing": [13] }
```

不在回收站里的 id（从没删过、已经被彻底删除、或根本不存在）进 `missing`，不报错。

### `DELETE /recycle-bin/{id}`

从磁盘上**彻底**删掉这一件产物（原图 + 缩略图 + 数据库行）。返回 `200` + `{"deleted": 1}`（不是 204，前端要读计数）。

- 条目不在回收站里 → `404 {"detail": "回收站里没有 id 为 3 的产物"}`。
- 删完之后如果它所属的批次已经没有任何产物，批次与任务会一并清掉，不留空壳。

### `POST /recycle-bin/clear`

清空回收站，立即删文件。不带 body，**不区分当前筛选**，一次清掉全部类别。

```json
{ "deleted": 7 }
```

## 提示词模板

视频创作框下面那排「动作模板」按钮的数据源。一条 = 一个动作，`prompt` 里已经写死了 2D 抽帧要用的约束（严格侧视、朝右、定点不位移、镜头不动、背景干净），所以在视频页点一下就能直接用。

首次启动（或新项目第一次跑）会补齐 9 条默认模板：待机 / 走路 / 跑步 / 攻击 / 跳跃 / 下蹲 / 受伤 / 死亡 / 翻滚。
老项目启动时会把「逐字等于旧默认」的行升级成新文案；已下线的「下落」如果没被改过会被删掉并在原位补上「下蹲」（改过的保留，`upgrade_defaults` 返回改动行数）。

字段：`id`、`label`（最多 40 字）、`prompt`（最多 2000 字）、`sort_order`（列表顺序，新模板追加在末尾）。

### `GET /prompt-templates`

```json
{
  "items": [
    { "id": 1, "label": "待机", "prompt": "A character standing idle, …, strict side view with the character facing right, …", "sort_order": 0 },
    { "id": 2, "label": "走路", "prompt": "A character walking in place, …, strict side view with the character facing right, …", "sort_order": 1 }
  ]
}
```

### `POST /prompt-templates`

body `{"label": "施法", "prompt": "A character casting a spell, …"}` → `201` + 新模板。`sort_order` 自动取「现有条数」，所以新加的按钮排在最后。

空名字 / 空提示词 / 超长 → `400 {"detail": "模板名字不能为空"}`、`"模板提示词不能为空"`、`"模板名字最多 40 个字"`、`"模板提示词最多 2000 个字"`。

### `PATCH /prompt-templates/{id}`

只传要改的字段（`label` 和 / 或 `prompt`）。返回改完的模板；id 不存在 → `404 {"detail": "模板 7 不存在"}`。

### `DELETE /prompt-templates/{id}`

删一条，返回 `204`。视频创作框里那个按钮跟着消失。

### `POST /prompt-templates/reset`

清掉现有模板，重新写回默认 9 条（id 会变）。返回和 `GET` 一样的 `{"items": [...]}`，方便前端直接替换。

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
前端收到事件后只做「有变化」的信号，真实数据仍走 REST（`invalidateQueries`），这样断线也不会停在错误状态；断开 2 秒后自动重连。

## 视频

视频不新开一套资源接口：产物仍然是 `images` 表里的一行，只是 `media_type = video`、`file_path` 指向 `.mp4`、并带 `duration_seconds` / `fps` / `frame_count`。因此 `GET /images`、收藏、批量删除、清空工作区、`/images/{id}/file` 全部照旧可用。

| 端点 | 说明 |
| --- | --- |
| `POST /generations` | `generation_type=text_to_video`，JSON 提交 |
| `POST /generations/image-to-video` | 首帧 / 尾帧可选，`multipart/form-data` |
| `GET /generations/{id}` | `duration_seconds` / `fps` 直接可读 |
| `GET /images?media_type=video` | 未实现（前端的视频页用 `model=minimax_h3` 过滤） |

已知边界：视频一次最多 4 条（`count` 1–4，默认 1，串行逐条出）、参考视频（r2v）与视频编辑尚未开放。

## 本地编辑器

图片编辑器完全跑在后端进程的 CPU 上（numpy + scipy + Pillow），**不经过 ComfyUI、不占显存、不写入 `images` 表**，只做「进来一张图、出去一张图」的像素运算。上传上限 40 MB，支持 PNG / JPEG / WebP。

| 端点 | 说明 |
| --- | --- |
| `POST /editor/analyze` | 读图片尺寸、边框主色、是否已有透明通道、背景占比、建议容差 |
| `POST /editor/remove-background` | 抠背景，返回 PNG（带透明通道） |
| `POST /editor/trim` | 按 alpha>0 的包围盒裁掉透明边，返回 PNG |
| `POST /editor/decode` | 只校验能不能读，返回尺寸（前端放图失败时的兜底） |

### POST /editor/analyze

`multipart/form-data`，字段 `file`。响应：

```json
{
  "width": 1024,
  "height": 1024,
  "background": [34, 56, 36],
  "has_alpha": true,
  "background_share": 0.8996,
  "suggested_tolerance": 4,
  "enclosed_background_share": 0.0032
}
```

`background` 取的是图片边框像素的中位数（比众数稳：渐变背景也不会只挑到一个色）。`suggested_tolerance` 是从 `[4, 8, 16, 24, 32, 48]` 里挑最小的、能让至少 60% 像素落入的值——直接用它通常就能抠干净纯色底。`enclosed_background_share` 是「被主体包住的同色块」占画布的比例：大于 0 就说明 `edge` 模式会漏掉这些色块（典型如角色腋下、手臂与身体之间的缝隙），前端据此提示切到 `color`。

### POST /editor/remove-background

`multipart/form-data`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `file` | 必填 | 源图 |
| `mode` | `edge` | `edge` 只删与画布边缘连通的同色区（保留主体内部的白衣服、白眼睛）；`color` 删所有同色像素（连主体内部的封闭背景块一起清） |
| `tolerance` | `22` | 0–120，颜色距离阈值 |
| `channel` | `max` | 颜色距离算法：`max`（三通道取最大差）/ `mean` / `luma` |
| `feather` | `1` | 0–8，对 alpha 做高斯模糊的半径，边缘更软 |
| `denoise` | `0` | 0–10，去杂点：填掉面积 < `40 × denoise` 平方像素的小孔、丢掉同样大小的碎块；大块封闭背景不会被误填 |
| `color` | 自动 | `#rrggbb`，不传时用边框主色 |

返回 `image/png` 字节流，附三个响应头：

- `X-Background-Color: #223824` —— 实际用的底色
- `X-Removed-Ratio: 0.8995` —— 变成透明的像素占比
- `X-Image-Width` / `X-Image-Height`

超过 40 MB 或不是图片 → 422；`mode` 非法 → 422 `mode 只能是 edge 或 color`。

### POST /editor/trim

`multipart/form-data`：`file` + `padding`（0–256，向外留白的像素）。返回裁剪后的 PNG，头里带 `X-Content-Box: left,top,right,bottom`（相对原图的包围盒）。
### POST /editor/save

`multipart/form-data`：`image`（导出的 PNG）+ 可选 `source_image_id`、`prompt`。

把编辑器成品存进资产库。后端不起任务、不碰 ComfyUI，直接建一条 `local_edit` 记录：
一个已完成的 `generations` 行、一个已完成的 `generation_tasks` 行（`seed` 为空，迁移 `0006_local_edit` 起允许）和一张 `images` 行。

```json
{"generation_id": 15, "image_id": 31, "width": 512, "height": 512, "file_size": 134402}
```

- 带 `source_image_id` 时，`prompt` 默认记成 `本地编辑 · 来自图 #29`，并把原图写进 `original_image_id` 与 `reference_image_path`
- 不带时 `prompt` 默认 `本地编辑`
- 产物与生成的图完全同构：出现在资产库、作品流、收藏、下载与删除里；`GET /generations?media=image` 能查到
- 40 MB 上限、非图片 422（与其它 editor 端点一致）