# 交接：MiraForge 当前状态

> 这份文件写给「接手的人 / 下一个会话」：从哪儿跑起来、东西长什么样、哪些坑踩过。
> 规格书是 `doc/PROJECT.md`，架构与取舍看 `docs/ARCHITECTURE.md`，接口看 `docs/API.md`。

## 一句话
本地 AI 图片 / 视频生成与编辑平台：浏览器 → Next.js → FastAPI → 单协程 Worker → ComfyUI（本机 8188），产物落本机磁盘，一个项目一个 SQLite。

## 怎么跑起来
1. **ComfyUI**（必须先起，端口 8188）
   `D:\AI\ComfyUI_Portable\python_embeded\python.exe -s D:\AI\ComfyUI_Portable\ComfyUI\main.py --windows-standalone-build`
2. **后端**（8000）
   `cd D:\AI\MiraForge\backend; .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000`
   启动时会跑迁移（当前到 `0007_recycle_bin`）并同步 `workflows` 表。
3. **前端**（3000）
   `cd D:\AI\MiraForge\frontend; npm run dev -- -H 0.0.0.0 -p 3000`
   局域网访问用 `http://<本机 IP>:3000`（前端按 hostname 推导 API 地址）。
4. 自检：`GET http://127.0.0.1:8000/api/v1/health`（数据库 / ComfyUI / 存储三项都要 ok）。

依赖安装只能用 uv：
`uv pip install --python .venv\Scripts\python.exe -r requirements.txt`（需 `UV_CACHE_DIR=D:\AI\MiraForge\.cache\uv`）；
`npm` 需 `npm_config_cache=D:\AI\MiraForge\.npm-cache`。

## 现在有什么（P1–P11 + 工具链）
- **生成**：文生图 / 参考图生成（最多 2 张）/ 图片编辑（1–2 张参考图）/ **局部重绘**（在第 1 张编辑图上画遮罩，只改遮罩内）/ 文生视频 / 图生视频（首尾帧），一次 1–8 张图、1–4 条视频。
- **提示词模板**：视频创作框下方一排动作模板（走路 / 跑步 / 攻击 / 跳跃 / 下落 / 受伤 / 死亡 / 翻滚…），点一下写进提示词；设置页可增删改，也能一键恢复默认。
- **模型**（6 个，全在 `backend/workflow_configs/registry.yaml`，加模型只改数据）：`qwen_image_21`、`qwen_image_21_turbo`、`z_image_turbo`、`flux2_klein_distilled`、`flux2_klein_base`、`minimax_h3`；共 14 条工作流。
- **项目**：一个项目一个文件夹（`data/projects/<id>/{app.db,storage}`），左侧可切换 / 新建 / 删除。
- **资产库**：图片 / 视频 / 素材（精灵图）/ 序列帧，卡片左上角名称、右上角类型；支持收藏、下载、批量删除、一键清空。
- **回收站**：所有删除都是软删除（`deleted_at`），30 天内可恢复（恢复会连带解冻任务与批次），可单件彻底删除或清空；过期由启动和每次列表请求清理。
- **工具链**（`/tools`）：图片编辑器（抠背景 / 画布 / 超采样导出）、序列帧工坊（vendor 原版改造：导入视频或帧集、导出存资产）、抽帧台（视频 → 帧集：步进偏移 + 逐帧微调 + 洋葱皮 + 源尺寸导出）。

## 数据与接口要点
- 表：`generations`（一次提交）/ `generation_tasks`（一条任务，通常一件产物）/ `images`（`media_type` = image / video / asset / frameset）。
- `generation_type`：`text_to_image` / `image_to_image` / `image_edit` / `image_inpaint` / `local_edit` / `local_asset` / `local_frameset` / `text_to_video` / `image_to_video`。
- 图片 URL 一律带 `?v=<created_at epoch>`（SQLite 会复用 id，不带版本号会命中旧缓存）。
- 前端拿到的时间没有时区，必须 `parseIso()` 补 `Z`。
- 工作流 = JSON（API 格式）+ 同名 YAML（`output_node` / `bindings` / `reference_image` / `poster_node` / `frames`），`prompt_builder` 只按 YAML 落值，写错槽位会直接报「参数 X 的落点 Y 在工作中不存在」。

## 验证方式
- 后端：`cd backend; .\.venv\Scripts\python.exe -m pytest` → 当前 **181 passed**（约 9 s，`WORKER_ENABLED=false`，不会真提交 ComfyUI）。
- 前端：`cd frontend; npx tsc --noEmit` → 0。
- 界面：`node tools/screenshot.mjs --url http://127.0.0.1:3000/<路径> --out data/ui-xxx.png`，可加 `--click 文字` / `--click-selector CSS` / `--hover-selector CSS` / `--eval "JS"`（`--eval` 只跑一次，在 click 之后）。
- 真跑一单：`POST /api/v1/generations` 然后看 `GET /api/v1/generations/{id}` 与产物文件。

## 坑（踩过，别再踩）
- 改文件用编辑器工具，别用 PowerShell 批量 `-replace`：会转 CRLF、会拍平数组。
- 本机 ComfyUI **不可逐位复现**（同 seed 两次哈希不同），验证参数是否生效要读 `/history` 里的 prompt，不要比图片哈希。
- 负面提示词要 cfg > 1 才生效（turbo 默认 1.0，registry 里用 `negative_prompt_cfg` 自动抬）。
- 抽帧台 / 工坊的视频要先用 `fetch` 取成 `blob:` 再播放，直接当 `<video src>` 会跨源污染 canvas。
- 图片 / 视频跨端访问都用后端 8000，前端 3000 只做壳。

## 待办 / 可以接着做的
1. `批量改尺寸`、`九宫格切图` 两张工具卡还是占位（`frontend/app/tools/page.tsx` 里 `ready: false`）。
2. 局部重绘已接 Qwen 2.1、Qwen turbo 与 FLUX.2 Klein Base 三套；蒸馏版 Klein 没有配套 inpaint 图（要的话照 `flux2_klein_base_inpaint.json` 换权重与采样器即可）。
3. 视频二期剩余：时长上限放开、更多运镜模板、音频输出开关（当前音视频同出）。
4. 图片 / 视频「重新生成」现在都会回填参考图；遮罩故意不回填（画在旧构图上没意义），要复用得重新画。
