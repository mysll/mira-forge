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
- **生成**：文生图 / 参考图生成（最多 2 张）/ 图片编辑（1–2 张参考图）/ 文生视频 / 图生视频（首尾帧），一次 1–8 张图、1–4 条视频。
- **模型**（6 个，全在 `backend/workflow_configs/registry.yaml`，加模型只改数据）：`qwen_image_21`、`qwen_image_21_turbo`、`z_image_turbo`、`flux2_klein_distilled`、`flux2_klein_base`、`minimax_h3`；共 11 条工作流。
- **项目**：一个项目一个文件夹（`data/projects/<id>/{app.db,storage}`），左侧可切换 / 新建 / 删除。
- **资产库**：图片 / 视频 / 素材（精灵图）/ 序列帧，卡片左上角名称、右上角类型；支持收藏、下载、批量删除、一键清空。
- **回收站**：所有删除都是软删除（`deleted_at`），30 天内可恢复（恢复会连带解冻任务与批次），可单件彻底删除或清空；过期由启动和每次列表请求清理。
- **工具链**（`/tools`）：图片编辑器（抠背景 / 画布 / 超采样导出）、序列帧工坊（vendor 原版改造：导入视频或帧集、导出存资产）、抽帧台（视频 → 帧集：步进偏移 + 逐帧微调 + 洋葱皮 + 源尺寸导出）。

## 数据与接口要点
- 表：`generations`（一次提交）/ `generation_tasks`（一条任务，通常一件产物）/ `images`（`media_type` = image / video / asset / frameset）。
- `generation_type`：`text_to_image` / `image_to_image` / `image_edit` / `local_edit` / `local_asset` / `local_frameset` / `text_to_video` / `image_to_video`。
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
1. **遮罩局部重绘（已调研，待拍板）**：`SetLatentNoiseMask` + `VAEEncode` 已验证能让 Qwen 2.1 只改掩码内（掩码外 p99 差异 3/255），Klein 也有现成链路；缺的是前端**遮罩编辑器**（画笔 / 橡皮 / 清空 / 羽化），后端要加 `mask_image_path` 与一套 `*_inpaint.json`。
2. `批量改尺寸`、`九宫格切图` 两张工具卡还是占位（`ready: false`）。
3. 图片侧的「重新生成」只回填提示词 / 模型 / 尺寸，没有像视频那样把参考图取回来。
4. 视频二期剩余：时长上限、更多运镜模板、音频输出开关（当前音视频同出）。
