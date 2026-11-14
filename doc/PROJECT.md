# MiraForge

## AI 图片生成与编辑平台开发规格说明书

**版本：** V1.0
**项目类型：** 个人本地 AI 图片生成平台
**开发方式：** AI Coding Agent 协作开发
**核心引擎：** ComfyUI
**主要模型：** Qwen Image、Qwen Image Edit

# 1. 项目目标

开发一个运行在本地电脑上的 Web AI 图片生成与编辑平台。

用户通过浏览器访问网站，可以使用已经部署好的 ComfyUI 和 Qwen Image 模型完成图片生成、图片编辑、批量生成、图片管理和历史记录查询。

本项目不重新开发 AI 推理引擎，而是将 ComfyUI 作为独立的图片生成服务，通过 API 与 ComfyUI 通信。

## 1.1 核心目标

第一版必须实现：

1. AI 文生图。
2. AI 图片编辑。
3. 一个 Prompt 生成多张图片。
4. 图片生成任务管理。
5. 图片画廊。
6. 图片历史记录。
7. 图片下载和删除。
8. 生成参数管理。
9. ComfyUI 工作流管理。
10. 生成进度实时展示。

## 1.2 暂不开发的功能

第一版不开发：

- 用户注册和登录。
- 会员和积分系统。
- 在线支付。
- 多 GPU 调度。
- 云端 GPU 部署。
- 社区和作品分享。
- 多用户权限管理。
- 在线工作流编辑器。

架构需要为未来扩展预留接口，但不要提前实现这些功能。

# 2. 技术架构

## 2.1 前端

使用：

- Next.js
- React
- TypeScript
- Tailwind CSS
- Zustand
- TanStack Query

前端负责：

- 页面展示。
- 用户交互。
- 参数配置。
- API 调用。
- 任务状态展示。
- 图片预览。
- 图片画廊。

## 2.2 后端

使用：

- Python 3.11 或与现有环境兼容的版本。
- FastAPI
- Pydantic
- SQLAlchemy
- SQLite
- WebSocket
- httpx

后端负责：

- 接收前端请求。
- 验证用户输入。
- 创建生成批次。
- 管理图片任务。
- 调用 ComfyUI。
- 获取生成结果。
- 管理本地图片。
- 保存数据库记录。
- 推送任务状态。

## 2.3 AI 引擎

使用现有 ComfyUI。

不修改 ComfyUI 源代码。

通过 ComfyUI 官方 API 完成工作流提交、任务状态查询、图片获取。

主要接口：

- POST /prompt
- GET /history/{prompt_id}
- GET /queue
- GET /view
- WebSocket /ws

ComfyUI 地址使用环境变量配置。

默认开发地址：

http://127.0.0.1:8188

## 2.4 数据存储

使用 SQLite。

图片存储在本地文件系统。

建议：

- 数据库保存图片元数据。
- 文件系统保存图片原文件。
- 缩略图单独保存。
- 不将图片二进制内容直接写入 SQLite。

# 3. 系统架构

系统采用前后端分离架构。

浏览器
↓
Next.js 前端
↓
FastAPI 后端
↓
任务管理器
↓
单 GPU 生成 Worker
↓
ComfyUI API
↓
Qwen Image / Qwen Image Edit
↓
本地图片存储
↓
SQLite 数据库

前端不允许直接访问 ComfyUI。

所有生成请求必须经过 FastAPI。

ComfyUI 只作为后端内部服务使用。

# 4. 功能模块

## 4.1 AI 文生图

页面名称：Text to Image

功能：

- 输入 Prompt。
- 选择工作流。
- 选择模型。
- 设置图片宽度。
- 设置图片高度。
- 设置生成数量。
- 设置 Seed。
- 设置 Steps。
- 设置 CFG。
- 提交生成任务。
- 查看生成进度。
- 查看生成结果。

参数要求：

| 参数        | 类型         | 说明            |
| ----------- | ------------ | --------------- |
| prompt      | string       | 图片提示词      |
| workflow_id | string       | 工作流 ID       |
| width       | integer      | 图片宽度        |
| height      | integer      | 图片高度        |
| count       | integer      | 生成数量        |
| seed        | integer/null | 随机或指定 Seed |
| steps       | integer/null | 采样步数        |
| cfg         | number/null  | CFG 参数        |

注意：

不同 ComfyUI 工作流的参数不完全一致。

后端必须根据工作流配置决定哪些参数可以修改，不得假设所有 Qwen 工作流都具有相同的节点结构。

## 4.2 多张图片生成

用户输入一个 Prompt，可以选择生成 1、2、4、6、8 张图片。

系统创建一个 Generation Batch。

每张图片拥有独立 Task ID。

每张图片拥有独立 Seed。

默认使用单 GPU 串行执行。

例如：

Generation ID: G10001

Task 1: Seed 10001
Task 2: Seed 10002
Task 3: Seed 10003
Task 4: Seed 10004

Seed 规则：

- 用户没有指定 Seed 时，自动生成随机 Seed。
- 用户指定固定 Seed 时，支持使用相同 Seed 进行可复现生成。
- 每张图片的实际 Seed 必须保存。
- 不得让同一批次的图片意外使用相同 Seed。

注意：不同 Seed 不保证生成结果一定有明显差异。

多图生成应优先采用多个独立任务，而不是强制依赖 ComfyUI Batch Size。

## 4.3 AI 图片编辑

页面名称：Image to Image / Image Edit

功能：

1. 用户上传原始图片。
2. 用户输入编辑提示词。
3. 用户选择图片编辑工作流。
4. 用户设置生成参数。
5. 系统将图片上传到 ComfyUI。
6. 调用 Qwen Image Edit 工作流。
7. 获取编辑后的图片。
8. 保存原始图片和编辑结果。
9. 展示编辑前后对比。

必须保留原始图片，不得覆盖原始文件。

图片编辑记录需要关联：

- 原始图片 ID。
- 编辑任务 ID。
- 编辑 Prompt。
- 实际 Seed（如果工作流支持）。
- 工作流 ID。
- 输出图片 ID。

## 4.4 生成任务管理

任务状态：

- pending
- queued
- running
- completed
- failed
- cancelled

任务管理要求：

- 显示排队状态。
- 显示生成进度。
- 显示开始时间。
- 显示完成时间。
- 显示失败原因。
- 支持取消尚未开始的任务。
- 支持重新执行失败任务。

已经提交到 ComfyUI 正在执行的任务，第一版不要求实现强制中断 GPU 推理。

取消运行中的任务时，应明确区分用户取消请求和 ComfyUI 实际停止状态。

## 4.5 图片画廊

页面名称：Gallery

功能：

- 网格展示图片。
- 支持不同尺寸缩略图。
- 点击图片放大预览。
- 下载原图。
- 删除图片。
- 查看 Prompt。
- 查看 Seed。
- 查看模型。
- 查看生成时间。
- 跳转到所属批次。

支持按时间倒序排列。

图片删除时，需要明确区分删除数据库记录与删除磁盘文件，确保不会产生孤立文件。

## 4.6 历史记录

页面名称：History

显示每次生成批次。

每条记录包含：

- Batch ID
- Prompt
- 工作流
- 模型
- 生成数量
- 成功数量
- 失败数量
- 创建时间
- 任务状态

点击批次可以查看其中所有图片。

## 4.7 工作流管理

页面名称：Workflow Settings

第一版提供两个默认工作流：

- Qwen Image Text to Image
- Qwen Image Edit

工作流文件保存在：

backend/workflows/

工作流管理功能：

- 显示工作流名称。
- 显示工作流类型。
- 显示工作流启用状态。
- 设置工作流 API JSON 文件。
- 保存节点参数映射。
- 测试工作流连接。
- 验证工作流 JSON 格式。

不要在业务代码中硬编码 ComfyUI 节点 ID。

使用独立的工作流配置文件定义节点映射。

# 5. 项目目录结构

my-ai-image-studio/

frontend/
app/
page.tsx
generate/
page.tsx
edit/
page.tsx
gallery/
page.tsx
history/
page.tsx
settings/
page.tsx

components/
layout/
generation/
editor/
gallery/
tasks/
common/

hooks/
lib/
stores/
types/

backend/
app/
main.py

```
api/
  generations.py
  tasks.py
  images.py
  workflows.py

core/
  config.py
  events.py

services/
  comfyui_client.py
  generation_service.py
  image_service.py
  workflow_service.py

workers/
  generation_worker.py
  task_scheduler.py

models/
  database.py
  generation.py
  task.py
  image.py
  workflow.py

schemas/
  generation.py
  task.py
  image.py
  workflow.py

repositories/
  generation_repository.py
  task_repository.py
  image_repository.py
```

workflows/
qwen_txt2img.json
qwen_image_edit.json

workflow_configs/
qwen_txt2img.yaml
qwen_image_edit.yaml

tests/

storage/
images/
thumbnails/
uploads/

data/
app.db

.env.example
.gitignore
README.md

# 6. 数据库设计

使用 SQLAlchemy 管理 SQLite。

## 6.1 generations 表

保存生成批次。

字段：

- id：主键。
- prompt：提示词。
- workflow_id：工作流 ID。
- generation_type：text2img 或 image_edit。
- model_name：模型名称。
- width：宽度。
- height：高度。
- requested_count：请求数量。
- status：批次状态。
- created_at：创建时间。
- completed_at：完成时间。

## 6.2 generation_tasks 表

保存每张图片的独立生成任务。

字段：

- id：主键。
- generation_id：所属批次。
- seed：随机种子。
- status：任务状态。
- comfy_prompt_id：ComfyUI Prompt ID。
- progress：生成进度。
- error_message：错误信息。
- started_at：开始时间。
- completed_at：完成时间。

## 6.3 images 表

保存图片元数据。

字段：

- id：主键。
- task_id：关联任务。
- generation_id：关联批次。
- file_path：图片路径。
- thumbnail_path：缩略图路径。
- original_image_id：原始图片 ID，编辑任务使用。
- width：图片宽度。
- height：图片高度。
- file_size：文件大小。
- created_at：创建时间。

## 6.4 workflows 表

保存工作流配置。

字段：

- id：主键。
- name：工作流名称。
- type：工作流类型。
- json_path：API 工作流文件路径。
- config_path：节点参数映射配置。
- enabled：是否启用。
- created_at：创建时间。

数据库必须使用迁移机制管理结构变更，推荐 Alembic。

# 7. API 接口设计

所有业务接口统一使用：

/api/v1/

## 7.1 创建图片生成批次

POST /api/v1/generations

请求示例：

{
"prompt": "A beautiful orange cat in a cafe",
"workflow_id": "qwen_txt2img",
"width": 1024,
"height": 1024,
"count": 4,
"seed": null
}

返回：

{
"generation_id": "G10001",
"status": "queued",
"count": 4
}

## 7.2 创建图片编辑任务

POST /api/v1/generations/edit

使用 multipart/form-data。

字段：

- prompt
- workflow_id
- image
- seed（可选）

返回：

{
"generation_id": "G10002",
"status": "queued"
}

## 7.3 查询批次详情

GET /api/v1/generations/{generation_id}

返回批次信息和全部图片任务。

## 7.4 查询任务状态

GET /api/v1/tasks/{task_id}

返回：

- status
- progress
- seed
- error_message
- image_url

## 7.5 重新执行任务

POST /api/v1/tasks/{task_id}/retry

## 7.6 取消任务

POST /api/v1/tasks/{task_id}/cancel

## 7.7 获取图片列表

GET /api/v1/images

支持分页和时间排序。

## 7.8 删除图片

DELETE /api/v1/images/{image_id}

## 7.9 获取工作流列表

GET /api/v1/workflows

## 7.10 WebSocket

WS /api/v1/ws/tasks

用于推送：

- 任务进入队列。
- 任务开始。
- 生成进度变化。
- 任务完成。
- 任务失败。
- 图片生成结果。

WebSocket 消息必须包含 task_id 和 generation_id。

# 8. ComfyUI 集成规范

这是本项目最重要的技术模块。

## 8.1 工作流管理

使用 ComfyUI 导出的 API Format JSON。

不要直接使用普通前端 Workflow JSON 作为 API 工作流。

工作流 JSON 必须先经过验证。

## 8.2 节点参数映射

不同 Qwen 工作流的节点结构可能不同。

因此使用 YAML 保存节点映射。

例如：

workflow_id: qwen_txt2img

workflow_file: qwen_txt2img.json

nodes:
prompt:
node_id: "实际节点ID"
input_name: "text"

seed:
node_id: "实际节点ID"
input_name: "seed"

以上 node_id 和 input_name 必须根据实际导出的工作流填写，不允许 Agent 自行猜测。

## 8.3 提交任务

后端：

1. 读取工作流 JSON。
2. 深拷贝工作流。
3. 修改允许的节点参数。
4. 提交到 ComfyUI /prompt。
5. 获取 prompt_id。
6. 保存 prompt_id 与 task_id 的关联。
7. 监听执行状态。

不得直接修改磁盘上的原始工作流模板。

## 8.4 获取任务进度

优先使用 ComfyUI WebSocket。

通过 prompt_id 匹配对应任务。

需要正确处理：

- execution_start
- executing
- progress
- execution_success
- execution_error

具体事件结构应以当前 ComfyUI 版本实际返回的数据为准。

## 8.5 获取生成图片

任务完成后：

1. 查询 /history/{prompt_id}。
2. 读取 outputs。
3. 遍历实际输出图片。
4. 获取图片文件信息。
5. 通过 /view 获取图片。
6. 复制到项目 storage/images。
7. 保存数据库记录。
8. 通知前端。

一个 ComfyUI 任务可能输出多张图片，因此不能假设每个 prompt_id 只对应一张图片。

## 8.6 图片编辑上传

Qwen Image Edit 工作流可能使用 Load Image、图像预处理等不同节点。

后端必须根据实际工作流确定上传和图片输入方式。

不得假设所有图片编辑工作流都使用相同节点。

# 9. 任务调度设计

第一版只使用一个 GPU Worker。

采用单 GPU 串行执行策略。

任务流程：

pending
↓
queued
↓
running
↓
completed / failed

要求：

- 同一时间只允许一个业务 Worker 调度新的生成任务。
- ComfyUI 内部队列负责实际执行。
- 任务状态持久化。
- 服务重启后可以恢复未完成任务。
- 已提交给 ComfyUI 的任务不能被重复提交。
- 必须考虑后端重启时的状态恢复。
- 失败任务可以独立重试。
- 任务取消必须区分排队和运行中状态。

第一版不需要 Redis 和 Celery。

但任务调度必须与 API 路由解耦，不能把长时间图片生成逻辑直接写进 HTTP 请求处理函数。

建议使用 asyncio Queue 或基于数据库的持久化任务调度。

注意：仅使用内存队列不能保证进程重启后的任务恢复，因此必须将任务状态持久化到 SQLite。

# 10. 前端 UI 设计要求

整体采用现代化 AI SaaS 风格。

设计要求：

- 简洁。
- 深色主题优先。
- 响应式布局。
- 图片优先。
- 操作直观。
- 不堆叠过多设置项。

## 10.1 主页面

布局：

左侧导航栏：

- Generate
- Image Edit
- Gallery
- History
- Settings

主内容区：

- Prompt 输入区域。
- 模型和工作流选择。
- 图片尺寸。
- 生成数量。
- 高级参数折叠区域。
- Generate 按钮。

生成结果区：

- 图片网格。
- 任务进度。
- 图片预览。
- 下载按钮。
- 重新生成按钮。

## 10.2 图片编辑页面

布局：

- 图片上传区域。
- 原始图片预览。
- Prompt 输入。
- 编辑参数。
- 开始编辑。
- 编辑结果。
- 前后对比。

## 10.3 Gallery

使用响应式 Grid。

支持：

- 点击放大。
- 图片下载。
- 删除。
- 查看图片详情。
- 按生成时间排序。

## 10.4 生成状态

需要清晰区分：

- 排队中。
- 生成中。
- 已完成。
- 失败。
- 已取消。

不允许在图片还没有实际生成完成时显示虚假的成功状态。

# 11. 配置管理

使用 .env 配置：

COMFYUI_URL=http://127.0.0.1:8188

DATABASE_URL=sqlite:///./data/app.db

STORAGE_DIR=./storage

MAX_GENERATION_COUNT=8

WORKER_CONCURRENCY=1

APP_HOST=127.0.0.1

APP_PORT=8000

前端配置：

NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000/api/v1

敏感信息和机器相关配置不得硬编码到源代码。

如果前后端跨域，必须明确配置 CORS。

本地部署默认只监听 127.0.0.1，除非用户明确要求局域网访问。

# 12. 安全与稳定性

必须实现：

1. Prompt 长度限制。
2. 上传文件大小限制。
3. 上传文件类型验证。
4. 文件名安全处理。
5. 图片路径防目录穿越。
6. API 参数验证。
7. ComfyUI 连接超时处理。
8. 任务异常捕获。
9. 数据库事务处理。
10. 图片存储异常处理。

不允许前端直接传入任意 ComfyUI 工作流 JSON。

前端只能修改后端明确允许的参数。

删除图片时需要确保数据库和文件系统保持一致。

# 13. 开发阶段

必须按照阶段推进，不要一次性生成全部代码。

## Phase 1：项目初始化

完成：

- Next.js 项目。
- FastAPI 项目。
- SQLite。
- 基础目录。
- 环境配置。
- 前后端通信。

验收：

浏览器可以访问前端，前端可以请求后端健康检查接口。

## Phase 2：ComfyUI API 集成

完成：

- ComfyUI 连接测试。
- 加载实际 API 工作流。
- 提交测试任务。
- 查询任务状态。
- 获取输出图片。
- 保存本地图片。

验收：

通过 FastAPI 成功调用现有 Qwen Image 工作流生成一张图片。

## Phase 3：多图生成

完成：

- 创建生成批次。
- 创建独立图片任务。
- Seed 管理。
- 单 GPU 串行调度。
- 状态管理。
- 多张图片结果返回。

验收：

一个 Prompt 可以生成四张独立图片，并且每张图片都有独立任务记录。

## Phase 4：图片编辑

完成：

- 图片上传。
- ComfyUI 图片输入。
- Qwen Image Edit 工作流。
- 编辑结果保存。
- 原图和结果关联。

验收：

用户上传一张图片，输入编辑指令，可以在网站中看到编辑结果。

## Phase 5：前端页面

完成：

- 文生图页面。
- 图片编辑页面。
- 图片画廊。
- 历史记录。
- 任务进度。
- 图片详情。

验收：

用户不需要打开 ComfyUI 页面，就能完成全部基本图片生成操作。

## Phase 6：稳定性测试

完成：

- 多批次任务。
- 连续生成。
- 任务失败重试。
- 后端重启恢复。
- ComfyUI 中断恢复。
- 图片删除。
- 数据库一致性。

验收：

系统在异常情况下不会静默丢失任务或错误地显示生成成功。

# 14. 测试要求

后端使用 pytest。

前端使用适当的组件测试和端到端测试。

必须测试：

1. ComfyUI 不可连接。
2. 工作流 JSON 不存在。
3. 工作流节点映射错误。
4. 图片上传失败。
5. 图片生成失败。
6. 多张图片部分成功。
7. 单张任务重试。
8. 任务重复提交。
9. 后端重启。
10. 数据库异常。

测试 ComfyUI 时允许使用 Mock，但必须至少完成一次真实 ComfyUI 集成测试。

# 15. 开发 Agent 工作规范

Agent 必须遵循以下要求。

## 15.1 开发原则

- 先阅读项目现有代码。
- 先检查 ComfyUI 实际工作流。
- 不猜测节点 ID。
- 不猜测模型参数。
- 不修改 ComfyUI 源代码。
- 不重复造轮子。
- 优先使用官方 API。
- 模块职责清晰。
- 前后端分离。
- 保持类型定义一致。
- 所有关键异常必须记录日志。

## 15.2 开发流程

每完成一个 Phase：

1. 总结本阶段完成内容。
2. 列出修改和新增文件。
3. 运行相关测试。
4. 检查是否有未解决的问题。
5. 提供启动和验证方法。
6. 等待确认后再进入下一阶段。

不要一次性实现所有功能。

## 15.3 禁止事项

- 不允许伪造图片生成结果。
- 不允许使用静态假数据冒充真实任务状态。
- 不允许硬编码 ComfyUI 节点 ID。
- 不允许将图片生成过程阻塞在 HTTP 请求中。
- 不允许未经验证修改原始工作流。
- 不允许为了简化代码省略任务状态持久化。
- 不允许未经确认删除用户已有模型或工作流。
- 不允许将真实密钥提交到 Git。

## 15.4 文档维护

项目必须维护：

README.md：项目介绍和启动方法。

docs/ARCHITECTURE.md：系统架构。

docs/API.md：接口说明。

docs/WORKFLOW_MAPPING.md：ComfyUI 节点映射。

docs/DEVELOPMENT.md：开发进度和注意事项。

每个 Phase 完成后更新开发文档。

# 16. 最终交付标准

项目完成后，必须能够：

1. 启动 ComfyUI。
2. 启动 FastAPI。
3. 启动 Next.js。
4. 浏览器打开网站。
5. 输入 Prompt。
6. 选择 Qwen Image 工作流。
7. 一次生成多张图片。
8. 查看生成进度。
9. 查看和下载图片。
10. 上传图片并调用 Qwen Image Edit。
11. 查看生成历史。
12. 重新执行失败任务。
13. 重启后保留历史数据和图片。

最终目标：

构建一个完全独立于 ComfyUI 前端界面的个人 AI 图片生成与编辑平台。

ComfyUI 负责 AI 推理，Personal AI Image Studio 负责完整的用户体验和业务管理。