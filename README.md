# MiraForge

本地 AI 图片生成与编辑平台。浏览器 → Next.js → FastAPI → 单 GPU Worker → ComfyUI，生成结果落本地磁盘，元数据落 SQLite。

一期只做**图片生成与编辑**（视频为二期）。当前进度：**P1 初始化完成**（骨架可运行、可测试、可持久化），尚未接入真实出图。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS 3 · TanStack Query 5 |
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
  app/api/          HTTP 端点（health / models / workflows / generations / tasks）
  app/core/         配置、WebSocket 广播、Alembic 迁移入口
  app/models/       SQLAlchemy 模型（workflows / generations / generation_tasks / images）
  app/schemas/      Pydantic 响应与请求模型
  app/services/     注册表解析、生成记录创建
  app/workers/      任务执行（P2 落地）
  alembic/          迁移脚本
  workflow_configs/ registry.yaml —— 模型目录唯一数据源
  workflows/        ComfyUI API 格式工作流 JSON（P2 落地）
frontend/           Next.js 应用
storage/            images / thumbnails / uploads
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
| P2 | ComfyUI 集成，Qwen Image 2.1 真实出图 | 待开始 |
| P3 | 多图批量（1/2/4/6/8，独立 seed，串行） | 待开始 |
| P4 | 图片编辑（上传参考图） | 待开始 |
| P5 | 前端画廊 / 历史 / 预览 | 待开始 |
| P6 | 取消、重试、失败恢复、稳定性 | 待开始 |

> 每个阶段结束时都必须能真实跑通并手动验证；P1 的"生成"只入库为 `pending`，不会产出图片——这是刻意的边界，不是缺陷。
