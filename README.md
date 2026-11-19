# MiraForge

本地 AI 图片生成与编辑平台。浏览器 → Next.js → FastAPI → 单 GPU Worker → ComfyUI，生成结果落本地磁盘，元数据落 SQLite。

图片与视频都已可用（P1–P9 全部完成）：文生图、批量多图、参考图生成、图片编辑、MiniMax H3 文生视频 / 图生视频、多项目工作区、资产库批量管理，全部在本机真实跑通过。前端是「左窄导航 + 右工作区」的两栏布局，创作、资产、视频各占一个页面。

## 能做什么

- **首页**：默认落地页。两个大按钮直接进创作（生成图片 / 生成视频），旁边是本机设备、显存占用与当前项目；下面是最近作品、模型卡（每个可用模型一张）和六个灵感提示词（点一下就把提示词带进创作框）。「显存占用」右上角的圆钮可以随时让 ComfyUI 卸载模型腾显存——有任务在跑时自动禁用，避免打断生成。
- **工作台**：左侧 72px 图标导航（首页 / 资产 / 工具 / 回收站 ‖ 图片 / 视频 ‖ 设置），右侧一条完整创作链路——顶部筛选工具条、中间按「今天 / 昨天 / 更早」分组的作品流、底部悬浮创作框。没有第三栏、没有把参数平铺一屏。
- **局部编辑（遮罩）**：图片编辑的第 1 张图悬浮出「遮罩」按钮，在悬浮编辑器里用软边笔刷涂出要改的区域，涂完会多一个遮罩卡片（可重画、可删）。带遮罩提交就走 `image_inpaint`——只有涂到的地方重绘，其余像素保持原样（`VAEEncode + SetLatentNoiseMask`），1024² 上 turbo 约 10 s、标准版约 18 s。
- **回收站**：所有删除都只是打上删除时间、文件留在磁盘上，所以删错的图、删空的批次、清空的工作区都能在 **30 天内**从侧栏「回收站」里恢复；每件显示「还剩 N 天」，恢复时连所属任务与批次一起解冻。也可以单件「彻底删除」或一次性「清空回收站」，那才是真删文件；超过 30 天的条目由后端在启动和列表请求时自动清理，不需要定时任务。
- **批次命名**：作品流里每个批次的名字可以直接点着改（回车提交、Esc 还原），产物就叫「走路 3 秒 · 第 1 个」——视频首帧长得都一样，光看缩略图根本分不出是哪一条；名字只在读取时现算，改一次名字、删一张图都不用回写产物记录。从资产挑图/挑视频的弹层里显示的就是这个名字，视频鼠标移上去还会直接播放。
- **动作模板**：视频创作框下面一排提示词按钮（待机 / 走路 / 跑步 / 攻击 / 跳跃 / 下蹲 / 受伤 / 死亡 / 翻滚），一条就是给 2D 抽帧写好的完整提示词——严格侧视朝右、人物定点不位移、镜头不动、背景干净。点一下整段填进输入框，`⌘/Ctrl` 点击则追加。模板可以在设置页改名字、改提示词、删掉、加新的，或者一键恢复默认。
- **多项目**：每个项目一个独立文件夹（`data/projects/<id>/`，各自一套 SQLite 与图片目录），顶栏左侧的下拉可切换、新建、改名、删除；新建项目的入口就在下拉里。切换即换库，作品与任务各看各的。
- **资产库**：`/gallery` 一页看全部图片——响应式网格、按日期分组、按生成时间从新到旧，图片直接可收藏 / 下载 / 继续编辑 / 删除；点「管理」可勾选批量删除，或清空整个工作区（危险操作，二次确认；删掉的东西进回收站，30 天内可恢复）。
- **本地图片编辑器**：`/tools` 工具页里第一张卡，纯 CPU 跑（不占显存、不产生新作品、不改原图）。抠背景（只删边缘连通 / 删所有同色，可调容差、羽化与去杂点；主体内部被包住的同色块用「删所有同色」一并清掉）、按主体裁掉透明边、把画布指定成任意尺寸（如 256×256）、主体**等比**缩放并指定底边留白（如距底 20px）与水平偏移，导出 PNG（需要更大像素时用导出面板的 1× / 2× / 4× 倍率，别把主体拖大）。资产页与详情弹窗都有「本地编辑」直达入口，和调用 ComfyUI 的「AI 编辑」分开；成品可以「保存到资产」，在资产库里作为一条「本地编辑」记录出现，能收藏、下载、删除。
- **序列帧工坊**：`/tools/spriteforge`，原版 SpriteForge 就地改造后内嵌（序列帧预览、编辑轨道、多序列、分页导出全都在），不重写、不用 iframe。把视频拆成序列帧、抠掉纯色背景、按行列打包成透明图集并导出 PNG + JSON + ZIP，全程在浏览器里跑（不经过后端、不占显存）。**工具自己的「导入视频 / 导入图集」现在都会先问「从本机上传」还是「从资产选」**；从资产打开的那份图集在导出时会变成「保存并覆盖 #id」——改完就更新原来那条素材，只有新建的才新增一条。
- **抽帧台**：工具页第三张卡（`/tools/frames`），版式照剪辑软件——上面一块大画面就是帧预览（悬停时间轴逐帧看，默认裁到主体），紧接着是横向时间轴（选帧时不用滚动）。把一段视频按固定帧率抽成序列帧——帧率 / 起始秒 / 上限自选，可**抠背景**（四角取底色 + 容差），**按选中顺序**勾选要导出的帧（默认不选），再给一个**步进**（第 n 个选中帧自动偏移 (n−1)×步进，可留空），每帧还可以**逐帧微调**：弹出面板里把上一帧当洋葱皮叠着看，拖动画面或方向键挪，一直到人物在每帧都停在同一个位置（不抠背景时平移缺口用背景色填满）。导出画布**恒等于源帧尺寸**，导出成一个 ZIP 存成「帧集」资产。帧集在画廊里是一张卡、右上角标「N 帧」，点开能下载整包（`frames/0001.png…` + `frames.json` 记录每帧时间与偏移）。整包入库而不是每帧一条记录，70 多帧才不会把画廊冲垮。
- **文生图**：模型下拉（Qwen Image 2.1 25 步 / Qwen Image 2.1 Turbo 8 步 / Z-Image Turbo 8 步 / FLUX.2 Klein 4B Distilled 4 步 / FLUX.2 Klein 4B Base 20 步），10 种比例（含自定义）× 4 档分辨率（480/720/1K/2K，默认 1:1 · 1K），一次 1–8 张（默认 4 张），每张独立 seed、串行执行。三个新模型是纯数据接入（只加 JSON + YAML + registry 条目），参数按能力显示：Z-Image 与 Klein 蒸馏版只留采样器/尺寸，Klein 基础版多出步数、CFG 与负面提示词。
- **参考图生成（图生图）**：在「图片生成」里可选加 1–2 张参考图——有图就参考构图/材质出图，无图就是普通文生图；参考图不改变输出比例，尺寸仍按右下角的设置（实测同一句提示词，加参考图后画面构图明显跟随参考图）。
- **视频（MiniMax H3）**：独立 `/video` 工作台（左侧栏切换）。写一句镜头描述就是文生视频；首帧 / 尾帧可以直接从资产库里挑已生成的图（也能上传本机文件、拖入），给了就变成图生视频（两张都不给自动退回文生视频）。尺寸按「比例 × 480p / 720p / 1080p」选，时长 3 / 5 / 8 / 10 秒快捷档或 1–15 秒滑块自定，一次最多 4 条（默认 1 条，串行出），24fps、音视频一起出；卡片带时长与播放角标，详情里直接播放。
- **图片编辑**：上传或拖入参考图 + 一句修改指令（"改成夜晚"/"换成大理石雕像"），输出比例跟随参考图；**可以放两张**——第 1 张定结构、第 2 张可选（例如"把服装换成第二张图的样式"）；也能从作品流 hover「继续编辑」把整张图当参考图带回来。
- **作品流**：缩略图网格 / 列表两种视图，按提示词搜索、按模型与日期筛选、仅看收藏；hover 出查看大图 / 收藏 / 继续编辑 / 下载 / 删除。
- **大图详情**：图片 + 正面/负面提示词 + 模型 + Seed + 尺寸 + 生成时间 + 步数/CFG/采样器，可复制提示词与 Seed、下载、继续编辑、重新生成。
- **高级设置**：默认折叠，按模型能力动态显隐（Seed 随机/固定、步数、CFG、采样器、负面提示词）。
- **任务控制**：单任务取消（正在跑的那张会真的打断 ComfyUI）、失败/取消后重试（换新 seed）、后端重启后残留任务自动复位续跑。
- **实时进度**：WebSocket 推送 + 轮询双保险；还没出图的格子直接以占位卡排在最终位置——排队中显示「排队中」，生成中显示百分比与进度条，出图后原地替换。
- **系统状态**：从首页移到「设置」页（后端版本、SQLite 路径、ComfyUI 版本/连接/GPU/显存占用、存储路径），并提供「卸载模型 · 释放显存」按钮——切大模型或跑视频前腾显存用。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS 3 · TanStack Query 5 · Zustand 5 |
| 后端 | FastAPI · Pydantic v2 · SQLAlchemy 2 · Alembic · httpx · WebSocket |
| 存储 | 每个项目一套 SQLite（`data/projects/<id>/app.db`，WAL 模式）· 本地文件（`data/projects/<id>/storage/`） |
| 生成 | ComfyUI HTTP API（默认 `http://127.0.0.1:8188`），图片 Qwen Image 2.1 / Turbo、Z-Image Turbo、FLUX.2 Klein 4B Base / Distilled，视频 MiniMax H3（fl2va + 8 步 turbo LoRA） |

前端**永远不直连 ComfyUI**：所有生成请求由后端排队，Worker 串行提交，避免并发把 16 GB 显存打爆。

## 环境要求

- Windows + PowerShell 7
- Python 3.12（`C:\Program Files\Python312\python.exe`）+ [uv](https://docs.astral.sh/uv/)
- Node.js 24 + npm
- ComfyUI 已安装并能用 `run_nvidia_gpu.bat` 启动，且已有 Qwen Image 2.1 权重（可选：Z-Image-Turbo 与 FLUX.2 Klein 4B 的权重与工作流）

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

### 从局域网（手机 / 另一台电脑）打开

两个脚本默认都监听 `0.0.0.0`，所以同一网段直接访问 `http://<本机IP>:3000` 即可（例如 <http://10.236.134.52:3000>）。

前端在没配 `NEXT_PUBLIC_API_BASE_URL` 时，会按「当前页面的主机名 + 8000」推导后端地址，因此用 IP 打开时 API 也走同一个 IP，不需要改环境变量；后端的 CORS 只放行本机与私有网段。只想本机访问就加 `-Bind 127.0.0.1`。

Windows 防火墙首次运行会弹窗询问，选「允许」即可（Node 与 Python 的入站规则需要在「专用/公用」网络上都放行）。手机连不上时先确认：手机与电脑在同一网段、路由器没开「AP 隔离」。
> 为什么要起两个进程？因为前端是 Node/Next，后端是 Python/FastAPI，本来就是两个运行时。生产部署时通常由 Nginx 把 `/api` 反代到后端、其余给前端，开发期则是两个开发服务器各跑各的。`start.ps1` 只是把这两步合成一条命令。

检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/v1/health | ConvertTo-Json -Depth 5
```

## 目录

```
backend/            FastAPI 应用
  app/api/          HTTP 端点（health / models / workflows / generations / tasks / images / assets / recycle-bin / projects / editor）
  app/core/         配置、WebSocket 广播、Alembic 迁移入口
  app/models/       SQLAlchemy 模型（workflows / generations / generation_tasks / images）
  app/schemas/      Pydantic 响应与请求模型
  app/services/     注册表、生成记录、参数注入、ComfyUI 客户端、图片落盘
  app/workers/      generation_worker —— 串行消费任务、驱动 ComfyUI
  alembic/          迁移脚本
  workflow_configs/ registry.yaml（模型目录）+ 每个工作流的参数绑定 YAML
  workflows/        ComfyUI API 格式工作流 JSON
frontend/           Next.js 应用
  app/              page.tsx（首页）/ compose（图片创作）/ video（视频工作台）/ gallery（资产库）/ trash（回收站）/ tools（工具目录）/ tools/editor（本地图片编辑器）/ tools/spriteforge（序列帧工坊）/ settings（系统状态）
  components/       Sidebar · TopBar · ProjectSwitcher · Feed · FeedCard · ImageDetail
                    · Composer · VideoComposer · Popover · ConfirmDialog · ToastStack
                    · editor/EditorCanvas · editor/EditorPanel
  hooks/            useImageActions（收藏 / 下载 / 删除 / 继续编辑 / 重新生成，两个页面共用）
  stores/           composer（创作框状态）· reference（编辑参考图）· generationRefs（生成模式参考图）· editor（编辑器参数与撤销栈）
  lib/              api · size（比例与分辨率）· date（日期分组与筛选）· editor（几何与导出）· models（模型名显示）
  public/tools/spriteforge/ 原版 SpriteForge 的 Vendor 副本（index.html / app.js / tool.css），已就地改造，改动见同目录 README.md
storage/            旧布局的产物目录（首次启动后被搬进 data/projects/default/storage）
data/projects/      每个项目一个文件夹：<id>/app.db + <id>/storage/{images,videos,assets,thumbnails,uploads}
                    catalog.json 是项目清单
docs/               规格书、架构、API、工作流映射、前端、开发说明、环境检查报告
```

## 文档

- [项目规格书](docs/PROJECT.md)（最初的规格，可能落后于代码）
- [环境检查报告](docs/ENVIRONMENT_REPORT.md)
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
| P3 | 多图批量（1–8 张，独立 seed，串行）、比例 / 分辨率预设面板 | ✅ 完成 |
| P4 | 图片编辑（上传参考图，Qwen Image 2.1 Edit 真实出图） | ✅ 完成 |
| P5 | 前端画廊 / 历史 / 预览、缩略图、删除、用作参考图 | ✅ 完成 |
| P6 | 取消、重试、崩溃恢复、WebSocket 实时刷新 | ✅ 完成 |
| P7 | 前端重构为两栏创作工作台（作品流 / 创作框 / 详情弹窗 / 设置页），后端补生成参数落库、收藏与筛选 | ✅ 完成 |
| P8 | 参考图生成（图生图）：1–2 张参考图只参考构图、尺寸仍生效，独立工作流与绑定配置 | ✅ 完成 |
| P9 | 视频二期（MiniMax H3）：文生视频 / 图生视频（首帧 + 尾帧），独立 `/video` 工作台、音视频同出、封面帧与播放 | ✅ 完成 |
| P10 | 本地图片编辑器：`/tools` 工具页 + 抠背景 / 改画布 / 等比缩放 / 底边留白 / 导出 PNG（纯 CPU，不占显存） | ✅ 完成 |
| P11 | 多模型接入：Z-Image-Turbo、FLUX.2 Klein 4B Base / Distilled 三套文生图（纯数据接入，参数按能力显隐） | ✅ 完成 |

> 每个阶段结束时都必须能真实跑通并手动验证。一期（图片）与视频的生成（二期第一批）都已跑通；视频编辑、参考视频等留待后续。
> `POST /generations` 返回 `pending` 后由 Worker 接手：图片约 3–12 秒写进 `storage/images/`，视频约 30–160 秒写进 `storage/videos/`（`.mp4`，封面帧在 `thumbnails/`），都能通过 `GET /api/v1/images/{id}/file` 访问。
> 界面在 `http://127.0.0.1:3000`（`/` 首页、`/compose` 图片创作、`/video` 视频、`/gallery` 资产库、`/trash` 回收站、`/tools` 工具、`/settings` 系统状态）。
