# MiraForge

本地 AI 图片生成与编辑平台。浏览器 → Next.js → FastAPI → 单 GPU Worker → ComfyUI，生成结果落本地磁盘，元数据落 SQLite。

一期只做**图片生成与编辑**（视频为二期）。当前进度：**P1–P6 全部完成**——文生图、批量多图、参考图编辑、画廊、取消/重试/崩溃恢复都已真实跑通。

## 能做什么

- **文生图**：模型下拉（Qwen Image 2.1 25 步 / Qwen Image 2.1 Turbo 8 步），7 种比例 × 4 档长边，一次 1/2/4/6/8 张，每张独立 seed、串行执行。
- **图片编辑**：上传一张参考图 + 一句修改指令（"改成夜晚"/"换成大理石雕像"），输出比例跟随参考图。
- **画廊**：缩略图网格、分页、下载、删除、"用作参考图"一键回到编辑表单。
- **任务控制**：单任务取消（正在跑的那张会真的打断 ComfyUI）、失败/取消后重试（换新 seed）、后端重启后残留任务自动复位续跑。
- **实时进度**：WebSocket 推送 + 列表轮询双保险，展开某条记录能看到每个 task 的 seed、进度与错误。

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
.\setup.ps1        # 建 venv、装依赖、写 .env、跑迁移
.\start-backend.ps1    # http://127.0.0.1:8000/docs
.\start-frontend.ps1   # http://127.0.0.1:3000
```

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
storage/            images / thumbnails / uploads（产物）
data/               app.db
docs/               架构、API、工作流映射、开发说明
```

## 文档

- [环境检查报告](doc/ENVIRONMENT_REPORT.md)
- [架构说明](docs/ARCHITECTURE.md)
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

> 每个阶段结束时都必须能真实跑通并手动验证。一期（图片）到此完成；二期是视频生成与编辑。
> `POST /generations` 返回 `pending` 后由 Worker 接手，约 3–12 秒后图片出现在 `storage/images/`，可通过 `GET /api/v1/images/{id}/file` 访问。
> 界面在 `http://127.0.0.1:3000`（生成页）与 `/gallery`（画廊页）。
