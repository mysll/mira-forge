# MiraForge

本地 AI 图片生成与编辑平台。浏览器 → Next.js → FastAPI → 单 GPU Worker → ComfyUI，生成结果落本地磁盘，元数据落 SQLite。

一期只做**图片生成与编辑**（视频为二期）。当前进度：**P1–P7 全部完成**——文生图、批量多图、参考图编辑、取消/重试/崩溃恢复都已真实跑通，前端为「左窄导航 + 右创作工作区」的两栏工作台。

## 能做什么

- **工作台**：左侧 72px 图标导航（资产 / 图片 / 视频 / 设置），右侧一条完整创作链路——顶部筛选工具条、中间按「今天 / 昨天 / 更早」分组的作品流、底部悬浮创作框。没有第三栏、没有把参数平铺一屏。
- **资产库**：`/gallery` 一页看全部图片——响应式网格、按日期分组、按生成时间从新到旧，图片直接可收藏 / 下载 / 继续编辑 / 删除；点「管理」可勾选批量删除，或清空整个工作区（危险操作，二次确认）。
- **文生图**：模型下拉（Qwen Image 2.1 25 步 / Qwen Image 2.1 Turbo 8 步），7 种比例 × 4 档长边，一次 1/2/4/6/8 张，每张独立 seed、串行执行。
- **参考图生成（图生图）**：在「图片生成」里可选加 1–2 张参考图——有图就参考构图/材质出图，无图就是普通文生图；参考图不改变输出比例，尺寸仍按右下角的设置（实测同一句提示词，加参考图后画面构图明显跟随参考图）。
- **图片编辑**：上传或拖入一张参考图 + 一句修改指令（"改成夜晚"/"换成大理石雕像"），输出比例跟随参考图；也能从作品流 hover「继续编辑」把整张图当参考图带回来。
- **作品流**：缩略图网格 / 列表两种视图，按提示词搜索、按模型与日期筛选、仅看收藏；hover 出查看大图 / 收藏 / 继续编辑 / 下载 / 删除。
- **大图详情**：图片 + 正面/负面提示词 + 模型 + Seed + 尺寸 + 生成时间 + 步数/CFG/采样器，可复制提示词与 Seed、下载、继续编辑、重新生成。
- **高级设置**：默认折叠，按模型能力动态显隐（Seed 随机/固定、步数、CFG、采样器、负面提示词）。
- **任务控制**：单任务取消（正在跑的那张会真的打断 ComfyUI）、失败/取消后重试（换新 seed）、后端重启后残留任务自动复位续跑。
- **实时进度**：WebSocket 推送 + 轮询双保险；还没出图的格子直接以占位卡排在最终位置——排队中显示「排队中」，生成中显示百分比与进度条，出图后原地替换。
- **系统状态**：从首页移到「设置」页（后端版本、SQLite 路径、ComfyUI 版本/连接/GPU、存储路径）。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS 3 · TanStack Query 5 · Zustand 5 |
| 后端 | FastAPI · Pydantic v2 · SQLAlchemy 2 · Alembic · httpx · WebSocket |
| 存储 | SQLite（`data/app.db`，WAL 模式）· 本地文件（`storage/`） |
| 生成 | ComfyUI HTTP API（默认 `http://127.0.0.1:8188`），Qwen Image 2.1 / Turbo |

前端**永远不直连 ComfyUI**：所有生成请求由后端排队，Worker 串行提交，避免并发把 16 GB 显存打爆。

## 环境要求

- Windows + PowerShell 7
- Python 3.12（`C:\Program Files\Python312\python.exe`）+ [uv](https://docs.astral.sh/uv/)
- Node.js 24 + npm
- ComfyUI 已安装并能用 `run_nvidia_gpu.bat` 启动，且已有 Qwen Image 2.1 权重

## 快速开始

```powershell
.\setup.ps1     # 首次：建 venv、装依赖、写 .env、跑迁移
.\start.ps1     # 以后：一条命令起全部，就绪后自动开浏览器
```

`start.ps1` 会先确认 ComfyUI 在 8188 上活着（没开就给提示，加 `-StartComfyUI` 可以帮你拉起 `run_nvidia_gpu.bat`），然后把后端和前端各自放进一个新窗口启动，等两边都响应了再打开 <http://127.0.0.1:3000>。关脚本不影响服务，停服一律用 `.\stop.ps1`。

两个地址等价，都可以用：<http://127.0.0.1:3000> 与 <http://localhost:3000>。

想分开调试时仍然可以单独起：

```powershell
.\start-backend.ps1    # http://127.0.0.1:8000/docs
.\start-frontend.ps1   # http://127.0.0.1:3000
```

> 为什么要起两个进程？因为前端是 Node/Next，后端是 Python/FastAPI，本来就是两个运行时。生产部署时通常由 Nginx 把 `/api` 反代到后端、其余给前端，开发期则是两个开发服务器各跑各的。`start.ps1` 只是把这两步合成一条命令。

检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/v1/health | ConvertTo-Json -Depth 5
```

## 目录

```
backend/            FastAPI 应用
  app/api/          HTTP 端点（health / models / workflows / generations / tasks / images）
  app/core/         配置、WebSocket 广播、Alembic 迁移入口
  app/models/       SQLAlchemy 模型（workflows / generations / generation_tasks / images）
  app/schemas/      Pydantic 响应与请求模型
  app/services/     注册表、生成记录、参数注入、ComfyUI 客户端、图片落盘
  app/workers/      generation_worker —— 串行消费任务、驱动 ComfyUI
  alembic/          迁移脚本
  workflow_configs/ registry.yaml（模型目录）+ 每个工作流的参数绑定 YAML
  workflows/        ComfyUI API 格式工作流 JSON
frontend/           Next.js 应用
  app/              page.tsx（创作页）/ gallery（资产库）/ settings
  components/       Sidebar · TopBar · Feed · FeedCard · ImageDetail · Composer · Popover · ToastStack
  hooks/            useImageActions（收藏 / 下载 / 删除 / 继续编辑 / 重新生成，两个页面共用）
  stores/           composer（创作框状态）· reference（编辑参考图）· generationRefs（生成模式参考图）
  lib/              api · size（比例与分辨率）· date（日期分组与筛选）
storage/            images / thumbnails / uploads（产物）
data/               app.db
docs/               架构、API、工作流映射、开发说明
```

## 文档

- [环境检查报告](doc/ENVIRONMENT_REPORT.md)
- [架构说明](docs/ARCHITECTURE.md)
- [前端工作台](docs/FRONTEND.md)
- [API 参考](docs/API.md)
- [工作流映射](docs/WORKFLOW_MAPPING.md)
- [开发说明](docs/DEVELOPMENT.md)

## 阶段计划

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P1 | 前后端骨架、SQLite、健康检查、任务入库 | ✅ 完成 |
| P2 | ComfyUI 集成，Qwen Image 2.1 / Turbo 真实出图、进度回传、产物落盘 | ✅ 完成 |
| P3 | 多图批量（1/2/4/6/8，独立 seed，串行）、比例 / 分辨率预设面板 | ✅ 完成 |
| P4 | 图片编辑（上传参考图，Qwen Image 2.1 Edit 真实出图） | ✅ 完成 |
| P5 | 前端画廊 / 历史 / 预览、缩略图、删除、用作参考图 | ✅ 完成 |
| P6 | 取消、重试、崩溃恢复、WebSocket 实时刷新 | ✅ 完成 |
| P7 | 前端重构为两栏创作工作台（作品流 / 创作框 / 详情弹窗 / 设置页），后端补生成参数落库、收藏与筛选 | ✅ 完成 |
| P8 | 参考图生成（图生图）：1–2 张参考图只参考构图、尺寸仍生效，独立工作流与绑定配置 | ✅ 完成 |

> 每个阶段结束时都必须能真实跑通并手动验证。一期（图片）到此完成；二期是视频生成与编辑。
> `POST /generations` 返回 `pending` 后由 Worker 接手，约 3–12 秒后图片出现在 `storage/images/`，可通过 `GET /api/v1/images/{id}/file` 访问。
> 界面在 `http://127.0.0.1:3000`（`/` 创作、`/gallery` 资产库、`/settings` 系统状态）。
