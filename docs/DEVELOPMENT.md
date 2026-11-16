# 开发说明

## 一次性初始化

```powershell
.\setup.ps1
```

做四件事：建 `backend\.venv`（用 `uv` 装依赖）、复制 `.env` 样板、跑 `alembic upgrade head`、前端 `npm install`。幂等，可重复执行。

## 日常启动

一条命令（推荐）：

```powershell
.\start.ps1            # 检查 ComfyUI → 起后端 → 起前端 → 等就绪 → 开浏览器
.\start.ps1 -StartComfyUI   # ComfyUI 没开时顺手拉起 run_nvidia_gpu.bat
.\stop.ps1             # 停后端与前端；-IncludeComfyUI 连 ComfyUI 一起停
```

脚本用 `Start-Process pwsh -NoExit` 把后端/前端各放进一个新窗口，然后用 `Get-NetTCPConnection` 判断端口是否已占用：已经在跑的就跳过，不重复起。

分开调试时：

```powershell
.\start-backend.ps1          # http://127.0.0.1:8000/docs
.\start-backend.ps1 -Reload  # 改代码自动重载
.\start-frontend.ps1         # http://127.0.0.1:3000
```

为什么是两个进程：前端是 Node/Next，后端是 Python/FastAPI，两个不同运行时；开发期各跑各的开发服务器，生产期由反向代理按路径分流。

页面用 `http://localhost:3000` 或 `http://127.0.0.1:3000` 打开都可以——浏览器把它们当成**两个不同的 Origin**，所以 `FRONTEND_ORIGIN` 里两个都列了；`next.config.ts` 的 `allowedDevOrigins` 同理放行了两者，避免 dev 资源被当成跨域。

## 测试

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest        # 63 项，约 3.4 秒
```

测试使用独立的临时库 `backend/.pytest-tmp/test.db`（在 `conftest.py` 里于 import app 之前设定 `DATABASE_URL`），**不会污染** `data/app.db`。

`conftest.py` 还强制 `WORKER_ENABLED=false`：否则 TestClient 会触发 lifespan，把测试任务真的提交给本机 ComfyUI（第一版就踩到了，ComfyUI 队列里出现了一条测试 prompt）。

测试文件分工：`test_health.py`（健康检查与模型目录）、`test_generations.py`（创建/校验/列表/WS）、`test_workflows_build.py`（参数注入、参考图槽位摘除与状态聚合）、`test_edits.py`（参考图上传）、`test_image_to_image.py`（图生图 1–2 张、超限 422、按 index 回显参考图）、`test_gallery.py`（缩略图/删除/分页）、`test_stability.py`（取消/重试/启动复位）、`test_workspace_api.py`（生成参数落库、搜索/模型/收藏/日期筛选）。

注意测试库是 session 级共享的，写「脏状态」的用例要考虑别的用例的残留（`reset_interrupted_tasks` 就因此断言 `>= 2` 而不是 `== 2`）。

前端类型检查：

```powershell
cd frontend
npx tsc --noEmit
```

## 本机的几个坑（都已在脚本里规避）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `python -m venv .venv` 后 `No module named pip` | 本机 `ensurepip` 失败（`returned non-zero exit status 1`） | `python -m venv --without-pip` + `uv pip install --python .venv\Scripts\python.exe -r requirements.txt` |
| `npm install` 报 `EPERM ... \AppData\Local\npm-cache\` | 缓存目录不可写 | 设 `npm_config_cache=D:\AI\MiraForge\.npm-cache` |
| pytest 报写 `.pytest_cache` 失败 | 同上 | `pytest.ini` 里 `-p no:cacheprovider` |
| `Invoke-WebRequest https://…` 报 SSL 失败 | 本机 PowerShell 的 TLS 配置问题，不是断网 | 用 `python -c "import urllib.request…"` 或 `npm ping` 验证网络 |
| `next build` 报 `spawn EPERM` | 构建要 spawn 子进程并捕获 stdio，受限沙箱禁止命名管道 | 用具备正常进程权限的终端运行；开发期用 `next dev` 不受影响 |

## 环境变量

`backend/.env`（从 `.env.example` 复制）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | 只有 Worker 用 |
| `COMFYUI_TIMEOUT_SECONDS` | `2.0` | 健康检查超时（不影响真实生成） |
| `DATABASE_URL` | `sqlite:///./data/app.db` | 相对路径以项目根解析 |
| `STORAGE_DIR` | `./storage` | 同上 |
| `MAX_GENERATION_COUNT` | `8` | 单次请求上限 |
| `WORKER_CONCURRENCY` | `1` | 保持 1，单卡串行 |
| `WORKER_ENABLED` | `true` | 是否随应用启动生成 Worker（测试/调试置 `false`） |
| `APP_HOST` / `APP_PORT` | `127.0.0.1` / `8000` | |
| `FRONTEND_ORIGIN` | `http://127.0.0.1:3000,http://localhost:3000` | CORS 白名单（逗号分隔；localhost 与 127.0.0.1 是两个 Origin，都要列） |
| `AUTO_MIGRATE` | `true` | 启动时自动 `alembic upgrade head` |

`frontend/.env.local`：`NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000/api/v1`。

`.env`、`.env.local`、`data/`、`storage/`、`*.db` 均在 `.gitignore` 中。

## 新增一个模型

不需要改 Python 代码，只改数据：

1. 在 `backend/workflow_configs/registry.yaml` 的 `models:` 下加条目（id / label / description / defaults / capabilities / workflows，`default: true` 可标记默认模型）。
2. 放两个工作流 JSON 到 `backend/workflows/`，路径与 `workflows[].json` 一致。
3. 为每个工作流写 `backend/workflow_configs/<name>.yaml`：`output_node` + `bindings` +（编辑类）`reference_image`。
4. 重启后端（或刷新页面）——`/models` 每次请求都重读 YAML，`available` 由 JSON 是否存在决定。

新增工作流 JSON 的内容依据见 [WORKFLOW_MAPPING.md](WORKFLOW_MAPPING.md)，**不要凭印象填节点 ID**。

## 调试生成链路

```powershell
# 1. 看 ComfyUI 是否在线
Invoke-RestMethod http://127.0.0.1:8000/api/v1/health | ConvertTo-Json -Depth 5

# 2. 提交一次生成
Invoke-RestMethod -Method Post http://127.0.0.1:8000/api/v1/generations `
  -ContentType application/json `
  -Body '{"prompt":"a glass lighthouse at dusk","model":"qwen_image_21_turbo","count":1}'

# 3. 轮询结果（Worker 串行执行，通常几秒）
Invoke-RestMethod http://127.0.0.1:8000/api/v1/generations/5 | ConvertTo-Json -Depth 6

# 4. 取图
Start-Process http://127.0.0.1:8000/api/v1/images/1/file
```

Worker 出错时先看后端日志（`logger "miraforge.worker"`），任务的 `error_message` 会保存同一句原因。

### 取消、重试、崩溃恢复怎么验

```powershell
# 提交 4 张，趁排队时取消一个
$g = Invoke-RestMethod -Method Post http://127.0.0.1:8000/api/v1/generations `
  -ContentType application/json `
  -Body '{"prompt":"a stack of river stones","model":"qwen_image_21_turbo","count":4}'
Invoke-RestMethod -Method Post http://127.0.0.1:8000/api/v1/tasks/$($g.tasks[0].id)/cancel

# 重试刚取消的任务（同一条记录下追加新 seed）
Invoke-RestMethod -Method Post http://127.0.0.1:8000/api/v1/tasks/$($g.tasks[0].id)/retry

# 崩溃恢复：生成中途 Ctrl+C 掉 uvicorn 再启动，日志里应出现
#   "上次退出时残留的 N 个 queued/running 任务已复位为 pending"
# 且这些任务会重新跑完
```

取消跑着的那张时，Worker 会先 `POST /interrupt`，ComfyUI 那边也会真的停下——可以在 ComfyUI 界面的队列里确认。

### 用截图核对 UI

`tools/screenshot.mjs` 是无头 Edge + CDP 的小工具（headless 的 `--screenshot` 不能点击、不能等异步数据）：

```powershell
node tools\screenshot.mjs --url http://127.0.0.1:3000 --out data\ui.png --width 1500 --height 1300
node tools\screenshot.mjs --url http://127.0.0.1:3000 --out data\ui-detail.png --click "详情" --wait 2500
```

参数：`--click <文字>` 点第一个文本匹配的按钮 · `--prompt <文字>` 写进文本框 · `--file <路径>` 塞给 `input[type=file]` · `--submit <文字>` 点提交 · `--wait <毫秒>`。
坑：同一个 `--user-data-dir` 第二次调用 `msedge --headless=new` 会静默失败，脚本每次用新的临时目录规避。

## 数据库迁移

```powershell
cd backend
.\.venv\Scripts\python.exe -m alembic revision -m "add xxx"
.\.venv\Scripts\python.exe -m alembic upgrade head
```

`alembic/env.py` 已配置 `render_as_batch=True`（SQLite 改表需要）。当前 head 为 `0003_workspace`（给 `generations` 加了 `negative_prompt/steps/cfg/sampler`，给 `images` 加了 `is_favorite`）。

## 代码约定

- 时间统一用 UTC（`utcnow()` 返回 tz-aware datetime），响应层补 `Z`。
- 校验错误抛 `GenerationValidationError`，由 API 层翻译成 `422`；不要在 service 里碰 HTTPException。
- 新增响应模型时继承 `backend/app/schemas/common.py` 的 `OrmModel`，否则 `model_validate(orm_row)` 会失败（`WorkflowRead` 踩过）。
- 前端所有数据访问都过 `lib/api.ts`，不要在组件里直接 `fetch`。
- 不要在 HTTP 端点里 await 生成任务。

## Git

仓库已初始化，`user.name=MiraForge Dev`、`user.email=dev@miraforge.local`。提交信息用短句祈使式（`Add …`、`Fix …`、`Wire …`）。

## 阶段验收方式

每阶段结束都要能**手动跑通**：启动前后端 → 打开页面 → 完成该阶段承诺的操作 → 检查 `data/app.db` 与 `storage/` 的实际产物。P2 起还要在 ComfyUI 自己的界面里核对同一个 prompt 的输出是否一致。
