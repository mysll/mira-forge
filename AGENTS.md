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
- `frontend/app/<screen>/page.tsx` per route, `components/` (Composer, VideoComposer, Feed/FeedCard, ImageDetail, MaskEditor, ImagePicker), `stores/` (zustand), `types/api.ts` mirrors backend schemas **by hand** — change both sides.
- Runtime state: `data/projects/<id>/{app.db,storage/}` (git-ignored), `data/projects/catalog.json` lists projects. `data/` also holds throwaway screenshots and probe scripts.
- Docs: `docs/{ARCHITECTURE,API,FRONTEND,WORKFLOW_MAPPING,DEVELOPMENT}.md`; `doc/PROJECT.md` is the original spec (may lag the code).

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

1. `cd backend; .\.venv\Scripts\python.exe -m pytest` — 165 tests, all green.
2. `cd frontend; npx tsc --noEmit`.
3. For UI work: `tools/screenshot.mjs` or an `tools/e2e_*.mjs` script, then look at the PNG in `data/`. DOM assertions belong in `--eval`/e2e scripts — `--eval` runs *before* the screenshot, so don't rely on it to wait for popups.
4. For generation changes: start the backend and submit through the API, then confirm the stored `comfy_prompt_id` / `/history` payload and the produced file. Do it in a throwaway project, delete it afterwards, and reactivate the user's project.
