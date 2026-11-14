# 开发说明

## 一次性初始化

```powershell
.\setup.ps1
```

做四件事：建 `backend\.venv`（用 `uv` 装依赖）、复制 `.env` 样板、跑 `alembic upgrade head`、前端 `npm install`。幂等，可重复执行。

## 日常启动

```powershell
.\start-backend.ps1          # http://127.0.0.1:8000/docs
.\start-backend.ps1 -Reload  # 改代码自动重载
.\start-frontend.ps1         # http://127.0.0.1:3000
```

## 测试

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest        # 13 项，约 3 秒
```

测试使用独立的临时库 `backend/.pytest-tmp/test.db`（在 `conftest.py` 里于 import app 之前设定 `DATABASE_URL`），**不会污染** `data/app.db`。

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
| `APP_HOST` / `APP_PORT` | `127.0.0.1` / `8000` | |
| `FRONTEND_ORIGIN` | `http://127.0.0.1:3000` | CORS 白名单 |
| `AUTO_MIGRATE` | `true` | 启动时自动 `alembic upgrade head` |

`frontend/.env.local`：`NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000/api/v1`。

`.env`、`.env.local`、`data/`、`storage/`、`*.db` 均在 `.gitignore` 中。

## 新增一个模型

不需要改 Python 代码，只改数据：

1. 在 `backend/workflow_configs/registry.yaml` 的 `models:` 下加条目（id / label / description / defaults / capabilities / workflows）。
2. 放两个工作流 JSON 到 `backend/workflows/`，路径与 `workflows[].json` 一致。
3. 重启后端（或刷新页面）——`/models` 每次请求都重读 YAML，`available` 由 JSON 是否存在决定。

新增工作流 JSON 的内容依据见 [WORKFLOW_MAPPING.md](WORKFLOW_MAPPING.md)，**不要凭印象填节点 ID**。

## 数据库迁移

```powershell
cd backend
.\.venv\Scripts\python.exe -m alembic revision -m "add xxx"
.\.venv\Scripts\python.exe -m alembic upgrade head
```

`alembic/env.py` 已配置 `render_as_batch=True`（SQLite 改表需要）。当前 head 为 `0001_initial`。

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
