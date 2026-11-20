# 分层 Agent 设计（可行性分析 · 不动代码）

> 目标：在 MiraForge 里把「场景图 → 分层清单 → 逐层透明 PNG」这条人工流程自动化。
> 本文只做分析与设计，**没有任何代码改动**（这是本仓库唯一新增的文件）。
> 需求来源：`data/Qwen分层视差流程_会话总结.md` 复盘的七步流程。

---

## 1. 结论先行

**能做，但要把它定义成「半自动生产线」而不是「一键出成品」。** 拆成三件事分别判断：

| 子目标 | 可行性 | 卡点在哪 |
|---|---|---|
| ① 生成完一张场景图 → 自动建分层任务 → 排队跑完 | ✅ 完全可行 | 纯工程。MiraForge 已有「一个 generation = N 个 task，单协程串行」的骨架，分层批次只是把「N 个随机 seed」换成「N 个不同提示词」 |
| ② LLM 自动读懂画面、决定切几层 | ⚠️ 有条件可行 | 需要多模态模型；**但 LLM 报的像素坐标不可信**，必须「LLM 定语义分组 + 后端 PIL 实测坐标」。会话里那 7 层是人工用遮挡链+接地线+亮度剖面定了 3 轮才定下来的，坐标全部来自实测 |
| ③ 每层自动出「背景透明、遮挡处补全、不悬空」的图 | ⚠️ 部分可行 | 真正的瓶颈不是 LLM 而是 ComfyUI 端：**当前 edit 工作流的 `SaveImage` 只有 3 通道，没有 alpha**；「补全被遮挡区域」本质是生成任务，质量不可控 |

一句话：**调度可以全自动，判断只能半自动，出图必须留人工挑图。** 谁承诺「一键全自动出 7 层成品」，最后一定会交付一张悬空平台。

---

## 2. 现状盘点（我读代码确认过的事实）

| 事实 | 位置 | 对设计的影响 |
|---|---|---|
| worker 是单协程串行，一次一个 task，轮转项目 | `backend/app/workers/generation_worker.py`（620 行） | 天然适合「逐层串行渲染」，不用改调度；也意味着 LLM 长调用**绝不能塞进这个循环** |
| `GenerationTask` 只有 `seed/status/progress/...`，**没有 prompt 字段** | `backend/app/models/task.py:28-49` | 这是本需求最硬的约束：一层一条提示词，必须加列 |
| 一条 generation 只有一个 `prompt`，N 个 task 共用 | `backend/app/models/generation.py:54` + `generation_service.create_generation:144` | 同上 |
| 编辑类工作流 = 1 张参考图 + prompt + resolution，输出 `SaveImage`（节点 9） | `backend/workflows/qwen_image_21_edit.json:72`、`workflow_configs/qwen_image_21_edit.yaml:9` | 出的是 RGB PNG，alpha 要另想 |
| `store_image` 直接 `write_bytes`，不重新编码 | `backend/app/services/image_service.py` | 好消息：ComfyUI 要是真返回 RGBA，落库不会丢 alpha |
| 服务端已有纯色抠图 + 透明裁剪 | `backend/app/services/editor_service.py`：`remove_background / trim_transparent / dominant_background` | alpha 后处理的 P0 路线现成，纯 CPU |
| 没有任何 LLM / HTTP 大模型客户端；但 `httpx` 已是依赖 | `backend/requirements.txt` | 接 LLM 不需要新依赖，一个 client 就够 |
| 没有 `/object_info` 探测 | 全仓只用了 `/queue` `/interrupt` | 要判断「装没装 matting 节点」得新增一个 GET |
| 已有 `prompt_templates` 表 + `seed_defaults()` 种子模式 | `backend/app/models/prompt_template.py`、`services/prompt_template_service.py` | 六段式模板可以直接落库，设置页能改 |
| 已有工具页 + 详情页动作区 + 单 task 重试 | `frontend/app/tools/*`、`components/ImageDetail.tsx`、`api/tasks.py:69` | UI 落点和「单层重试」都不用从零做 |
| `_edit_resolution(w,h)` = √(w·h)/32 取整×32 | `generation_worker._edit_resolution` | **1920×1088 → resolution=1440**，出图只有约 1440 宽，不是原尺寸。要 1:1 必须显式把 resolution 顶到 1920 |

---

## 3. 目标架构

```
                    ┌──────────────────────────────────────────┐
用户口述关卡语义 ──► │  ① analyze（多模态 LLM，一次调用）        │
（"中央 Boss 场，   │     图 → {layers:[{key,name,role,bbox…}]} │
  右侧门要能开关"）  └───────────────┬──────────────────────────┘
                                    ▼
                    ┌──────────────────────────────────────────┐
                    │  ② measure（纯 Python/PIL，不调 LLM）     │
                    │     行亮度剖面 / 色彩掩膜 / 接地线 / bbox  │
                    │     → 修正 LLM 的坐标与层边界              │
                    └───────────────┬──────────────────────────┘
                                    ▼
                    ┌──────────────────────────────────────────┐
                    │  ③ prompt（模板渲染，LLM 只填内容词）      │
                    │     六段式【保留】【删除】【补全】【材质光照】│
                    │     【画面规格】【背景】+ Negative        │
                    └───────────────┬──────────────────────────┘
                                    ▼
                    ┌──────────────────────────────────────────┐
                    │  ④ plan → 用户在 UI 确认/微调层表         │
                    │     （这一步是人，不是模型）               │
                    └───────────────┬──────────────────────────┘
                                    ▼
        ┌───────────────────────────────────────────────────────┐
        │  ⑤ render：一个 IMAGE_EDIT generation，N 个 task       │
        │     每个 task 带自己的 prompt + 同一张原图作参考        │
        │     worker 逐层跑（已有串行队列，进度/取消/重试免费）   │
        └───────────────────────────┬───────────────────────────┘
                                    ▼
        ┌───────────────────────────────────────────────────────┐
        │  ⑥ alpha 后处理（在 worker 拿到字节后、存库前）        │
        │     chroma → editor_service.remove_background（已有）  │
        │     matte  → 工作流内 JoinImageWithAlpha（需装模型）    │
        │     passthrough → 工作流已输出 RGBA                    │
        │     + alpha_clean：透明区 RGB 清零 / 覆盖率指标        │
        └───────────────────────────┬───────────────────────────┘
                                    ▼
        ┌───────────────────────────────────────────────────────┐
        │  ⑦ verify + 挑图 + 导出                                │
        │     像素指标自检 → UI 里人眼过一遍 → ZIP + manifest.json│
        │     + Godot 用的 scroll/z/补边参数                     │
        └───────────────────────────────────────────────────────┘
```

**关键设计决定：LLM 只在 ①③ 出现，且①的输出被②无条件校正。** 会话的最强教训是「坐标必须实测」，所以 LLM 的 bbox 在数据结构里就叫 `draft_bbox`，落库前一定被 PIL 覆盖。

---

## 4. 五个新部件

### 4.1 LLM 接入层 `services/llm_client.py`

- **协议选 OpenAI 兼容 `/chat/completions`**：一套代码能接 DeepSeek / 通义 / Gemini(OpenAI 兼容层) / 本地 vLLM / Ollama，只换 `base_url` + `model`。用现成的 `httpx`，不引 SDK。
- 配置进 `core/config.py`（pydantic-settings，读 `backend/.env`）：
  ```ini
  LLM_ENABLED=true
  LLM_BASE_URL=https://api.deepseek.com/v1
  LLM_API_KEY=sk-...
  LLM_MODEL=deepseek-vl2        # 需要视觉
  LLM_TEXT_MODEL=deepseek-chat  # 可选：只写词的便宜模型
  LLM_TIMEOUT_SECONDS=90
  LLM_MAX_RETRIES=2
  ```
- 三个约束：① 图像先缩到长边 ≤1024 再转 data URI（1920 直传 token 翻倍、还容易超限）；② 强制 `response_format=json_object` + 本地 pydantic 校验 + 校验失败回灌错误重试一次；③ 所有调用记 `layer_sets.llm_meta`（模型、耗时、token），便于回看是哪次调用产生了坏层表。

### 4.2 分层 Agent `services/layer_agent.py`

四段式，**每段都能单独跑、单独测**：

| 段 | 输入 | 输出 | 谁在算 |
|---|---|---|---|
| `analyze` | 源图（缩略）+ 用户语义 brief + 引擎参数（视口/相机行程/是否可玩） | `spec.layers[]`：key / name / role / draft_bbox / 遮挡关系 / 材质描述 / 亮度区间猜测 / scroll 建议 | 视觉 LLM |
| `measure` | 源图 + draft_bbox | 每层 `bbox`（实测）、`ground_y`（接地线）、`fill_to_y`（向下补到哪行）、`luma_range`（实测亮度）、`overlap_px` | **纯 PIL/numpy**（会话里 `analyze.py` 的逻辑直接搬） |
| `prompt` | 实测层表 + 六段式模板 + 该层材质词 | 每层 1 条完整提示词 + Negative | 模板渲染为主，LLM 只填【保留】里的物件清单与材质词 |
| `review`（可选） | 出图后 | 一句「这层看起来缺了 X，建议重试时加 Y」 | 视觉 LLM，**只做提示词修补，不做几何判定** |

提示词模板不放代码里，放 `prompt_templates`（加一列 `kind: layer`，或新表）——设置页能改，改完不用重启。

**为什么不让 LLM 直接写整条提示词？** 会话里 9 条提示词的结构完全一致（六段式 + 4 条检查点 + 同一套 Negative），这是**格式确定性**，交给模板；LLM 一旦自由发挥就会漏【删除】段，而【删除】恰恰是掉图最多的一段。

### 4.3 数据模型（两张新表 + 一列）

```python
# app/models/layer.py
class LayerSet(Base):
    id, source_image_id (FK images), status   # draft|analyzing|planned|rendering|done|failed
    brief: Text                     # 用户口述的关卡语义
    spec_json: Text                 # 层表快照（含实测坐标），UI 编辑的就是它
    engine_json: Text               # 视口/相机行程/导出目标（决定 scroll 与补边）
    llm_meta: Text                  # 模型/耗时/token/重试次数
    generation_id: int | None       # 渲染用的那条 IMAGE_EDIT generation
    created_at, completed_at

class LayerItem(Base):
    id, set_id (FK), key ("L0"…"L6"), name, z_index, scroll_scale
    prompt, negative_prompt
    bbox_json, fill_to_y, ground_y, luma_range_json   # measure 的产物
    status                           # pending|running|done|failed|skipped
    task_id: int | None, image_id: int | None
    alpha_stats_json                 # 覆盖率/实心率/bbox/是否报警
    error_message

# app/models/task.py 新增两列
prompt: Mapped[str | None]
negative_prompt: Mapped[str | None]
```

**为什么不用「一个 generation 装整个分层批次」？** 因为 UI/回收站/作品流需要的是**渲染出来的 N 张图**，它们就该是普通 `images` 行；而层表、brief、实测坐标、alpha 指标这些「方案态」数据塞进 generation 会把语义搞浑。所以：`LayerSet` 管方案，`LayerSet.generation_id` 指向一条普通 `IMAGE_EDIT` generation（`count = len(items)`），每张图都是正常产物——**回收站、画廊、导出、ImagePicker 全部免费复用**。

**关键简化：不需要新增 `GenerationType`。** 每层渲染本来就是「原图 + 一条提示词 → 图片编辑」，就是 `IMAGE_EDIT`。worker 只需要认「task 自带提示词」：

```python
# generation_worker._build_plan 里的一行
prompt = task.prompt or generation.prompt
```

### 4.4 执行编排 `services/layer_service.py`

- `analyze` 是**异步后台任务**（`asyncio.create_task`，与 worker 同进程），接口立刻返回 `{id, status:"analyzing"}`，前端轮询/WS。理由：一次视觉调用 10–40 s，同步会顶爆 HTTP。
- 进程重启会丢后台协程 → 启动时把 `status='analyzing'` 的行重置回 `draft`（照抄现有 `reset_interrupted_tasks` 的做法）。
- `render` 接口：把 `LayerItem` 落成 `GenerationTask`（带 prompt），然后 `generation_service.create_generation` 的变体接管排队。**worker 一行调度逻辑都不用改。**
- 单层失败：沿用 task 级 FAILED + 现有 `POST /tasks/{id}/retry`，只需让 retry 复制 `task.prompt`。
- 取消：现有 `POST /tasks/{id}/cancel`；整批取消 = 把剩余 pending task 置 CANCELLED。

### 4.5 alpha 策略 `services/alpha_service.py`（**必须先做能力探测再选路线**）

三种策略，用一个配置项选，探测结果决定默认值：

| 策略 | 做法 | 依赖 | 质量 |
|---|---|---|---|
| `chroma`（P0 默认） | 提示词要求纯色/绿幕背景 → worker 拿到 PNG 后调 `editor_service.remove_background`（服务端已有，纯 CPU）→ alpha_clean 清 RGB | 无 | 硬边好，**发光/半透明边缘差**（正好是荧光花、门光晕这种） |
| `matte`（P2） | 工作流里加 `JoinImageWithAlpha`：`VAEDecode` + matting 节点（SAM2 / BiRefNet / RMBG）→ `SaveImage` | 需要 `D:\AI\Models\background_removal` 放模型（**现在是空的**）+ 新 JSON+YAML | 边缘好，但多一次模型推理，显存/时间上去 |
| `passthrough` | 工作流本身已能出 RGBA（用户说"已验证可以生成透明背景"很可能就是这条） | 取决于用户的节点链 | 最好，但 MiraForge 目前没有这条工作流 |

落库后统一跑「alpha_clean」这一步（会话里 `alpha_clean.py` 的逻辑）：透明区 RGB 清零、可选 erode/feather、打印覆盖率并对 `覆盖>98%` / `实心>99.5%` / `覆盖<0.3%` 报警。**报警进 UI，是人工挑图的第一道筛子。**

按 AGENTS.md 的规矩，`matte` 路线是「加数据不改代码」：新增 `workflows/qwen_image_21_edit_alpha.json` + `workflow_configs/*.yaml` + `registry.yaml` 里挂一个 `image_edit` 变体（用 `validated: false` 起步），零 Python。

---

## 5. 改动点清单（实施时照着做）

**后端**
- `core/config.py`：+6 个 LLM 字段、+2 个 alpha 字段
- `services/llm_client.py`（新）：`chat_json(messages, image=..., schema=...)`、重试、计时
- `services/layer_agent.py`（新）：analyze / measure / prompt / review 四段
- `services/measure_service.py`（新）：行剖面、色彩掩膜、bbox、接地线（移植会话里的 `analyze.py`）
- `services/alpha_service.py`（新）：三策略 + alpha_clean + 指标
- `services/layer_service.py`（新）：编排、建 generation、状态机
- `models/layer.py`（新）+ `alembic/versions/0011_layer_sets.py`
- `models/task.py`：+`prompt`、+`negative_prompt`
- `workers/generation_worker.py`：`_build_plan` 取 task 级 prompt；下载后插入 alpha 钩子；`_sync_generation_status` 后回写 `LayerItem.status/image_id`
- `api/layers.py`（新）：`POST /layers/analyze`、`POST /layers`、`GET /layers/{id}`、`PATCH /layers/{id}`（改层表）、`POST /layers/{id}/render`、`POST /layers/{id}/export`、`GET /layers/capabilities`（探测 matting 节点与模型）
- `api/__init__.py` 注册；`api/tasks.py` retry 复制 prompt

**工作流（数据，非代码）**
- 可选 `qwen_image_21_edit_alpha.json` + yaml + registry 条目（`matte` 路线才需要）

**前端**
- `app/tools/layerlab/page.tsx`（新）+ `components/layer/*`（层表编辑、逐层预览、alpha 指标条）
- `types/api.ts` + `lib/api.ts`（手写镜像，两边都要改）
- `components/ImageDetail.tsx`：「拆图层」按钮
- `app/tools/page.tsx`：工具卡（`ready: true`）
- `app/settings/page.tsx`：LLM 配置段 + 「测试连接」+ alpha 策略选择 + 隐私提示
- `components/Composer.tsx`：可选开关「生成后自动分层」（**默认关**，见 §7）

---

## 6. 六个真正的难点与对策

1. **一层一提示词 → task 没有 prompt 字段**
   加两列即可，worker 改一行。这是全项目最便宜也最必要的一处 schema 变更。
2. **1920×1088 会被压到 1440**
   `_edit_resolution` 按 √(w·h) 取整到 32：1920×1088 → **1440**。分层要 1:1 就必须在图层任务上把 `resolution` 顶到 1920（节点允许 ≤4096），代价是 2 倍 token、更慢、更吃显存。建议：默认 1440 出图 + 事后 Lanczos 放大并**对 alpha 用最近邻放大**（否则边缘出灰边）。
3. **LLM 坐标不可信**
   `draft_bbox` 只用来「圈定大致区域给 measure 收敛」，最终 bbox 一律由掩膜实测；UI 上让人能拖。
4. **补全质量不可控**
   不追求「一次就对」：每层默认出 2 张（复用 `count`），UI 并排挑；提示词里【补全】段强制写「补到 y=XXX」「必须有支撑」「绝不悬空」，配上 Negative 里的 `floating platform / cut off bottom`。still 需要人看一眼。
5. **GPU 时间**
   公式：`单张耗时 T × 每层张数 K × 层数 N`。7 层 × 2 张 × T。按 T≈30–60 s 估，一张场景图要 **7–14 分钟**纯 GPU。对策：① 分层用 turbo（8 步）而不是 25 步；② 默认 K=1、需要才加；③ 层数软上限 8、超过要确认；④ 队列里允许分层批次排到普通生成之后（低优先级）。
6. **每层独立采样 → 风格/颜色漂移**
   固定同一 seed 家族、同一 model/cfg/steps；后处理统一一次色阶（层叠加回去的颜色要能拼回原图）。可选做「拼合校验」：N 层叠起来 vs 原图的均值色差，超过阈值报警。

---

## 7. 产品判断：不要「每张图都自动分层」

用户的原话是「当生成了一张场景图时，自动执行分层流程」。我建议**改成显式动作**，理由：

- 分层把 1 张图的成本变成 7–14 张。作品流里 9/10 的图是废片，自动分层等于把 90% 的 GPU 烧在废片上。
- 分层只有在「这张图要进引擎」时才有意义，是个**决策**，不是副作用。

推荐三档触发，按侵入性排序：
1. **详情页按钮**「拆图层 →」（推荐主路径）
2. 工具页「分层工坊」，选图进来先看层表
3. Composer 里一个**默认关闭**的开关「生成后自动分层」——真想要"自动"的人自己开

---

## 8. 分阶段路线（每阶段可独立验收）

| 阶段 | 内容 | 工作量 | 验收标准 |
|---|---|---|---|
| **P0** 只读验证 | LLM client + 设置项 + `POST /layers/analyze`（传图，返回 JSON 层表，不落任务不排队） | 1–2 天 | 拿会话里那张 00118 跑，能得到与人工一致的 6–7 层语义分组（key/name/遮挡关系对得上，坐标允许偏） |
| **P1** 最小闭环 | `layer_sets/layer_items` + task prompt 列 + `chroma` alpha + 工具页（选图→层表→渲染→逐层预览→导出 ZIP） | 2–3 天 | 一张图跑完 6 层，每层 PNG 有 alpha、与原图逐像素对齐、`alpha_stats` 有值；单层失败能单独重试 |
| **P2** 质量 | `matte` 工作流 + alpha_clean 指标进 UI + 自动校验/自动重试一次 + 挑图并排 | 2–3 天 | 发光边缘不糊、覆盖率超阈值自动重试生效 |
| **P3** 落地 | `manifest.json` + Godot 参数（scroll/z/补边）+ ImageDetail 入口 + 可选 Composer 开关 + 导出 `.tres` | 1–2 天 | 导出物直接能塞进 Godot 场景，加引擎后左右推相机不露缝 |

**P0 就能回答"这件事值不值得做"**：如果 LLM 连层表都分不对（很可能，尤其是"相位门要能开关"这种玩法语义），那 P1 之后全是白干——所以先只做 P0。

---

## 9. 明确不做（以免返工）

- **不做层间依赖链**（L1 用 L0 的输出继续改）：会话的硬规则是「一层一图、永远用原图」，依赖链只会累积误差。
- **不让 LLM 做几何验收**（"这层补得对不对"）：视觉模型对像素级位置判断很差，几何一律用指标 + 人眼。
- **不做全自动无人值守**：补全错、接地错、悬空，必须有人过一遍才进引擎。
- **不做「任意图都能分层」的承诺**：分层前提是「有明确纵深与遮挡关系」的场景图；角色立绘、平涂插画、UI 图里根本没有可分的层。

---

## 10. 需要你确认的 4 件事（决定 P0/P1 的具体形态）

1. **alpha 到底怎么来？** 你说"已验证可以生成透明背景"——那是 ComfyUI 里哪条链路？是模型直接出 RGBA、还是绿幕+抠图、还是接了 SAM2/BiRefNet 节点？这决定 P1 走 `chroma` 还是直接 `passthrough`。
2. **用哪个 LLM？** 有没有可用的视觉模型 API Key（DeepSeek-VL / 通义 / Gemini / 本地 vLLM）？没有视觉模型的话，方案退化成「人给分组 + LLM 写提示词」，仍然有用但 P0 的价值减半。
3. **自动触发还是手动？** 我建议手动（§7），确认一下你是不是真的想要「每张场景图自动分层」。
4. **层数上限与出图张数**：默认 6 层、每层 1 张、turbo 8 步，这样一张图约 3–6 分钟；你要是能接受 15 分钟，就可以 25 步 + 每层 4 张挑。
