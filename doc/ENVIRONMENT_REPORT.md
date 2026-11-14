# MiraForge 环境检查报告（P0 勘察，P1 前）

- 检查时间：2026-11-14 15:2x
- 依据：`doc/PROJECT.md`（1068 行）全文 + 本机实测（Python / Node / ComfyUI HTTP API / object_info / 模型目录 / 官方模板 / 用户已验证 API 图）
- 原则：本报告只记录**实测事实**。凡未经实测的推断，均明确标注「未验证」。未安装、未删除任何模型，未修改 ComfyUI 配置，项目内未写入任何业务代码。

---

## 0. 结论摘要

**可以进入 P1。** 平台依赖的三大前提已就绪：ComfyUI 0.44.0 在线、Qwen Image 2.1 全链路权重齐备、存在一份**真实执行过**的 API 格式工作流可作为编辑链路基线。

主要缺口只有三个，且都是纯软件层、可自动化解决：`pnpm` 未安装、后端业务依赖（SQLAlchemy/Alembic 等）未安装、MiraForge 目录内目前只有一个 `doc/PROJECT.md`。

需要你拍板的是 5 个产品/参数级决策（第 6 节 Q1–Q5），以及一个工程操作授权（Q6：P2 阶段是否允许向 ComfyUI 提交一次真实出图任务，会占用 GPU）。

风险最高的一项不是环境，而是：**文生图的 API 格式图没有历史执行记录可作证据**。ComfyUI 的 `/history` 当前为空（服务于 13:39 重启，`user/comfyui.log` 为 0 字节），所以文生图 API 图只能由官方模板展平推导，必须在 P2 用一次真实提交来验证。编辑链路则没有这个风险——已有用户自己验证过并留存的 `*_api.json`。

---

## 1. 开发环境（步骤一实测）

### 1.1 操作系统与硬件

| 项目 | 实测结果 | 判定 |
| --- | --- | --- |
| OS | Windows（PowerShell 7.6.9）；`Get-CimInstance` 查 OS 名称被拒绝访问，未取到版本号 | 可用，版本号待补 |
| GPU | NVIDIA GeForce RTX 5070 Ti，`vram_total` 17,066,033,152 B ≈ **15.9 GiB**（nvidia-smi 报 16303 MiB），驱动 616.64 | 满足 int8 量化单图 |
| 内存 | 68,459,933,696 B（64 GB），空闲 39,096,070,144 | 充裕 |
| 磁盘 | C: 剩余 120.7 GB，D: 剩余 577.5 GB | 充裕（项目在 D:） |

### 1.2 Python

| 项目 | 实测结果 | 判定 |
| --- | --- | --- |
| `python` | `C:\Program Files\Python312\python.exe`，**Python 3.12.10** | ✅ 符合规格「3.11 或兼容版本」 |
| `py` | 3.14.3（另一套，勿用） | 仅记录 |
| `python3` | 指向 WindowsApps 存根（不可用） | 不要用 `python3` |
| `pip` | 25.0.1 | 可用 |
| `uv` | 0.10.7（`C:\Program Files\Python312\Scripts\uv.exe`） | 可选加速器 |
| venv | 可用 | P1 将建 `backend\.venv` |

系统 Python 已具备（全局）：`fastapi`、`uvicorn`、`pydantic`、`httpx`、`websockets`、`pytest` = 已安装；`sqlalchemy`、`alembic` = **未安装**。

> 决策：不污染系统 Python。P1 在 `backend\.venv` 内按 `requirements.txt` 重建完整依赖，锁定版本。

### 1.3 Node.js

| 项目 | 实测结果 | 判定 |
| --- | --- | --- |
| node | v24.14.0（`C:\Program Files\nodejs\node.exe`） | ✅ 满足 Next.js 15+ |
| npm | 11.9.0 | ✅ 可用 |
| pnpm | **未安装** | ⚠️ 见 Q6；npm 可完全替代 |
| git | 2.53.0 | ✅ 可用于 `git init` |

全局 npm 包仅 `@opencode/cli@2.2.5`、`bun@1.3.10`，与项目无关。

### 1.4 网络

| 目标 | 实测 | 备注 |
| --- | --- | --- |
| npm registry | `npm ping` → PONG，1842 ms | 可达 |
| PyPI | `GET https://pypi.org/pypi/fastapi/json` → 200，5.2 s | 可达但**偏慢** |
| registry.npmmirror.com:80 | TCP 可达 | 备用镜像 |
| `pip config` | 空（无镜像配置）；npm registry = `https://registry.npmjs.org/` | 保持默认 |

⚠️ 排障备注：PowerShell 的 `Invoke-WebRequest` 访问 https 会报 `The SSL connection could not be established`。这是**本机 PowerShell 的 TLS 栈问题，不是断网**——已用 `npm ping` 和 Python `urllib` 双重复验。后续脚本一律用 Python 或 node 发请求，不用 `Invoke-WebRequest`。

### 1.5 端口占用

```
8188  127.0.0.1:8188  LISTENING  PID 42348   ← ComfyUI
3000  FREE                                  ← 前端
8000  FREE                                  ← 后端
```

> 注意：本机 `Get-NetTCPConnection` 在本会话中不可靠（曾对已监听端口返回空）。端口判定以 `netstat -ano` 与真实 HTTP 探测为准。

---

## 2. 项目目录现状（步骤二）

```
D:\AI\MiraForge\
└── doc\PROJECT.md     21,359 B   2026-11-14 15:17
```

**结论：空项目。** 无源码、无 `package.json`、无工作流 JSON、无配置文件、无 `.git`、无 `storage/`、无 `data/app.db`。

因此 P1 不存在任何覆盖已有文件的风险。同时说明：**目录结构需要从零创建**，严格按 PROJECT.md 的约定布局，不做自由发挥。

---

## 3. ComfyUI 运行状态与资产（步骤一/三）

### 3.1 服务

| 项目 | 实测 |
| --- | --- |
| 地址 | `http://127.0.0.1:8188`，`GET /system_stats` → 200 |
| 版本 | ComfyUI **0.44.0**，frontend 1.57.6，templates 0.11.101，comfy-kitchen 0.2.40，comfy-aimdo 0.6.0 |
| 运行时 | 内嵌 Python 3.13.14，PyTorch 2.14.1+cu130，`deploy_environment=local-portable` |
| 启动参数 | `["ComfyUI\main.py", "--windows-standalone-build"]` —— **未带 `--listen`**，只监听 127.0.0.1 |
| 队列 | running=0，pending=0；`/history` 为空 |

**影响**：后端必须与 ComfyUI 同机运行、走 127.0.0.1。这与 PROJECT.md「本地平台」定位一致，不需要改动 ComfyUI 启动参数（也遵守「不修改现有 ComfyUI 配置」）。

已确认的 HTTP 契约（读 `ComfyUI\server.py` 源码 + 实测）：

- `POST /prompt`（server.py:1164-1246）：体 `{"prompt": {节点图}, "client_id": "...", "prompt_id"?: uuid}`。`prompt_id` 可自带，缺省由服务端 uuid4 生成；非法则 400 `invalid_prompt_id`。成功 → `{"prompt_id","number","node_errors"}`；校验失败 → 400 `{"error","node_errors"}`。
- `GET /history`（1137）/ `GET /queue`（1156）/ `POST /interrupt`（1262，支持定向 `prompt_id`）/ `POST /free`（unload_models / free_memory）。
- `POST /upload/image`（536）：multipart，返回含 `asset`（preview_url/preview_id）。
- `GET /view`（599）：`filename` + `type`/`subfolder`，含 `..`、绝对路径、越界 subfolder 防护（400/403）。
- `WS /ws`（336）：实时进度事件（`progress`、`executing`、`executed` 等）。

### 3.2 模型资产（只读盘点，未改动）

| 用途 | 文件 | 大小 |
| --- | --- | --- |
| 编辑主模型 | `diffusion_models\qwen_image_2.1_int8_convrot.safetensors` | 6920.6 MB |
| 文生图 turbo | `diffusion_models\qwen_image_2.1_turbo_int8_convrot.safetensors` | 6920.6 MB |
| 视觉/文本编码器（主链路） | `text_encoders\qwen3vl_8b_int8_convrot.safetensors` | 8917.6 MB |
| PE 增强（T2I） | `text_encoders\qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors` | 9032.3 MB |
| PE 增强（编辑） | `text_encoders\qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors` | 9032.3 MB |
| VAE（2.1） | `vae\qwen_image_2.1_vae_bf16.safetensors` | 644.2 MB |
| VAE（旧版） | `vae\qwen_image_vae.safetensors` | 242.0 MB |

**Qwen Image 2.1 三套场景（文生图 / 图片编辑 / turbo 版）权重齐备，无需下载任何模型。**

`custom_nodes` 仅 `ComfyUI-Manager` 与 `ComfyUI-segment-anything-2`。**Qwen 2.1 全链路只依赖 ComfyUI 内置节点**，自定义节点不影响本项目，也不需要在 ComfyUI 侧装任何东西。

### 3.3 节点结构（依据 `GET /object_info` 实时返回，1042 个节点类，非推测）

- **`TextEncodeQwenImage21`**（`model/conditioning/qwen image`）
  - required：`clip:CLIP`、`prompt:STRING(multiline)`、`negative_prompt:STRING`、`resolution:INT`、`images:COMFY_AUTOGROW_V3`
  - optional：`vae:VAE`
  - output：`['CONDITIONING','CONDITIONING','LATENT']`，名称 `['positive','negative','latent']`
  - `resolution` 语义：`0` = 按每张参考图原始尺寸；否则约 `resolution×resolution` 并按 32 倍数取整以保持比例。
- **`QwenImage21Cache`**：`model:MODEL`、`device:COMBO(auto/cpu/off…)`、`dtype:COMBO(default 无损/int8/int4)` → `MODEL`。前缀 KV 缓存 + 显存换页。
- **`KSampler`**：`model, seed, steps, cfg, sampler_name(45 项), scheduler(simple/sgm_uniform/karras/exponential/ddim_uniform/beta/normal/linear_quadratic/kl_optimal), positive, negative, latent_image, denoise`。
- **`EmptyLatentImage`/`EmptySD3LatentImage`**：`width, height, batch_size`；**`VAEDecode`**：`samples, vae`；**`SaveImage`**：`images, filename_prefix`。
- **高级采样族**：`ManualSigmas(sigmas:STRING)`、`CFGGuider(model,positive,negative,cfg)`、`KSamplerSelect(sampler_name)`、`RandomNoise(noise_seed)`、`SamplerCustomAdvanced(noise,guider,sampler,sigmas,latent_image)`。
- **PE 族**：`TextGenerate(clip,prompt,max_length,sampling_mode,…)`、`ComfySwitchNode(switch, on_false, on_true)`、`PrimitiveStringMultiline(value)`、`BatchImagesNode(images:AUTOGROW)`、`PreviewAny(source)`。
- **图像 I/O**：`LoadImage(image)` → `[IMAGE, MASK]`、`ImageScaleToTotalPixels`、`PreviewImage`。

---

## 4. 工作流结构分析（步骤三）

官方模板位于 `ComfyUI\python_embeded\Lib\site-packages\comfyui_workflow_templates_json\templates\`，共 4 套 Qwen 2.1 模板。**它们都是 UI 格式且用 subgraph 封装，不能直接 POST 给 `/prompt`，必须展平为 API 格式。**

### 4.1 四套模板的节点图（实测读取）

**A. `image_qwen_image_2_1_t2i.json`（文生图，13 节点子图）**

```
451 UNETLoader(qwen_image_2.1_int8_convrot, weight_dtype=default)
      → 480 QwenImage21Cache(device=auto, dtype=default) → 458 KSampler.model
453 CLIPLoader(qwen3vl_8b_int8_convrot, type=qwen_image, device=default) → 452 TextEncodeQwenImage21
454 VAELoader(qwen_image_2.1_vae_bf16) → 457 VAEDecode.vae
452 TextEncodeQwenImage21（无 images、无 vae）→ positive[0] / negative[1]
456 EmptyLatentImage(width,height,1) → 458 KSampler.latent_image
458 KSampler(steps=25, cfg=1, euler/simple, denoise=1) → 457 VAEDecode → SaveImageAdvanced
```

可选 PE 支路：`473 CLIPLoader(qwen3.5_9b_..._pe_t2i, type=stable_diffusion)` + `471 TextGenerate(max_length=4096, thinking, sampling_mode.seed)` + `475 PrimitiveStringMultiline(system prompt)` → `474 ComfySwitchNode(switch 默认 false)` → `452.prompt`（同时接 `472 PreviewAny` 便于观察改写结果）。**即默认走原始提示词，PE 是可选开关。**

**B. `image_qwen_image_2_1_turbo_t2i.json`**：同 A，但 451 换 `qwen_image_2.1_turbo_int8_convrot`，采样替换为 `486 SamplerCustomAdvanced(noise=488 RandomNoise, guider=489 CFGGuider(cfg=1), sampler=487 KSamplerSelect(euler), sigmas=484 ManualSigmas, latent=空 latent)`。`ManualSigmas` 固定 8 步 `1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0`。

> ⚠️ **turbo 不可调 steps**：步数由固定 sigma 表决定，子图也没有 cfg/steps 输入。前端若同时暴露 steps 会产生「调了没用」的假参数。

**C. `image_qwen_image_2_1_image_edit.json`（图片编辑，15 节点子图）**

```
1 LoadImage → 474 TextEncodeQwenImage21.images.image_1 … image_10（最多 10 张参考图）
474 接 clip(453)、vae(454)、resolution
474.latent[2] → 468 ComfySwitchNode(switch 默认 false).on_false   ← 默认潜空间来源
456 EmptyLatentImage → 468.on_true                                ← 仅 switch=true 时 width/height 生效
468 → 458 KSampler.latent_image → 457 VAEDecode → SaveImageAdvanced
469 QwenImage21Cache → 458.model
prompt 经 484 ComfySwitchNode；PE 支路 = 477 CLIPLoader(_pe_i2i) + 500 TextGenerate(带 image) + 479 system prompt + 485 BatchImagesNode
```

> ⚠️ **编辑链路默认忽略 width/height**：潜空间来自编码器第 3 输出（跟随参考图），`EmptyLatentImage` 只在 switch=true 时才接上。产品语义需决策（见 Q4）。

**D. `image_qwen_image_2_1_turbo_image_edit.json`**：编辑结构同 C，采样换 `SamplerCustomAdvanced`（505/507/503/504/502），模型换 turbo。

### 4.2 用户已验证的真实 API 图（关键复用资产）

`D:\AI\Workflows\QwenImage21LayerExtraction\qwen21_layer_extract_api.json`（8,080 B，2026-11-11），meta 明确写着「实际执行过的 API 图，官方模板 `image_qwen_image_2_1_image_edit.json`」。它证明了两件对实现至关重要的事实：

1. **API 格式下 AUTOGROW 输入的键名形如 `"images.image_1"`**（不是 `images` 数组）。
2. **编辑链路的 latent 直接取 `TextEncodeQwenImage21` 的第 3 个输出**，不需要 EmptyLatentImage。

其节点图（三套同构 fg/mg/bg）：

```
1 LoadImage(image)
6 TextEncodeQwenImage21(clip=[3,0], prompt, negative_prompt="", vae=[4,0],
                        resolution=0, "images.image_1"=[1,0])
2 UNETLoader(qwen_image_2.1_int8_convrot, default) → 5 QwenImage21Cache(auto, default) → 7 KSampler.model
7 KSampler(seed=20261111, steps=25, cfg=1.0, euler/simple,
           positive=[6,0], negative=[6,1], latent_image=[6,2], denoise=1.0)
8 VAEDecode(samples=[7,0], vae=[4,0]) → 9 SaveImage(filename_prefix)
```

另外 `D:\AI\Workflows` 下已有成熟的「UI 图 + `*_api.json` 配套导出」约定（如 `CharacterDesign\04_Character_Design_Production_api.json`、`Animation\05B_Breathing_Local_Repaint_api.json`、`GameAssets\02_FLUX_Klein_Base_Inpainting_api.json`），P2/P4 可直接沿用这套约定。

`ComfyUI\user\default\workflows` 下 10 个 UI 工作流与 `blueprints` 里的 Qwen-Image 2512 / 2509 / 2511 蓝图**均不是 2.1 版本**，不能替代上述模板。

### 4.3 文件落位方案（P2 使用，P1 先建占位）

| 源 | 目标（项目内副本，原文件不动） | 说明 |
| --- | --- | --- |
| `qwen21_layer_extract_api.json` | `backend/workflows/qwen_image_21_edit.json` | 真实执行过，作为编辑基线 |
| 模板 A 展平 | `backend/workflows/qwen_image_21_t2i.json` | **需 P2 真实提交验证** |
| 模板 B 展平 | `backend/workflows/qwen_image_21_turbo_t2i.json` | 可选 |
| 模板 D 展平 | `backend/workflows/qwen_image_21_turbo_edit.json` | 可选 |

每张图配一份 `backend/workflow_configs/<name>.yaml`，把**节点 ID 到语义角色**做显式映射（`model_loader`、`clip_loader`、`vae_loader`、`positive_encoder`、`ksampler`、`save_image`、`edit_images` …）。业务代码只按角色取节点，**任何地方都不出现硬编码节点 ID**——这既是 PROJECT.md 的硬性禁令，也让节点 ID 变动时只改 YAML。

---

## 5. 缺失依赖清单

| # | 缺失项 | 影响 | 解决方式 | 阻塞 P1？ |
| --- | --- | --- | --- | --- |
| 1 | 后端业务依赖：`sqlalchemy`、`alembic`、`python-multipart`、`pydantic-settings`（系统 Python 无） | DB 层与文件上传不可用 | 建 `backend\.venv` + `requirements.txt` | 是 |
| 2 | `pnpm` | 前端安装/脚本 | 用 npm（默认），或按 Q6 决定是否装 pnpm | 否 |
| 3 | 项目代码与 `.git` | 一切 | P1 创建 | 是 |
| 4 | 缩略图能力（`Pillow`） | P4 画廊缩略图 | P4 时加入依赖 | 否 |
| 5 | ComfyUI 历史 prompt 样本 | 少一个格式参照 | 已有 4.2 的真实 API 图替代 | 否 |

**不缺失**：ComfyUI、Qwen 2.1 全部权重、VAE、文本编码器、GPU、磁盘、网络、Python、Node、git。

---

## 6. 需要你确认的参数与决策

### Q1｜一期是否启用提示词增强（PE）？
PE 需要额外加载 9B 编码器（±9 GB）。与 8B 主编码器共存时，16 GB 显存大概率要换页，单图耗时显著上升。
- 选项 A（推荐）：**一期关闭 PE**，工作流图里保留 `ComfySwitchNode(switch=false)` 的形态，二期再加开关。
- 选项 B：P1 就做 PE 开关，接受更慢/更吃显存。

### Q2｜是否把 turbo 模型作为可选项暴露？
turbo 快，但步数被固定 sigma 表锁死（见 4.1 B）。
- 选项 A（推荐）：一期只做标准模型（25 步、cfg=1），turbo 二期。
- 选项 B：一期就暴露 turbo，前端在选中 turbo 时**隐藏 steps**（避免假参数）。

### Q3｜文生图默认参数？
我建议默认：`1024×1024`、`steps=25`、`cfg=1.0`、`sampler=euler`、`scheduler=simple`、`denoise=1.0`（全部取自官方模板实测值）。首批可选尺寸建议 `1024×1024 / 1328×1328 / 1024×1536 / 1536×1024`。请确认或给出你的偏好。

### Q4｜图片编辑的尺寸语义怎么定？
官方编辑图默认**忽略 width/height**，输出跟随参考图比例（潜空间来自编码器）。
- 选项 A（推荐）：编辑 = 「保持参考图尺寸」，前端不显示宽高输入，避免用户以为能控制。
- 选项 B：把 `switch` 置 true 允许指定尺寸（需实测与参考图比例冲突时的表现，未验证）。

### Q5｜多图批量（1/2/4/6/8）是否在 P3 前就串行排队即可？
PROJECT.md 要求「每图独立 task + 独立 seed + 串行」。确认一下：串行是我理解的**同一时刻只跑一个 ComfyUI 任务**（`WORKER_CONCURRENCY=1`），对吗？

### Q6｜两件操作授权
1. **包管理器**：直接用 npm，还是我先装 pnpm？（我倾向前者，少一步环境变更。）
2. **P2 真实出图**：进入 P2 时需要向 ComfyUI 提交至少 1 次真实生成任务用于验证文生图 API 图（约占用 GPU 10–60 秒，峰值显存可能接近上限）。是否授权？是否限定在你不在使用 GPU 的时间段？

---

## 7. 第一阶段（P1）初始化方案

### 7.1 目标（严格限定范围）

> **只做「能跑起来、能存进去、能查出来」的骨架，一行 ComfyUI 调用都不写。**

P1 结束时应能：启动后端 → 建库 → 创建一条 generation 记录（含 1–8 个 pending task）→ 从 API 和前端页面看到它。**不生成任何图片。**

### 7.2 目录与产物

```
D:\AI\MiraForge\
├── doc\PROJECT.md                     （已存在，不动）
├── doc\ENVIRONMENT_REPORT.md          （本报告）
├── .gitignore
├── README.md
├── docs\{ARCHITECTURE,API,WORKFLOW_MAPPING,DEVELOPMENT}.md   骨架
├── start-backend.ps1 / start-frontend.ps1 / setup.ps1
├── backend\
│   ├── requirements.txt
│   ├── .env.example
│   ├── alembic.ini + alembic\versions\
│   ├── app\
│   │   ├── main.py
│   │   ├── core\{config.py, events.py}
│   │   ├── models\{database.py, generation.py, task.py, image.py, workflow.py}
│   │   ├── schemas\{generation.py, task.py, image.py, workflow.py, health.py}
│   │   ├── repositories\{generation_repo.py, task_repo.py}
│   │   ├── services\generation_service.py        （仅落库，不触 ComfyUI）
│   │   ├── api\{health.py, generations.py, tasks.py, workflows.py}
│   │   └── workers\                               （P1 留空占位）
│   ├── workflows\  + workflow_configs\            （P1 放占位/空目录）
│   └── tests\test_health.py, test_generations_api.py
└── frontend\
    ├── package.json / next.config.ts / tailwind 配置
    ├── app\{layout.tsx, page.tsx}
    ├── lib\api.ts
    └── types\
```

（`storage\`、`data\` 由启动时自动创建，不入库。）

### 7.3 具体步骤

1. `git init` + `.gitignore`（排除 `.venv`、`node_modules`、`.next`、`data/*.db`、`storage/`、`.env`）。
2. 建 `backend\.venv`（Python 3.12.10），装 `requirements.txt`：`fastapi`、`uvicorn[standard]`、`sqlalchemy>=2`、`alembic`、`pydantic-settings`、`python-multipart`、`httpx`、`websockets`、`pytest`、`pytest-asyncio`。**锁版本号**。
3. 实现 `core/config.py`（Pydantic Settings，读 `.env`，键名完全按 PROJECT.md）与 `models/database.py`（SQLite，`check_same_thread=False`，开启 WAL）。
4. 建 4 张表 + 首个 Alembic 迁移；字段名与 PROJECT.md 逐字对齐。
5. 实现 `GET /api/v1/health`：返回 `{status, version, db: ok, comfyui: {reachable, version}, storage_writable}`。**ComfyUI 探测只做 `GET /system_stats` 只读探活，超时 2s，失败也不报 500**。
6. 实现 `POST /api/v1/generations`（JSON，无图）+ `GET /api/v1/generations/{id}` + `GET /api/v1/tasks/{id}`。创建时按 `requested_count` 生成 N 个 `pending` task（seed 用 `secrets.randbelow` 生成并落库，行为可复现）。**不触发任何生成。**
7. 实现 `GET /api/v1/workflows`：读 YAML 注册表（P1 先注册 0–2 条元数据，`enabled` 字段就位）。
8. 前端骨架：Next.js（App Router）+ TS + Tailwind，一个页面展示健康状态、工作流列表、创建表单 + 记录列表（TanStack Query）。**不做画廊、不做进度条。**
9. `pytest`：健康端点、创建 generation 后 task 数量与状态正确、非法 `requested_count`(>8) 返回 422。
10. 写 `README.md`（如何装、如何起、如何测）+ 4 份 docs 骨架（ARCHITECTURE 写清「前端绝不直连 ComfyUI」这条边界）。

### 7.4 验收标准（可执行）

| # | 验收项 | 标准 |
| --- | --- | --- |
| 1 | `python -m pytest backend/tests` | 全绿 |
| 2 | `uvicorn app.main:app` 启动 | `GET /api/v1/health` → 200，`db: ok`、`comfyui.reachable: true` |
| 3 | `POST /api/v1/generations` `{count: 4}` | 201；DB 中 1 条 generation + 4 条 pending task，seed 各不相同 |
| 4 | 重启后端后再查 | 记录仍在（SQLite 持久化生效） |
| 5 | `npm run dev` → `http://127.0.0.1:3000` | 页面显示健康状态与上一步创建的记录 |
| 6 | 断网/关掉 ComfyUI 后再开 | health 返回 `comfyui.reachable: false` 但服务不崩 |

### 7.5 P1 明确不做

文生图实际调用、图片存储与缩略图、编辑上传、WebSocket 进度、画廊、重试/取消的真实语义、PE、turbo、任何 ComfyUI 工作流提交。

### 7.6 P2 预告（供你判断节奏，P1 后才动）

展平 T2I 模板 → 写 `comfyui_client.py`（`/prompt` + `/history` 轮询 + `/view` 取图）→ 单任务串行 worker → **提交一次真实生成验证 Qwen 2.1 T2I API 图**，同时采集单图耗时与峰值显存（16 GB 显存下 int8 UNet + 8.9 GB 编码器的真实表现，目前无数据）。

---

## 8. 风险登记

| # | 风险 | 等级 | 缓解 |
| --- | --- | --- | --- |
| R1 | 文生图 API 图未经真实执行验证（`/history` 为空，无样本可比对） | 高 | P2 第一件事就是「最小验证提交」；失败则按 `/prompt` 返回的 `node_errors` 逐节点修正，绝不猜 |
| R2 | 16 GB 显存跑 int8 UNet + 8.9 GB 文本编码器可能触发频繁换页，单图耗时长 | 中 | P2 实测；必要时考虑 `QwenImage21Cache` 的 `device/dtype` 调优（**不改模型文件**） |
| R3 | 编辑链路 width/height 默认不生效，易造成产品预期偏差 | 中 | 见 Q4，前端按决策隐藏或显式提示 |
| R4 | turbo 的 steps 被固定 sigma 表锁死，暴露 steps 即为假参数 | 中 | 见 Q2，按模型能力动态控制 UI |
| R5 | PyPI 访问偏慢（5 s 量级），首次装依赖可能较久 | 低 | 依赖一次性装进 venv 并锁定；必要时用 `uv` |
| R6 | 本机 `Invoke-WebRequest`/`Get-NetTCPConnection` 不可靠，易误判「服务没起/端口没开」 | 低 | 脚本统一用 Python/`netstat` 探活 |

---

## 9. 证据来源（可复核）

- `GET http://127.0.0.1:8188/system_stats`（版本、GPU、显存）
- `GET http://127.0.0.1:8188/object_info`（全部节点 schema 与枚举值）
- `D:\AI\ComfyUI_Portable\ComfyUI\server.py`（`/prompt`、`/upload/image`、`/view`、`/ws`、`/history`、`/interrupt` 的契约与行号）
- `D:\AI\ComfyUI_Portable\python_embeded\Lib\site-packages\comfyui_workflow_templates_json\templates\image_qwen_image_2_1_*.json`（4 套模板原始结构）
- `D:\AI\Workflows\QwenImage21LayerExtraction\qwen21_layer_extract_api.json`（真实执行过的编辑 API 图）
- `D:\AI\ComfyUI_Portable\ComfyUI\models\` 目录清单与文件大小
- 本机 `python --version` / `node --version` / `npm --version` / `git --version` / `netstat -ano` / 磁盘剩余

---

**等你确认第 6 节的 Q1–Q6 后，我立即按第 7 节实施 P1。**
