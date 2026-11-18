# AGENTS.md

MiraForge — local AI image / video generation and editing. Browser → Next.js (app router) → FastAPI (`/api/v1`) → one serial worker → ComfyUI at `127.0.0.1:8188` → files on disk + one SQLite per project. Windows-only: PowerShell scripts and `D:\AI\...` paths everywhere.

## Commands

Backend commands run from `backend/`, frontend commands from `frontend/`.

| task | command |
| --- | --- |
| one-time setup | `.\setup.ps1` |
| everything | `.\start.ps1` (add `-StartComfyUI` to boot 8188 too) |
| backend only | `.\start-backend.ps1` → `0.0.0.0:8000` |
| frontend only | `.\start-frontend.ps1` → `0.0.0.0:3000` |
| stop by port | `.\stop.ps1` (add `-IncludeComfyUI`) |
| tests | `cd backend; .\.venv\Scripts\python.exe -m pytest` |
| one test file/case | `… -m pytest tests/test_inpaint.py -k mask` |
| typecheck | `cd frontend; npx tsc --noEmit` |
| headless UI check | `node tools\screenshot.mjs --url http://127.0.0.1:3000 --out data\ui.png --click "详情" --hover-selector "div.group\/batch" --wait 2500` |

- pytest **must** run from `backend/` (`pytest.ini` sets `pythonpath = .`). The suite (~8 s) forces `WORKER_ENABLED=false`, so it never touches ComfyUI.
- `pytest -q`'s summary line is swallowed by pwsh pipes — add `--junitxml ..\data\_junit.xml` and read counts from the XML when you need numbers.
- The venv was created `--without-pip`: install deps with `$env:UV_CACHE_DIR="$PWD\..\.cache\uv"; uv pip install --python .venv\Scripts\python.exe -r requirements.txt`.
- `npm install` / `npx` need a project-local cache: `$env:npm_config_cache="D:\AI\MiraForge\.npm-cache"` (AppData is not writable here).
- `next build` overwrites `.next` and makes a running `next dev` answer 500 — restart dev, or don't build while iterating.

## Layout

- `backend/app/{api,services,repositories,models,schemas,workers,core}` — routers stay thin; logic lives in `services/`. The worker is deliberately single-coroutine (one 16 GB GPU, serial jobs).
- `backend/workflows/*.json` (ComfyUI **API format**) + `backend/workflow_configs/*.yaml` (param bindings) + `registry.yaml` (the only model catalog; `GET /models` is generated from it and the `workflows` table resyncs at startup).
- `frontend/app/<screen>/page.tsx` per route, `components/` (Composer, VideoComposer, Feed/FeedCard, ImageDetail, MaskEditor, ImagePicker), `stores/` (zustand), `types/api.ts` mirrors backend schemas **by hand** — change both sides. Browser-side pixel work lives in `lib/` (`frames.ts` for the frame lab: extract/key/measure/align, `zip.ts` for packing a frame set).
- Runtime state: `data/projects/<id>/{app.db,storage/}` (git-ignored), `data/projects/catalog.json` lists projects. `data/` also holds throwaway screenshots and probe scripts.
- Docs: `docs/{PROJECT,ARCHITECTURE,API,FRONTEND,WORKFLOW_MAPPING,DEVELOPMENT,ENVIRONMENT_REPORT}.md`; `docs/PROJECT.md` is the original spec (may lag the code).

## How a request flows

1. The composer posts to `/api/v1/generations` (JSON for text-to-image, multipart for reference images / masks / first-last frames). `generation_service.create_generation()` resolves the workflow with `get_workflow_target(model, type)`, then writes **one `generation` + N `generation_tasks`** — one task per requested product, each with its own seed.
2. The worker loop (`backend/app/workers/generation_worker.py`) round-robins the projects, claims the oldest pending task, builds the graph with `prompt_builder.build_prompt()`, uploads reference/mask images to ComfyUI, submits, polls `/history`, downloads the outputs, writes `images` rows + files, and broadcasts task state on `ws://…/api/v1/ws/tasks`.
3. The frontend reads through react-query and `hooks/useTaskEvents` (websocket, with polling fallback) invalidates `["generations"]` / `["images"]` — so an API write usually needs no manual cache surgery, just `refresh()` after a mutation.

## Where to change what

| change | touch |
| --- | --- |
| new model / workflow | `workflow_configs/registry.yaml` + `workflows/*.json` + `workflow_configs/*.yaml` — **no Python** |
| new generation type | `GenerationType` enum, registry + JSON + YAML, `_build_plan()` in the worker, the route that accepts it, `types/api.ts`, composer, `ImageDetail` label chain, `app/trash` `TYPE_LABELS` |
| new endpoint | `app/api/<name>.py` and register in `app/api/__init__.py`; schema in `app/schemas/`; logic in `app/services/` (routers stay thin) |
| new column | model + `alembic/versions/00NN_*.py`, `down_revision` = current head (`0010_generation_name`); startup runs `alembic upgrade head` per project |
| new screen | `frontend/app/<route>/page.tsx` + a `Sidebar` entry (`components/Sidebar.tsx`) |
| frame set (video → PNG sequence) | `app/tools/frames/page.tsx` + `lib/frames.ts` + `lib/zip.ts`; backend `app/api/frames.py` + `generation_service.create_frame_set()` |

## Data model in one glance

- `generations` — one submitted batch: prompt, negative, model, `generation_type`, width/height, requested count, `name`, status, `deleted_at`.
- `generation_tasks` — one product slot each: seed, status, progress, `comfy_prompt_id`, error.
- `images` — the actual files: `media_type` ∈ `image | video | asset | frameset`, `file_path` (relative to the project's storage), thumbnail, favourite flag, `deleted_at`. A frame set is **one** row pointing at a ZIP under `storage/frames/` (never one row per frame).
- `generation_type` ∈ `text_to_image | image_to_image | image_edit | image_inpaint | text_to_video | image_to_video | local_edit | local_asset | local_frameset`.
- Each project owns its own SQLite + storage, and activating a project swaps the engine. Always get sessions from the `get_db` dependency / `active_project()`; never cache a session across projects.

Everything lives under `/api/v1`; errors are `{"detail": "…"}`; deletes that have nothing to return answer `204`.

## Rules that are easy to get wrong

**A new model is data, not code.** Add a workflow JSON + a binding YAML + a `registry.yaml` entry; `validated: true` only after a real run. If you find yourself editing Python to support one, something is misplaced.

**Never guess ComfyUI node ids or input names.** Read `GET /object_info` and, when in doubt, submit a job and inspect the prompt ComfyUI echoes back in `/history`. This machine is **not** bit-reproducible (same seed → different bytes), so comparing image hashes cannot prove a parameter took effect.

- `build_prompt` deep-copies the graph, writes only bindings whose param is present, and drops unused `LoadImage` nodes. A binding pointing at a non-existent input raises `PromptBuildError` — that error is the spec, not a nuisance.
- One param binds to one node. When a value must reach two nodes (e.g. width into both `Flux2Scheduler` and the latent), insert a `PrimitiveInt` and bind to it.
- `cfg = 1.0` silently disables the negative prompt (`comfy/samplers.py` drops `uncond`). Turbo Qwen uses a fixed 9-point `ManualSigmas` for steps; CFG (`CFGGuider.cfg`) and sampler (`KSamplerSelect`) are separate, real knobs.
- `TextEncodeQwenImage21`'s third output *is* the latent used for image edit; edit size follows the first reference image, not width/height.
- FLUX.2 needs `EmptyFlux2LatentImage` (128ch, /16). Video `length` must be `5 + 17k`.
- Model capability flags (`exposes_steps`, `exposes_cfg`, `exposes_negative_prompt`, …) come from `registry.yaml` and drive the composer UI — don't hardcode them in components.

**Deletion is soft.** Every list/detail query filters `deleted_at IS NULL` (images, generations, tasks); `/images/{id}/file` and `/thumbnail` intentionally do **not** filter so the recycle bin can preview. Hard deletes happen only in `services/recycle_service.py` (`delete_forever`, `clear_bin`, `purge_expired`).

- One task produces exactly one product: 4 images = 4 tasks with their own seeds.
- Batch names (`generations.name`) and product labels (`label_images()`) are computed on read — never stored per image.
- Image/thumbnail URLs must carry `?v=<created_at epoch>`; SQLite reuses ids after deletes and the browser will happily show the old picture.
- Backend timestamps are naive UTC strings; frontend must run them through `parseIso()` (appends `Z`) or dates shift by the local offset.
- `request<T>()` in `lib/api.ts` always parses JSON — 204 endpoints must use raw `fetch`.

**ComfyUI:** start it with `python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build` in `D:\AI\ComfyUI_Portable`; it dies with the session, so restart it after a restart. Inspect only over HTTP (`/object_info`, `/history`); never edit its configs or move models.

## Frontend gotchas

- `fixed` overlays rendered inside the composer end up positioned against it, because `backdrop-filter` creates a containing block → render them with `createPortal(…, document.body)`.
- Tailwind groups must be named (`group/card`, `group/batch`); an unnamed `group` ancestor makes every `group-hover:` child light up at once.
- Custom `wheel` zoom handlers must be attached with `{ passive: false }`; React's `onWheel` cannot `preventDefault` and the page scrolls too.
- Source files are LF (`.gitattributes`); rewriting one with CRLF churns the whole diff.

## PowerShell gotchas

- No heredocs. Write the message to a file and `git commit -F data\_commit_msg.txt`.
- Inside a double-quoted string `\"` collapses to a bare quote, which breaks JS passed to `screenshot.mjs --eval` — use single quotes inside selectors or `[...querySelectorAll('button')].find(...)`.
- Probe with Python or Node, not `Invoke-WebRequest` (SSL is broken on this box).

## Verification recipe

1. `cd backend; .\.venv\Scripts\python.exe -m pytest` — 175 tests, all green.
2. `cd frontend; npx tsc --noEmit`.
3. For UI work: `tools/screenshot.mjs` or an `tools/e2e_*.mjs` script, then look at the PNG in `data/`. DOM assertions belong in `--eval`/e2e scripts — `--eval` runs *before* the screenshot, so don't rely on it to wait for popups.
4. For generation changes: start the backend and submit through the API, then confirm the stored `comfy_prompt_id` / `/history` payload and the produced file. Do it in a throwaway project, delete it afterwards, and reactivate the user's project.
