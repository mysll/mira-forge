# 场景模块 + 分层流程 规划文档

> 状态：**规划，未开发**。本文是第二版设计，替代 `docs/LAYER_AGENT_PLAN.md` 里「详情页按钮 / Composer 开关」那套方案。
> 依据：用户 2026-11-19 的需求澄清——不做「生成完自动分层」，而是新增**场景**一级模块，场景内先出成品场景图，再对选中的那张图执行分层；分层有自己的输入框（选图/选模型/层数/每层张数/提示词），提示词连同系统分层规范一起交给 LLM。
> 同日补充澄清（本版已并入）：**透明不做特殊处理**。手动流程是「图片编辑 → 粘 LLM 提示词 → 参考图选场景图 → 生成」，本模块只把这个手动动作批量化，出图能力与原样一致；alpha 属于模型/工作流侧问题，不进本方案范围。

---

## 1. 需求重述（把口头需求写成验收条款）

| # | 需求 | 验收方式 |
|---|---|---|
| R1 | 顶部导航新增「场景」，与「图片」「视频」并列 | 侧边栏出现第三项，路由 `/scenes` |
| R2 | 场景之间做资源隔离：新建「入口场景」时创建独立子目录 | `storage/scenes/<id>/` 存在；场景页只看得到本场景的产物 |
| R3 | 场景内先生成完整场景图（与现在文生图一样的体验，生成到满意为止） | 场景详情页有生成框，产物落在本场景目录与场景页 |
| R4 | 选中一张满意的场景图后，才进入分层流程 | 分层输入框必填「源图」，只列本场景已完成的图 |
| R5 | 分层输入框：选源图、选模型、指定层数、每层张数、填提示词 | 见 §5 字段表 |
| R6 | 提示词 = 创作者需求 + 系统分层规范，一起提交给 LLM | 一次 LLM 调用产出 N 条层提示词，可在 UI 预览/改 |
| R7 | 按层排队生成，每层可出多张（与单层批次的挑选体验一致） | 一层 = 一个批次，N 张；层间串行，进度按层显示 |
| R8 | 透明：**不做特殊处理**，分层出图就是「图片编辑」的批量版，模型输出什么就存什么 | 产物与手动做一次图片编辑完全一致；不引入 alpha 后处理、不接 matting、不新增工作流 |

---

## 2. 这一版相对上一版的三处简化（重要）

读代码后确认，用户这个流程反而让实现**更简单**：

**① 不需要给 `generation_tasks` 加 prompt 列。**
因为「一层」本身就是一个批次：N 层 = N 条 `generation`，每条 generation 的 `prompt` 就是该层的提示词，`count` 就是「每层几张」。现有模型 `generation → tasks[]` 天然表达「一层出 K 张」，批内挑图、批次命名（`label_images()`）、回收站、画廊、ImagePicker 全部免费复用。

**② 不需要新增 `GenerationType`。**
每层渲染就是「原图 + 一条提示词 → 图片编辑」，即 `IMAGE_EDIT`。registry 里 `qwen_image_21_edit` / `qwen_image_21_turbo_edit` 已经是 `validated` 的。
> 上一版担心「task 没有 prompt」，在「一层一批」的划分下这个问题自动消失——这是本次需求澄清带来的最大收益。

**③ 分层队列天然「按层排队」。**
`LayerSet` 依次创建 L0、L1…L5 六条 generation，worker 的单协程 FIFO 会一层一层跑完。不需要任何优先级或调度改造，进度读 `completed_tasks / total_tasks`。

---

## 3. 信息架构

```
侧边栏：首页 / 资产 / ┃ 图片 · 视频 · 场景 / 工具 / 回收站 / 设置
                                        ↑ 新增，路由 /scenes
```

```
/scenes                     场景列表
   ├ 卡片：封面、名称、场景图数、层套数、最近更新
   ├ 「新建场景」→ 命名（"入口场景"）→ 建表行 + 建目录
   └ 点击进入 → /scenes/[id]

/scenes/[id]                场景详情（三段式）
   ┌ ① 场景图区  ───────────────────────────────┐
   │  生成框（复用现有 Composer 的文生图形态，    │
   │  只是落地到本场景）+ 场景图瀑布流 + 选中态    │
   └─────────────────────────────────────────────┘
   ┌ ② 分层区  ─────────────────────────────────┐
   │  分层输入框（§5）                            │
   │  └ 提交后：层表卡片（N 层，可编辑/可删）      │
   │     每层展开 = 该层 K 张图 + 进度 + 重跑      │
   └─────────────────────────────────────────────┘
   ┌ ③ 导出区  ─────────────────────────────────┐
   │  选中层套 → 导出 ZIP（PNG + manifest.json）   │
   │  manifest 含 scroll_scale / z_index / 补边    │
   └─────────────────────────────────────────────┘
```

**「图片」模块完全不受影响**：场景产物是**独立的生成类型** `scene`（分层图是 `scene_layer`），
`/compose` 的 `media=image` 查询天然不含这两种类型，所以隔离不用额外补过滤条件；
首页最近作品用 `exclude_scene=true` 排除，资产页则新增「场景 / 场景分层」两个筛选项，
点卡片直接跳回 `/scenes/<id>`。

---

## 4. 数据模型

```sql
-- 新表：场景
CREATE TABLE scenes (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,            -- "入口场景"
  description   TEXT,                     -- 给 LLM 的关卡语义：中央 Boss 场 / 右侧门要能开关
  cover_image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
  sort_order    INTEGER DEFAULT 0,
  created_at    DATETIME NOT NULL,
  deleted_at    DATETIME                  -- 软删，跟随现有回收站语义
);

-- 新表：一次分层任务
CREATE TABLE layer_sets (
  id              INTEGER PRIMARY KEY,
  scene_id        INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  source_image_id INTEGER NOT NULL REFERENCES images(id),   -- 选中的那张场景图
  model_name      TEXT NOT NULL,          -- 用于逐层编辑的模型
  layer_count     INTEGER NOT NULL,       -- 用户指定，或 LLM 决定后的实际值
  count_per_layer INTEGER NOT NULL,       -- 每层几张
  brief           TEXT,                   -- 创作者的提示词（原样保留，便于重跑）
  spec_json       TEXT,                   -- LLM 原始输出快照（含被丢弃的候选层、重试次数）
  llm_meta        TEXT,                   -- base_url 摘要/model/耗时/token/是否重试
  status          TEXT NOT NULL,          -- analyzing|planned|rendering|done|partial|failed|cancelled
  engine_json     TEXT,                   -- 视口/相机行程，用于算 scroll 与补边（导出用）
  created_at      DATETIME NOT NULL,
  completed_at    DATETIME
);

-- 新表：一层
CREATE TABLE layers (
  id              INTEGER PRIMARY KEY,
  set_id          INTEGER NOT NULL REFERENCES layer_sets(id) ON DELETE CASCADE,
  ord             INTEGER NOT NULL,       -- 0..N-1，渲染顺序 = 由远到近
  key             TEXT NOT NULL,          -- "L0"
  name            TEXT NOT NULL,          -- "远景壳体"
  role            TEXT,                   -- 语义角色，给 LLM 与验收用
  scroll_scale    REAL,                   -- 0.10
  z_index         INTEGER,
  prompt          TEXT NOT NULL,          -- 复制到 generation.prompt
  negative_prompt TEXT,
  generation_id   INTEGER REFERENCES generations(id) ON DELETE SET NULL,
  status          TEXT NOT NULL,          -- pending|running|done|failed|skipped
  note            TEXT
);

-- 现有表加一列（可空，历史数据一律 NULL，行为不变）
ALTER TABLE generations ADD COLUMN scene_id INTEGER REFERENCES scenes(id);
ALTER TABLE images      ADD COLUMN scene_id INTEGER REFERENCES scenes(id);
```

迁移脚本：`backend/alembic/versions/0011_scenes_layers.py`，`down_revision = 0010_generation_name`。

**为什么 `scene_id` 同时冗余在 images 上？** 因为场景页要「按场景列图」且要能按场景过滤时不 join 两张表；写图时从 generation 带下来即可。

**类型取值（已落地）**：`generations.generation_type` 与 `images.media_type` 各多两个值——
`scene`（场景底图，场景页里提交的批次一律归这一种）与 `scene_layer`（分层图）。
它们不是新工作流：`scene` / `scene_layer` 按「有没有参考图」落到 `text_to_image` /
`image_edit`（带遮罩则 `image_inpaint`），registry 不需要额外条目。

---

## 5. 分层输入框（字段表）

一个独立的表单，形态与现有 Composer 一致（左输入右参数），但挂在场景详情页里：

| 字段 | 控件 | 默认 | 说明 |
|---|---|---|---|
| 源图 | 缩略图选择器（只列本场景已完成图） | 当前选中的场景图 | 必填；决定 LLM 看哪张、每个编辑任务的参考图 |
| 模型 | 下拉（只列 registry 里支持 `image_edit` 的） | 场景图同款 / turbo | turbo 8 步能省 4–6 分钟 |
| 层数 | 数字 2–8 + 「自动判断」勾选 | 自动 | 指定时 LLM 必须输出恰好 N 层，否则重试 |
| 每层张数 | 1–4 | 1 | 全层共用；预算够就 2（一层挑一张） |
| 提示词 | 多行文本 | 场景的 description 预填 | 创作者需求：「中央是 Boss 战场，右侧紫门是能力门要能开关…」 |
| 负向提示词 | 折叠 | 空 | 一般留空，系统 Negative 会叠加 |
| 高级 | 折叠：steps/cfg/sampler/seed | 模型默认 | 与现有 Composer 一致 |
| 提交 | 按钮 | 「分析分层 →」 | 第一阶段只出层表，不烧 GPU |

**两段式提交（推荐）**：
1. 点「分析分层」→ LLM 返回 N 张层卡（key/名称/角色/scroll/完整提示词），可改名称与提示词、可删层。
2. 点「开始生成」→ 按层创建 generation，排队渲染。可在设置里勾选「分析完直接开跑」跳过第 2 步。

理由：一次 6 层 × 2 张 = 12 次采样，错了就是 8 分钟 GPU。层卡确认的成本远低于重跑。

---

## 6. LLM 调用设计

**输入（一次调用）**
1. 源图缩略（长边 ≤1024，JPEG q85，data URI）+ 实测元信息（宽高、行亮度剖面摘要、主要色彩区域 bbox）
2. 「创作者需求」原文
3. 「系统分层规范」——从 `prompt_templates` 里取（新 `kind='layer_spec'`），内容来自我们那份 10 章文档的第 1/2/3 章：三类证据（遮挡链/接地线/空气透视）、六段式结构、scroll 语义（地面=1.0）、补全与重叠规则、通用 Negative
4. 引擎参数（视口 1600×900、相机行程 ±118、是否可玩）

**输出（JSON schema，强约束）**
```json
{
  "layers": [
    {"key":"L0","name":"远景壳体","role":"background",
     "scroll_scale":0.10,"z_index":-60,
     "occluded_by":[], "supports":["L1","L2"],
     "prompt":"【保留】…【删除】…【补全】…【材质与光照】…【画面规格】…【背景】…",
     "negative_prompt":"…"}
  ]
}
```
- 校验：层数等于用户指定值（若指定）；`prompt` 必须含 6 个 `【】` 段；`scroll_scale` 落在 0.05–1.3；第 0 层允许不透明。
- 失败处理：把校验错误回灌重试 1 次；仍失败 → `status=failed` + 原始输出进 `spec_json`，UI 展示「LLM 输出不合法」并给「手动补一层」入口。
- **坐标一律不进 LLM 输出**：只有语义分组和系数。实测坐标（bbox/接地线/补到哪行）由后端 PIL 计算后写进 `layers.note`，作为导出与验收依据（延续上一版结论：LLM 的像素坐标不可信）。

**配置**（`core/config.py` + `backend/.env`）
```ini
LLM_ENABLED=true
LLM_BASE_URL=https://api.deepseek.com/v1   # OpenAI 兼容即可，换供应商只改这里
LLM_API_KEY=sk-...
LLM_MODEL=deepseek-vl2
LLM_TIMEOUT_SECONDS=90
```
视觉调用在**后台协程**里跑（`asyncio.create_task`），接口立刻返回 `status=analyzing`，前端轮询/WS。进程重启时把 `analyzing` 的行重置为 `planned` 之前的状态（照抄 `reset_interrupted_tasks` 的做法）。

---

## 7. 执行与状态机

```
                    ┌──────────┐  LLM 返回合法层表
  提交分层请求 ────► │ analyzing │ ──────────────► planned ──► [用户确认/改层卡]
                    └──────────┘                                   │
                              LLM 失败/超时                          ▼
                                    └──► failed              rendering（逐层建 generation）
                                                                     │
                                              done / partial ◄───────┘
```

- `rendering`：按 `layers.ord` 顺序建 generation（每条 `count=count_per_layer`，`prompt=layers.prompt`，`reference_image_paths=[源图]`，`scene_id` 一并写入）。**一条一条建**，而不是一次性建满，好处是前一层跑完才建下一层，队列里不会堆 6 条待跑批次。
- 单层失败不阻塞后续（沿用 task 级 FAILED）；`layers.status` 单独维护，全部跑完算 `done`/`partial`。
- 重跑单层：复用现有 `POST /api/v1/tasks/{id}/retry` 语义，或直接重建一条 generation。
- 取消：整张层套取消 = 把当前 generation 的 pending task 置 CANCELLED 并停止建后续层。

**成本**：`LLM 1 次 + N × K × T`。N=6、K=2、T≈40s → 约 8 分钟；turbo 8 步约 3–4 分钟。

---

## 8. 存储布局

```
data/projects/<pid>/storage/
├── images/<gid>/<tid>_<i>.png              # 现有：不属于任何场景的图（不变）
├── videos/...
└── scenes/<sid>/
    ├── cover.png                           # 场景封面（可从场景图里挑，复制）
    ├── images/<gid>/<tid>_<i>.png          # 场景内的图（场景图 + 每层每张）
    └── exports/<ts>.zip                    # 导出包
```

实现方式：`store_image()` 已有 `storage_root` 参数，但**不要改 root**（DB 里 `file_path` 是相对项目 storage 的，换 root 会导致 `/images/{id}/file` 找不到文件）。正确做法是给 `store_image` 加一个 `folder_prefix` 形参，让 `file_path` 变成 `scenes/<sid>/images/<gid>/<tid>_<i>.png`——`images.py:96` 的 FileResponse 直接 `${storage}/${file_path}`，**零改动**。

---

## 9. 透明：不做特殊处理（原 P3 取消）

用户在 2026-11-19 澄清了手动流程：**打开图片编辑 → 把 LLM 给的提示词粘进去 → 参考图选场景图 → 点生成**。本模块唯一新增的事，是把「粘提示词」这一步自动化。所以：

- 每层渲染 = 一次 `IMAGE_EDIT`，与手动路径**同一条工作流、同一套参数**；模型给什么就存什么。
- `qwen_image_21_edit.json` 的 `VAEDecode` → `SaveImage` 是 3 通道，产物大概率是 RGB —— 这是**现状的已知行为，不是本模块的缺陷**，手动流程今天的输出也是它。
- 若将来确认某条编辑链路能出 RGBA：`image_service.store_image()` 是 `write_bytes` 直写、不重编码，**alpha 不会丢**；届时只需把 registry 里 `image_edit` 指到那条工作流（纯数据改动），模块代码不动。
- 因此本方案**不接 matting、不加 alpha 质检、不新增工作流、不设「透明」阶段**。真需要 alpha 时，那是「模型/工作流」侧的事，与分层流程解耦。

---

## 10. 改动清单（实施时照此执行，本文不写代码）

**后端**
- `models/scene.py`、`models/layer.py`（新）
- `models/generation.py` / `models/image.py`：+`scene_id`
- `alembic/versions/0011_scenes_layers.py`
- `services/scene_service.py`（新）：CRUD、目录创建、封面、导出打包
- `services/layer_service.py`（新）：analyze 编排、层卡 CRUD、按层建 generation、状态聚合
- `services/measure_service.py`（新）：行剖面/色彩掩膜/bbox/接地线（移植会话 `analyze.py`）
- `services/llm_client.py`（新）+ `core/config.py` 配置项
- `api/scenes.py`、`api/layers.py`（新）+ `api/__init__.py` 注册
- `services/image_service.store_image()`：+`folder_prefix`
- `services/generation_service.create_generation()`：接受并落 `scene_id`
- `api/images.py` 列表：+`scene_id` 过滤参数
- `prompt_templates`：新增 `kind` 列 + 种子「系统分层规范」

**工作流（数据）**
- 无。分层复用现有 `qwen_image_21_edit` / `qwen_image_21_turbo_edit`，不改 registry。

**前端**
- `app/scenes/page.tsx`、`app/scenes/[id]/page.tsx`（新）
- `components/scene/SceneComposer.tsx`、`LayerComposer.tsx`、`LayerCard.tsx`、`SceneGrid.tsx`（新）
- `components/Sidebar.tsx`：+「场景」
- `components/ImagePicker.tsx`：+`sceneId` 过滤
- `types/api.ts` + `lib/api.ts`（手写镜像，两边都要改）
- `app/settings/page.tsx`：LLM 配置段 + 「测试连接」+ 隐私提示

---

## 11. 分阶段（每阶段独立可验收）

| 阶段 | 内容 | 工作量 | 验收 |
|---|---|---|---|
| **P0 场景骨架** | `scenes` 表 + 目录 + 列表页 + 详情页 + 场景内文生图（复用 Composer，落 `scene_id`）+ 侧边栏 | 1.5–2 天 | 新建「入口场景」→ 目录出现 → 在里面出图 → 图只出现在该场景；「图片」模块行为不变 |
| **P1 分层方案（不烧 GPU）** | LLM client + 配置 + 「系统分层规范」模板 + `/layer-sets` 分析接口 + 层卡 UI（可改可删） | 2 天 | 选一张场景图 + 一段需求 → 得到 N 张层卡，提示词六段齐全；改完能保存 |
| **P2 渲染闭环** | 按层建 generation + 层进度 + 单层重跑 + 取消 | 2 天 | 6 层 × 2 张跑完，一层一个批次，进度按层显示；中途取消能停 |
| **P3 收尾（可选）** | 层级批次的挑图/重跑细节打磨、导出 ZIP + manifest（scroll/z/补边，给 Godot 用） | 1–2 天 | 一次导出拿到全套层图 + 元数据 |
| P4（可选） | 场景图 ↔ 层套的对照预览、层叠合成自检、批量导出多套 | 1–2 天 | — |

**P0 与 LLM 完全解耦**，即使 LLM 选型没定也能先做，而且立刻能用（场景图生成本身就有价值）。
**P2 之后就已经完成用户描述的全部流程**——P3/P4 只是把「一堆层图」变成「能直接给引擎用的一包东西」，可以按需再定。

---

## 12. 风险清单

| 风险 | 影响 | 对策 |
|---|---|---|
| LLM 分层不合剧情（把可开关的门并进平台） | 整层套废掉 | 层卡确认步骤 + 创作者需求里明确玩法；`description` 字段预填 |
| 6 层 × 2 张的 GPU 时间 | 一次 8 分钟，用户以为卡住 | 层卡上显示预估时间；进度按层显示；可取消 |
| 1920 被压成 1440（`_edit_resolution`） | 分层图比场景图小，叠不回去 | 场景与层统一走同一 resolution；或显式把 resolution 顶到 1920 |
| 每层独立采样导致风格漂移 | 叠起来颜色/结构不接 | 固定模型/步数/CFG，seed 家族相关；导出前做一次「层叠 vs 原图」色差自检 |
| 场景删除的语义 | 资源孤儿 / 误删 | 软删场景 + 其下 generation/image 一并 `deleted_at`；回收站恢复时按 `scene_id` 还原归属 |
| 场景多起来后列表变慢 | — | 场景列表只查聚合计数，图走分页 |

---

## 13. 需要你确认的 3 件事

1. **层数上限**：2–8 够不够？「自动判断」允许 LLM 返回几层（我建议上限 8）。
2. **提交后是「先看层卡再开跑」还是「分析完直接跑」？** 我建议默认前者、设置里可切后者。
3. **场景删除**：进回收站（软删，30 天可恢复）还是直接删目录？我建议软删，与现有语义一致。

这三个都不影响 P0 开工——P0 是场景骨架，先把「场景隔离 + 场景内生图」立起来。

---

## 14. 落地进度（实施记录，随代码更新）

**P0 已完成**（2026-11-19）：
- `scenes` 表 + `storage/scenes/<id>/images/` 目录隔离；场景产出走独立生成类型 `scene` / `scene_layer`，`/compose` 与首页最近作品天然不含（`exclude_scene`），资产页可按「场景 / 场景分层」筛选并点卡片跳回 `/scenes/<id>`。
- `/scenes` 列表页 + `/scenes/<id>` 详情页（场景内复用 Composer，多传 `scene_id`），Composer 措辞按场景切换成「场景生成 / 场景编辑」，且不再提供「视频」入口。

**P1 已完成**（2026-11-19）：
- 后端：`layer_sets` / `layers` 两张表（`0012_layers`）；`POST /api/v1/scenes/{id}/layer-sets` 提交后后台线程调 LLM 出层方案；`GET /api/v1/scenes/{id}/layer-sets`、`GET /layer-sets/{id}`、`PATCH /layers/{id}`、`DELETE /layer-sets/{id}`。LLM 走 OpenAI 兼容 `/chat/completions`。
- LLM 配置在**设置页**改（`GET/PUT /api/v1/settings/llm`、`POST /api/v1/settings/llm/test`），落在本机 `data/llm_config.json`，保存后立刻生效、不用重启；密钥明文只存这份文件，接口只回掩码（`sk-••••cdef`）。没配时提交分析会返回 400 并提示去设置页。
- 底部输入框（`frontend/components/LayerComposer.tsx`）是「图片编辑」那套 Composer 的克隆：模型 / 尺寸 / 数量 / 高级 / 生成都在，差别只有三条——参考图固定为分层源图（不给换、标「固定」）、提示词与负面词按层预填、高级面板默认展开；标题行直接写 `L0 层名`，提示词与负面词失焦自动 PATCH 回这一层。
- 请求头：`User-Agent: MiraForge/<版本>` + `x-opencode-session: <每次分析一个 uuid>`。OpenCode Go（`https://opencode.ai/zen/go/v1`）会拒掉没有会话头的请求（400 `MissingSessionID`），同一段分析的两轮请求共用一个会话 id 才能命中它的路由/缓存。
- 校验：层数（自动时 3–8，显式时严格相等）、`scroll_scale` 0.05–1.30、z 单调排序、每层 prompt 必须含【保留】与【删除】两段、key 去重；失败会把错误回灌给模型重试 1 次，仍失败则状态 `failed` 并把 `error_message` 显示在面板上。
- 前端：场景详情页顶部分层面板——选分层源图（本场景的图）、选模型（只列支持 `image_edit` 的）、层数、每层张数、创作者需求（默认填场景描述）→「生成分层方案」→ 层卡（可改层名 / 系数 / z / 六段提示词，blur 自动保存）→「复制全部」把整套提示词拷成文本，配好 LLM 之前也能手动拿去图片编辑里用。
- 尚未接真实 LLM：没有填 key 时提交会得到 400 与中文提示；验证用的是本地假 LLM（已清理，测试方案已删）。

**P1 交互改造（2026-11-19，用户定的新流程）**：分层面板不再常驻场景页，改成「场景图 → 悬浮「场景分层」→ 独立分层工作台」：
- 场景页图片卡悬浮时右下角出现「场景分层」按钮（列表视图在右上角图标栏），点进 `/scenes/<id>/layers/<imageId>`。
- 工作台里源图固定为进来时那张（不可更换）；一层一个页签（`L0…`），已出过图的层带绿点；页签内是该层的出图信息流（一个任务一格，排队占位），底边固定一个「这一层专属」的输入框（提示词 + 数量 1–4 +「生成本层 N 张」）。
- 每层可以单独改提示词（折叠「看/改提示词」或直接改底部输入框，blur 自动 PATCH 回 `layers.prompt`）、单独重新生成（再提交一次就是新批次，旧图留在信息流里）。
- 「重新分析」= 删掉当前方案回到分析表单；同一张图重新分析后只看最新一套方案。

**按层出图已可用（原 P2 的主体）**：`generations.layer_id`（`0013_generation_layer`）+ `POST /api/v1/layers/{id}/generations`（`count` / `prompt` / `negative_prompt` / `model` / `save_prompt`，落库为 `generation_type=scene_layer`、`media_type=scene_layer`、`scene_id` 由方案反查，参考图固定为该方案的源图）+ `GET /api/v1/layers/{id}/generations` + `GET /generations?layer=<id>`。实测 Qwen Turbo 单层 1 张约 8 秒（1024×576）。

**P2 剩余**：层级的批量「一次跑完所有层」、单层取消/重试入口（现在靠批次卡片与底部重新生成覆盖了主要路径）、每层进度汇总。

**2026-11-19 第二批细节修正**：
- 透明缩略图：`scene` / `scene_layer` 的缩略图改存 PNG（`PNG_THUMB_MEDIA`），而不是一律 `convert("RGB")` 压 JPEG——分层图透明区的 RGB 是紫色的，压成 JPEG 就把紫底露出来，信息流缩略条会整片发粉。老库里已存在的 `.jpg` 会在下次请求时自动重做一次。
- 场景计数口径：`scene_stats` / `list_scenes` / 封面兜底都排除 `scene_layer` 的产物，「几批几图」只算场景图本身；场景详情页的信息流也过滤掉带 `layer_id` 的批次，分层图只在所属层的页签里出现。
- 分层输入框可收纳：`LayerComposer` 默认收起（一行：层名 + 模型 + 数量 + 生成本层 + 展开箭头），点箭头展开成完整「图片编辑」布局；页面底部留白跟着在 150px / 330px 之间切。
- 已删除的产物不再占格：图片 / 视频 / 场景 / 分层四个信息流统一走 `frontend/lib/feed.ts` 的 `buildFeedSlots()`——「已完成但拿不到产物」的任务直接跳过，不再出现「图已被删除 / 无产物」占位卡；排队中与失败的任务仍然占位（那是状态，不是删除）。

**P3（可选）**：导出 ZIP + manifest（含 scroll_scale / z / 补边建议 + 引擎参数）。

**2026-11-19 第三批：提示词可编辑 + LLM 对话可见**

- 分层系统提示词搬到设置页：`backend/app/services/layer_prompt_service.py`（默认 1490 字，存 `data/layer_prompt.json`，与「视频提示词模板」完全分开——模板可删可加，这份只有一份）+ `GET/PUT /api/v1/settings/layer-prompt` + `POST …/reset`；`PUT` 必须保留 `{layer_rule}` 占位符（层数规则替换到那里），否则 422。
- 提示词结构从六段升到七段：新增 `【层级】` 说明本层在纵深里的位置与前后关系；`【补全】` 要求写方向 + 大致像素距离 + 支撑；`【背景】` 明确「透明区 RGB 必须是中性色 #000000，不能是紫色/品红/绿幕色」——这是透明缩略图发粉的同源问题（模型把紫当透明）。
- 通用负面词由后端追加：`layer_service.UNIVERSAL_NEGATIVE` + `merge_negative()`，LLM 只写本层最易犯的错，通用项（模糊、水印、分屏、构图跑掉、悬空、透视不一致……）在出图时合并去重。注意负面词只在 CFG > 1 时生效，分层输入框默认 CFG=2 正是为此。
- LLM 对话可见：`layer_sets.llm_meta.exchange[]` 记录每轮 `{attempt, system, user, has_image, response, error, duration_ms}`，接口拆成 `llm_exchange` 返回；分析中在「通常 1–3 分钟」下面实时显示，分析完在页签上方留一个「与 LLM 的对话 · N 轮」折叠条。每次请求后立即 `session.commit()`，所以等的时候就能看到第一轮已经发出。
- 超时：`llm_timeout_seconds` 默认 120 → 300（真实一次 7 层分析用 205.9 秒，120 秒会稳定超时）。

**2026-11-19 第四批：资产页把分层图收成一叠**

- 同一个场景的分层图在资产页合并成一张卡（`frontend/app/gallery/page.tsx` 的 `GalleryEntry`：`kind: "layers"` 按 `scene_id` 聚合，`kind: "single"` 还是逐张）。卡片后面垫两张错开的「纸」表示是一叠，角标「N 张分层图」，封面用**场景底图**（最新那张分层图常常是纯雾/纯背景，认不出是哪个场景）。
- 点这张卡直接进分层工作台 `/scenes/<scene>/layers/<sourceImageId>`（`fetchLayerSets(sceneId)` 取最近一套方案的 `source_image_id`），不再先进场景页。场景底图卡片的点开行为不变（进场景页）。
- 卡片名字：场景产物用**场景名**（`测试场景`、`类型验收`），不再是「批次 #11」；分层卡片是「场景名 · 分层」。
- 管理模式下点分层卡片 = 选中该场景的全部分层图（删除时一起进回收站）。

**2026-11-19 第五批：场景页分页修正 + 首页收场景图**

- 场景页「只有一个批次却出现加载更多」：信息流在客户端过滤掉 layer_id 非空的批次，但接口的 total 把该场景的分层批次也算进去了，于是 已加载(1) < total(10)。新增 GET /generations?exclude_layer=true（repo 里 Generation.layer_id.is_(None)），场景页查询直接带上，total 与显示数一致。
- 首页「最近作品」现在**包含场景底图**（之前 exclude_scene 把整个场景模块挡掉了）：改用 exclude_layer 只排除每层各自那一批，场景图带「场景」角标、点开进对应场景页；首页「图片」计数改成 media=image + media=scene 之和（分层图不重复计入）。

**2026-11-19 第六批：导出（场景图 + 每层选定的那张）**

- 入口：场景页信息流里把鼠标移到图上，图卡左下角出现「导出分层」；右上角操作栏也有一颗导出图标。点它下载一个 zip：`source/scene-<id>.png`（场景底图原图）+ `layers/Lxx_<key>.png`（每层那张）+ `manifest.json` + `README.txt`。没有分层方案的图点了会提示「先做一次分层再导出」。
- 每层用哪张：默认是这一层最新的那张；在分层工作台的层页签里，每张图左下角有「使用这张」，点一下就把这一层导出用的那张定下来（`layers.selected_image_id`，一层只能有一张，点另一张就换过去，再点同一张则取消、回到「用最新的」）。被选中的卡片有高亮描边 +「导出用这张」的常驻角标，另外那批里的其它图仍然只在自己被悬浮时露出「使用这张」。
- 后端：`GET /api/v1/scenes/{scene_id}/layers/{source_image_id}/export`（取该源图最新一套 `planned` 方案）；`layers.selected_image_id`（迁移 `0014_layer_selected_image`）；`PATCH /layers/{id}` 接受 `selected_image_id`，会校验这张图确实是这一层出的（否则 422「这张图不是这一层出的，不能指定」）。
- manifest 里带每层的 `scroll_scale` / `z_index` / 文件名 / `picked`（`manual` 还是 `latest`）、以及 Godot 参考参数（视口 1600×900、zoom 0.95、行程 ±118、清屏色 `#07050C`）；还没出图的层会在 `picked: "missing"` 并写进 README，不会让整个导出失败。
- 顺带修：分层工作台原先取「这张图最新的一套方案」，如果最新那套是失败的，就会一直展示失败状态、看不到更早的成功方案；改成优先取最新**成功**的那套，没有才退回最新。

**2026-11-19 第七批：「生成所有层」**

- 分层工作台右上角一颗主按钮「生成所有层（N）」：一次给整套方案的每一层各排一条批次，`count` 取方案的「每层张数」。worker 是单协程，所以这些批次会一层接一层跑；页签上每层都会立刻亮起圆点，说明这一层已经排上了。
- 接口：`POST /api/v1/layer-sets/{set_id}/generations` → `{generations, submitted, images, skipped}`。每层只用自己的提示词与负向词（负向词仍会合并系统通用项）；某一层提交失败（比如模型不支持编辑）不会连累其它层，失败的层名与原因放进 `skipped`，前端 toast 里报「跳过 N 层」。
- 单层出图与「生成所有层」共用同一段提交逻辑（`backend/app/api/layer_sets.py` 的 `_submit_layer_generation`），所以参考图、尺寸、类型（`scene_layer`）在两处完全一致。
- 成本提示：6 层 × 1 张、参考图 2560×1104 时，一批大约 2 分钟，整套 12 分钟左右；想快就在分层输入框里把尺寸压小或换 turbo 模型。

**2026-11-20 第八批：已分层的图加角标**

- 场景页里，凡是已经有分层方案的那张场景图，右上角挂一个图层角标：「6 层」；分析失败的那张显示「分层失败」；同一张图分析过多次时取信息量最大的一条（成功的层数优先于失败）。
- 数据来自场景页已经在查的 `fetchLayerSets(sceneId)`（原本只用于「能不能导出」），这里多算一个 `Map<imageId, 文案>`，通过 `Feed` 的 `layerBadge` 逐格传给 `FeedCard`；网格卡在缩略图右上角渲染胶囊，列表卡在 54px 缩略图底部渲染一条窄条——两种视图都不占标题行。
- 角标是纯提示，不可点；点卡片仍然是原来的行为（进场景页 / 打开详情）。资产页与首页不传这个 prop，所以那边的卡片不受影响。

**2026-11-20 第九批：时间筛选统一默认「最近 7 天」**

- 资产页原默认「全部时间」、图片页与视频页原默认「今天」，三处统一改成 `useState<DateFilter>("week")`（`DateFilter` 的 `week` = 今天往前数 7 天，含今天）。
- 场景列表页与场景详情页没有时间筛选（场景按场景隔离，不按日期切），所以没涉及；回收站也没有日期筛选。
- 默认值只影响初始状态，用户仍可切回「全部时间 / 今天 / 昨天」，刷新页面会回到「最近 7 天」。

**2026-11-20 第十批：分层改成五档槽位（P0）**

- 分层不再是「LLM 给一个 0–1 的视差系数」，而是固定五档槽位：远景 `far` 0.08 / z −40、中景 `mid` 0.28 / −30、近景 `near` 0.58 / −20、玩法层 `gameplay` 1.00 / 0、前景 `foreground` 1.12 / +20。每档最多 2 层，玩法层必须正好 1 层；同档内的先后用 `depth`（0 最远）表示，系数与 z 由后端算，前端不再让人填系数。
- LLM 的输出 schema 跟着换：`slot` + `depth`，`scroll_scale` 不再由模型给（模型算不准，也给不出引擎要的那种规整值）。校验规则：玩法层缺了、槽位名不认识、某档超员 → 把错误回灌重试一次。
- 老数据迁移按原来的系数落槽（<0.15 远景、<0.45 中景、<0.75 近景、≤1.02 玩法层、其余前景），同档内按原顺序排 `depth`，系数与 z 统一重算。
- 导出按槽位命名：`far_00.png` / `mid_00.png` / `near_00.png` / `gameplay.png` / `foreground_00.png`；`manifest.json` 多了 `parallax` 段（每档的 scroll_scale / z_index / 文件列表），Godot 侧照着建 5 个 `Parallax2D` 即可。
- 顺手修掉一个环境坑：SQLite 在整表更新带索引的列时会走 two-pass，把中间结果落到临时目录；这台机器的临时目录不可写，于是报 `unable to open database file`。修法是连接上设 `PRAGMA temp_store=MEMORY`（迁移和老库补数据都加了）。不设的话，迁移会在「加完列、记版本前」卡死，后端起不来。

**2026-11-20 第十一批：图集工具（P1）**

- 工具页多了「图集」：把一个项目里的透明图（平台、柱子、拱门、蘑菇…）装成一张 atlas。图集只是**条目清单**，`kit_items.image_id` 指向项目里已有的图，不复制文件；改条目只影响下一次打包。
- 后端：`kits` / `kit_items` 两张表（迁移 `0016_kits`），`/api/v1/kits` 一套 CRUD，外加 `GET /kits/{id}/preview`（返回画布尺寸与每件的 rect）、`GET /kits/{id}/atlas.png`（实时打包，`no-store`）、`GET /kits/{id}/export`（`atlas.png` + `kit.json` + `README.txt` 的 zip）。
- 打包规则：按 alpha `bbox` 裁掉透明边 → 四周扩 3px（复制边缘像素，避免缩放时露白毛边）→ 按高度降序 shelf packing，件与件留 `padding`、超过 `max_width` 换行 → 画布尺寸取 4 的倍数。`kit.json` 里每件带 `x/y/w/h`（含扩边）、`anchor`（`top` / `bottom`，Godot 侧用来把平台顶面对齐碰撞面）。
- 编辑器页分两栏：左边条目卡（换 key、切换锚点、删除、从资产挑图），右边实时预览（棋盘格底，一眼看出透明区）+ 每件的坐标表；改完参数点「保存」才会改 `padding` / `max_width`。
- 顺带记住两个坑：① `Content-Disposition` 里放中文文件名会让 Starlette 编码 header 失败（latin-1），要用 `filename*=UTF-8''…`；② 路由不能写成 `/kits/{kit_id}` 再挂 `/kits/items/{id}`，`items` 会被当成 kit_id —— 条目单独挂 `/kit-items`。

**2026-11-20 第十二批：图集摆放（格子对齐 + MaxRects）**

- 摆放算法从「按行堆」换成 **MaxRects（BSSF，best short side fit）**：按行堆时每一行的高度按最高那件算，矮件上方的空白全浪费；MaxRects 会把后面的件塞进这些空洞。同时对「列数 / 画布宽度」做搜索（3 种排序 × 所有候选列数），按面积取最优，太扁或太长的画布加 12% 惩罚。
- 新增 **格子对齐**（`kits.cell`，默认 64，可设 0/16/32/48/64/96/128）：每件占 `ceil((w+2p)/cell) × ceil((h+2p)/cell)` 个整格，坐标落在格线上，因此**一格之内只会有一个件**，引擎里按 64 格摆放不会串味。`cell = 0` 退回像素级装箱。
- 实测（6 件：两块平台 646×358、两根柱 326×710、拱门 646×710、蘑菇 326×326，间距 6）：按行堆 996×1802（83.0%）→ MaxRects 自由装箱 996×1782（84.0%）→ 64 格对齐 768×2688（72.2%）→ 32 格对齐 1024×1824（79.8%）。格子越细浪费越少，但只有 64 的倍数才能直接对 64 TileSet。
- 预览接口多了 `?grid=1`（叠格子线，只给界面看，导出不带），编辑器右上角可切「显示/隐藏格子」；面板同时显示 `宽×高 · N 格 · 占用 %`。
- `manifest.json` 增加 `cell` / `fill` / `packing`（`maxrects-cell` | `maxrects-free`）三个字段，Godot 侧可以不看，但排查「为什么这张图集是 768 宽」时有用。
- 新增 `backend/tests/test_kit_packing.py`：断言坐标落在格线上、同一格不会被两个件占用、每件都在画布内、自由装箱时矩形互不重叠、超宽件报错。
## 15. 元素提取（2026-11-20 第十一批起）

- 定位：从场景底图里拆出「能重复用的小件」（地形段、结构件、道具、装饰），装进图集给 tilemap 用。
- LLM 只点名：给出 name / kind / description / where，**不输出任何坐标**（实测文本 VLM 回归 bbox 不可靠：拱门的框落在灯笼上、地面的框浮在地面上方）。
- 每件单独跑一次 image_edit（参考图固定为场景底图，类型 lement），产物是真 alpha 的透明图；页面上每个元素一个页签，可改提示词后重新提取。
- 写图集时按 alpha 裁边（image_service.trimmed_png），所以 1280×704 的画布只留中间那一小块。
- 坑：提示词里强调「占满画面高度」会让模型放弃透明背景（整张不透明）——保持「只画这一件 + 其余透明」，尺寸靠裁边解决。
- 元素页签上的「没有透明背景」小标：本次出图 alpha 覆盖率 < 5% 时提示重提。

### 15.1 提示词由 LLM 写（2026-11-23）

美术风格不能写死在代码里，也不该让用户手填——一张图是地下矿洞、地表遗迹还是水下，风格本来就不同。改成**两段式**：

1. 分析阶段（一次 LLM 调用）：模型先读图概括画风与场景类型（`style` / `scene_type`），再挑件，并**为每一件写一条完整的中文绘图提示词**，按六段输出：`【提取对象】【完整结构】【完整性重建】【风格一致】【独立物件】【透明背景】`。`parts` 字段要求按从上到下列举可见部件与连接关系，这是补全是否合理的关键。
2. 出图阶段：`element.prompt` 原样送给 `image_edit`，只在末尾追加一段不含画风的 `OUTPUT_RULES`（居中、不裁切、真透明、边缘干净）。

四项控制是硬约束：`REQUIRED_MARKS` 校验每条 prompt 必须含「完整性重建 / 风格一致性 / 独立物件 / 透明背景」，缺任一项就带着缺失清单回灌重试一次。`style` 与 `scene_type` 记录在 `element_sets.llm_meta`，页面上可直接看到模型判断的场景类型。

措辞上要求「提取完整物件，并对不可见区域进行结构性重建」，而不是「抠出物件」——只说抠，模型不会补全被遮挡的部分；只说重画，模型又会改设计。

实测（场景 8 · 底图 #66）：一次调用、8 件、每件 prompt 400–600 字，风格段会自己写出「光源自右侧油灯方向斜照、左侧被暖黄染亮」这种来自画面的观察；用这批 prompt 出图，拱门 480×525（透明 87%）、油灯 213×601（透明 91%），结构完整、画风与底图一致。

### 15.2 元素产物不进场景信息流（2026-11-23）

元素提取出的图（`generations.generation_type = 'element'`、`media_type = 'element'`、带 `element_id`）属于某个可复用件，不再混进场景页的信息流：

- 后端：`GET /generations` 新增 `exclude_element`（仓库层同时加 `Generation.element_id IS NULL` 与 `generation_type != 'element'` 两道条件，防止老数据只写了其中一个）。
- 场景页：`fetchGenerations({ scene, excludeLayer: true, excludeElement: true })`，客户端再兜一层 `!item.layer_id && !item.element_id`。
- 首页最近作品、资产页（`gallery`）同样带 `excludeElement: true`——元素图只在「元素提取」页的页签里出现。
- 场景的「几批几图」计数把 `media_type` 为 `scene_layer` / `element` 的产物一并排除（`scene_service.scene_stats` / `list_scenes` / `scene_covers`），封面也不会退化成某个元素的透明小图。

### 15.3 拆件系统提示词定稿（2026-11-23）

采用用户提供的完整版（角色定义 + 三阶段 + 输出格式 + 场景分析 + 拆件规则 + 边界规则 + 每件六段规范 + 优先级 + 字段规则 + 自检清单），占位到 `element_prompt_service.DEFAULT_PROMPT`（3,905 字），设置页「元素提取提示词」可改可恢复默认。

本系统在其后追加三段补充约定：

- 画布与参考图同尺寸，物件占画面高度 40%–90%、居中、四周留透明边（早期「占满画布」会让模型放弃透明背景）。
- 只调用一次图像编辑模型，提示词要独立成立，不写「参考图位于……」。
- 不在提示词里写文件格式/分辨率/Alpha 实现等技术细节。

后端另在出图前统一追加 `OUTPUT_RULES`（不含画风词）：居中完整、alpha=0、透明区 #000000、无棋盘格/白底/黑底/渐变/光晕，且**自身发光只允许紧贴轮廓 2–5px 的一圈亮边，不要大面积光雾**——实测油灯会自发画出约 600px 的弥散暖黄晕，需要这一条压住。

实测（场景 8 源图 66 → set 3）：一次分析 81 秒、8 件；每件 prompt 595–699 字、六段齐全、`parts` 按从上到下列出可见部件；单件出图 16–18 秒，透明面积 89%。

### 15.4 元素页的出图体验（2026-11-23）

- **进度与占位**：元素页的出图区改用 lib/feed.ts 的 uildFeedSlots，提交后立刻按任务数铺出占位卡：排队显示「排队中… 0%」、生成中显示进度条与百分比、失败显示错误摘要，不再出现「点了没反应」。
- **点开大图**：元素卡片点一下就开预览层——棋盘格底、原尺寸大图、角标「宽×高 · 点空白处或按 Esc 关闭」。缩略图仍走 	rimmed.png（按 alpha 裁边 + 限宽），预览走原图，保证透明边缘能看清。
- 提示词输入框按字数自动撑高（6–16 行），六段提示词不再被一行行挤在小框里。

### 15.5 每一件指定用哪张图（2026-11-23）

- **问题**：图集条目只记 lement_id，取图时永远拿「这件元素最新一次出图」，页面上也没有选图入口——所以「选了第二张、图集里还是第一张」根本不成立，图集压根没记过是哪张。
- **改法**：lements.selected_image_id（迁移  020_element_selected_image）；lement_service.element_image() 优先返回它，校验「图存在、未删、media_type=element」，失效时退回最新一张。PATCH /elements/{id} 接收 selected_image_id，校验这张图确实是这件元素出的（跨件指定报「这张图不是这一件出的，不能指定」）。
- **交互**：元素页每张图右下角的按钮从「用它」改成「用这张 / 已选用」；被选中的那张左上角常驻「图集使用」角标、卡片描边高亮；页签在 kit_count > 0 时显示「已在图集」。
- **验证**：元素 32（悬挂油灯）选 image 89 → GET /kits/3/preview 里 hanging_lantern 的 rect 从 292×592 变成 333×593，图集真的换了图。

### 15.6 元素页补入口与删除（2026-11-23）

- 元素页顶部图集下拉旁边加了「打开图集 →」，直接跳 /tools/kit/<id>，不用再绕回工具页。
- 每张元素图右下角加了「删除」（二次确认），走 DELETE /images/{id} 软删——图进回收站，30 天内可恢复；删完这一件还能重新提取。
- 选中的图被删后，sync_element_status 会清空 selected_image_id，退回「用最新一张」，不会出现图集取不到图的情况（实测：元素 30 指定 93 → 删除 93 → selected_image_id 变空、image_id 落到 94）。

### 15.7 「加不进图集」的加固（2026-11-23）

- 现象：八个元素里最后三件（方形砌石台 / 发光蘑菇 / 碎石堆）点「加入图集」没反应。用接口直连复现时三件都能加进去，说明不是后端拒绝，而是前端没有反馈：按钮在被判「不可加」时是 disabled，点了什么都不会发生。
- 加固：① 按钮在 kit_count > 0 时直接显示「已在图集」并禁用；② 没选图集时点它会 toast「先在上面选一个图集」；③ 后端 dd_item 增加「这件还没出图」的明确报错，且同一元素重复加会直接返回已有条目（幂等，不会在图集里出现两遍）；④ 加成功后同时 invalidate ["kits"]、["kit", kitId]、["element-sets", sceneId]。
- 结果：图集 3 现有 8 件（1024×2048、64 格、占用 72%）。

### 15.8 图集条目支持缩放（2026-11-23）

- kit_items.scale（迁移  021_kit_item_scale，默认 1.0，范围 0.05–2.0）：装箱时先把这件按比例 LANCZOS 缩放，再按缩放后的尺寸算格子与矩形，所以缩小会真的少占格子。
- 图集编辑器每张条目卡多了比例下拉（10%–200%，当前值不在预设里也会补进列表）；改完立刻重算，右侧预览与下方 rect 表同步。
- 实测（kit 3，8 件）：蘑菇 50%、碎石堆 35%、石台段 60%、方形砌石台 60% 之后，画布从 1024×2048 变成 960×1536、占用 65%，各件视觉尺寸终于配得上。

### 15.9 图集归属场景 + 提取页直接新建（2026-11-23）

- `kits.scene_id`（迁移 `0022_kit_scene`，可空、带索引）：从某个场景的元素提取页建出来的图集，记一下归属。
- 提取页的「加入图集」下拉多了最后一项「＋ 新建图集（<场景名> · 提取件）」，点一下就以默认名 `场景名 · 提取件`（padding 6 / 宽 1024 / 格 64 / 带 scene_id）建好并立刻选中，不用再去工具页手动建。
- 进提取页时优先选中「属于这个场景的图集」，其次才是第一个；项目里一个图集都没有、并且已经提取出东西时，会自动建一个本场景的图集（只在这一种情况下自动建，避免一个场景攒出一堆重名图集）。
- 实测：场景 8「苔藓矿脉 · 入口」点下拉新建 → kit 5「苔藓矿脉 · 入口 · 提取件」`scene_id=8`，下拉立刻切过去、toast 提示；`pytest` 186 passed、`tsc` 0 错误。

### 15.10 元素提取页「提取所有」（2026-11-24）

- 源图条右侧新增主按钮「提取所有 N 件」：一次把这一组里的每件各排 `count` 张（走同一个 `POST /element-sets/{id}/extractions`，`element_ids` 传全部），worker 串行一件接一件跑。
- 有任意一件处于 `queued` / `running` 时按钮变「正在提取…」并禁用，避免重复排队；提交后 toast 报「已排队 N 件 · 共 M 张」。
- 实测：set 3 取两件 → 返回 2 条 `generation_type=element`、`element_id` 正确、状态 pending；取消并删除后接口 404 确认清理干净。`tsc` 0 错误。

### 15.11 图集默认「未选择」+ 记住上次的选择 + 就地移出（2026-11-24）

- 提取页默认**不替用户选图集**：没选过就是「选择图集…」，此时「加入图集」按钮禁用（点了只提示「先在上面选一个图集，或者新建一个」）。只有这个场景**手动选过**才会沿用上次那个（存在 `localStorage["miraforge:kit:<sceneId>"]`，图集被删掉时自动清掉回到未选择）。
- 取消「一进页面就自动建图集」的逻辑，避免攒重名图集；要建就点下拉里的「＋ 新建图集（<场景名> · 提取件）」，建完自动选中并记住。
- 下拉里给本场景的图集加「（本场景）」后缀，方便一眼分辨。
- 每件元素现在可以**就地移出**：当前选中的图集里有这件时显示「移出图集」（`DELETE /kits/{kit_id}/elements/{element_id}`，204），不用再跑去图集页删条目。`ElementRead` 增加 `kit_ids`，一次查询就能知道每件在哪些图集里，前端据此判断按钮状态。
- 顺手修：批次被取消后元素会永远卡在「排队中」——`sync_element_status` 现在把 `cancelled` / 批次已删的情况退回 `draft`。
- 实测：首次进入下拉为空、按钮禁用；选 kit 3 后刷新仍默认 kit 3；kit 5 加件 → `kit_ids=[3,5]` → `DELETE /kits/5/elements/32` → 回到 `[3]`。`pytest` 186 passed、`tsc` 0 错误。

### 15.12 场景原图可点开预览（2026-11-24）

- 提取页左上角的场景原图缩略图改成按钮：hover 出现「点开预览」，点开走和元素图同一个预览层（棋盘格底、`1280×720 · 点空白处或按 Esc 关闭`），点空白或 Esc 关闭。

### 15.13 元素页底部输入框 + 手画遮罩（2026-11-24）

- 输入框搬到页面底部（`frontend/components/ElementComposer.tsx`）：和分层工作台同一套版式，默认收起，只留「类别 · 名称 · 画遮罩 · 提取 N 张」一行；展开后有六段提示词输入框（按内容撑高）、张数、遮罩入口。上面卡片的提示词与张数已移除。
- 手画遮罩（`elements.mask_path`，迁移 `0023_element_mask`）：点「画遮罩」在底图上圈出这一件，存成灰度 PNG（白色 = 这件）。出图时 `element_service.masked_reference()` 用遮罩的包围盒把底图裁一块（四周留 10%）当参考图——模型看到的是「只剩这一件附近」的画面，比整张场景准得多；没有遮罩时仍用整张底图。
- 接口：`POST /elements/{id}/mask`（multipart）、`DELETE /elements/{id}/mask`、`GET /elements/{id}/mask`；`ElementRead.has_mask`。实测把油灯圈出来（约 120×210 的框）后参考图裁成 145×259，出图 704×1280、裁后 332×821、透明 85.2%，链条/提梁/灯罩/火焰/底盘齐全，没有弥散光晕。
- 注意：有遮罩时画布比例跟随遮罩范围（不再是底图比例），输入框里会显示「按遮罩范围出图」。

### 15.14 元素输入框带上高级参数（2026-11-24）

- 底部输入框展开后多一块「高级」面板（默认展开）：种子（留空随机）、步数、CFG（默认 2）、采样器、负面提示词；收起时只留一行。
- 后端 `ElementExtractPayload` 增加 `negative_prompt / seed / steps / cfg / sampler`，`element_service.extract_elements(...)` 原样写进 `GenerationCreate`；负面词会和 `UNIVERSAL_NEGATIVE`（34 条通用项）合并去重，所以只写「这件最容易出的错」就够。
- 默认 CFG=2：CFG≈1 时采样器会跳过 uncond，负面提示词等于没写。
- 实测：`POST /element-sets/3/extractions` 带 `cfg=3, steps=20, sampler=euler, seed=12345, negative_prompt=光晕，发光雾` → 批次落库 `cfg=3.0 / steps=20 / sampler=euler`，任务 `seed=12345`，负向词变成「光晕，发光雾 + 34 条通用项」。

### 15.15 图集：超宽件自动缩小 + 宽度/间距/格子即时生效（2026-11-24）

- 打包不再因为「某一件比画布宽」整张失败：`_shrink_to_fit(pieces, limit_w)` 把超宽件等比缩到刚好放下，件名记进 manifest 的 `shrunk`，`GET /kits/{id}/preview` 的 `AtlasSummary.shrunk` 带出来，编辑器在预览下面用琥珀色提示条说明「缩了哪几件、想保持原尺寸就把宽度调大」。报错文案也改成只点真正超宽的那一件（原来会把前三件都列出来）。
- 宽度 / 间距 / 格子从「改完要点保存」改成**即时生效**：`onBlur` 与停止输入 600ms 都会 `PATCH /kits/{id}`，随后 `invalidateQueries(["kit"], ["kit-preview"], ["kits"])`，预览立刻重排；「保存」按钮只剩改名字用。原因是用户改宽度就是为了马上看到重新打包的结果，等失焦/点保存不符合预期。
- 实测 kit 7（11 件）：宽度 1024 → `1024×2624`、占用 62%、`mossy_floating_slab` 被缩；改成 2048 → `1472×1600`、占用 75.3%、`shrunk` 为空。

### 15.16 场景原图可点开预览（2026-11-24）

- 分层工作台顶部那条「场景原图」缩略图改成可点：hover 浮出「点开预览」，点开是全屏大图（棋盘格底，标注 `1280×720 · 点空白处或按 Esc 关闭`）。
- 预览层抽成共享组件 `frontend/components/ImagePreview.tsx`（`{ image, onClose }`，内部处理 Esc），元素提取页原来那份内联大图也换成它，两页行为一致。
- 缩略图仍用 `imageThumbnailUrl`（快），点开才加载原图 `imageFileUrl`。

### 15.17 去掉分层提示词的分段校验（2026-11-24）

- 原因：用户正在自己调这套提示词，`_validate_plan` 里那条「必须含【保留】【删除】【补全】、至少 5 段」的硬校验会把实验中的写法直接判成失败（界面报「上一次没有成功：第 1 层（远雾岩壁）的 prompt 缺段…」）。
- 改法：`backend/app/services/layer_service.py` 删掉分段校验与 `_SEGMENTS` 常量；仍保留结构性校验——`layers` 非空、每层有 `name`/`prompt`、`key` 去重、槽位合法、`gameplay` 必须正好一层、每槽数量不超限。
- 提示词本身（设置页那份「分层提示词」）不再被代码审查，怎么写由用户决定；分段结构只剩默认文本里的建议。

### 15.18 新增 behind 档位 + 手动补层（2026-11-24）

- 场景里常有「和玩法层同一个深度面、只是画在地形后面」的东西（左侧石墙、右侧贴地装饰、洞口结构）。它们不应该有视差，也不该被塞进 near/far。新增槽位 `behind`（中文「底层美术」）：`scroll = 1.0`（与 gameplay 相同，不产生相对滑动）、`z = -10`（画在 gameplay 之后）、最多 3 层，`services/layer_slots.py` 的 `SLOTS` 与 `SLOT_ORDER` 都加了它，顺序是 far → mid → near → behind → gameplay → foreground。
- LLM 的槽位规则里补了一句：behind 只在画面确实有同深度的墙/柱/装饰时才给，没有就不要给；手动补层默认就落在 behind。
- 手动补层：`POST /layer-sets/{set_id}/layers`（`LayerCreate{name, slot, prompt, negative_prompt?, key?, role?}`），槽位校验与自动分析一致（每档上限、总层数 ≤ 12），`ord` 取最大值 +1，`depth` 取该档已有层数，系数与 z 由槽位算；`DELETE /layers/{layer_id}` 删层（已出的图留在回收站，不跟着删）。
- 前端：页签行末尾「+ 添加层」展开一个内联表单（层名 / 档位含「底层美术」/ 提示词 / 负面词），创建后自动切到新层；层元信息行末尾「删掉这层」。
- 实测：场景 12（源图 149）补了一层「左侧石墙」→ `slot=behind, scroll=1.0, z=-10, ord=5`；导出 zip 的 `manifest.parallax` 六档齐全（behind 1.0/−10，尚未出图所以 files 为空）。
- `pytest` 186 passed / 0 failures / 0 errors、`tsc --noEmit` 0 错误。

### 15.19 每层手画遮罩定位（2026-11-24）

问题：分层只能靠提示词描述「哪一块属于这一层」，模型经常把邻近的东西也画进来，或者把该有的部分漏在遮罩外。用户要的是「我框哪块，就只重绘哪块」。

做法：不裁参考图（裁了就和源图对不齐），改走 **inpaint**——参考图仍是整张源图，遮罩告诉采样器「只在这块重绘」，出图后再按遮罩把 alpha 切出去，图仍与源图逐像素对齐。

- `layers.mask_path`（迁移 `0024_layer_mask`）；`POST/DELETE/GET /api/v1/layers/{id}/mask`，遮罩存 `scenes/<sid>/layers/<lid>/masks/mask.png`。
- `_submit_layer_generation` 把 `mask_image_path=layer.mask_path` 传下去：场景类批次带遮罩 → `workflow_type = IMAGE_INPAINT`（`qwen_image_21_inpaint`，`VAEEncode` + `SetLatentNoiseMask`），输出尺寸跟随参考图，遮罩外的原始像素不动。
- 出图后 worker 调 `image_service.cut_by_mask(content, mask)`：遮罩外 alpha=0、遮罩内保留原样，存 PNG —— 于是产物就是「这一层该有的那一块」。
- UI：分层输入框标题行加「画遮罩 / 改遮罩」（有遮罩时带一个圆点），点开复用元素页那块 `MaskEditor`（棋盘格 + 笔刷），遮罩和源图 1:1；清掉遮罩就恢复整张重画。

实测：用户手画左侧石墙那块遮罩（2560×1440 上 0–510px 宽的自由笔迹）→ 本层出图 `gen 204 / image 219`，`2560×1440`，不透明区域 bbox 正好落在那块遮罩里（占据 0–465 × 0–1212），其余全透明，墙面的砖缝/苔藓是重绘出来的新内容。

`pytest` 186 passed / 0 failures / 0 errors、`tsc --noEmit` 0 错误。

#### 遮罩编辑器的三个补丁（同日）

1. **`SecurityError: canvas has been tainted`**：遮罩从后端 8000 取、页面在 3000，`new Image()` 直接 `drawImage` 到画布会把画布标成跨域污染，后面 `getImageData` 就抛错。修法：旧遮罩先用 `fetch` 抓成 blob 再 `URL.createObjectURL` 当同源图用（抓不到才退回 `crossOrigin="anonymous"` 的普通加载）。
2. **`has_mask` 在 PATCH 后丢**：`LayerRead.has_mask` 不是表字段，`PATCH /layers/{id}` 与 `POST /layers/{id}/mask` 之前直接 `model_validate`，返回一直是 `false`，按钮永远显示「画遮罩」。统一收口到 `_layer_read(layer)`，三处返回都走它。
3. **behind 的系数被启动回填写错**：`core/migrations.py` 的 `_SLOT_METRICS` 是一条手写 CASE，加 behind 时没同步，`ELSE 1.12 / 20` 把「底层美术」写成了前景的值，重启后 1.0/−10 变 1.12/20。改成从 `layer_slots.SLOTS` 生成 SQL（`_slot_metrics_sql()`），以后加档位不会再漏。

4. **打开旧遮罩整张画面变红**：加载时用的是 `fillRect(红) → destination-in(mask)`，而灰度 PNG 是不透明的（alpha 恒 255），`destination-in` 只认 alpha，于是红色铺满整张。改成先用离屏画布读像素、把灰度当 alpha 写回（`r=255,g=80,b=80,a=灰度`），再画到遮罩层；`apply()` 取红通道的算法不用动，羽化也能保留。
   - 附带的教训：调试时点了一次「应用遮罩」，把当时那张「全红」状态存成了纯白遮罩（等于没画）。已按渲染产物 `235_0.png` 的 alpha 通道还原出原来的笔迹（alpha 就是遮罩形状），bbox 与原来一致（0–465 × 0–1212，覆盖 9.0%）。

### 15.20 分层批次的刷新与删层后的批次残留（2026-11-24）

两个现象：层里删掉批次列表不刷新；删掉一层再新建，新层里又出现旧批次。

- **删批次不刷新**：工作台的批次查询键是 `["layer-generations", layerId]`，而共用的 `useImageActions.refresh()` 只失效 `["generations"]` / `["images"]`。改 `frontend/hooks/useImageActions.ts` 的 `refresh` 里一并失效 `["layer-generations"]` 与 `["layer-sets"]`。
- **新层里冒出旧批次**：`delete_layer` 原来是 `db.delete(layer)` 硬删，SQLite 的 rowid 取 `max+1`，删掉最大那层后新建会**复用同一个 id**，于是 `generations.layer_id` 还指着旧批次的记录又挂到新层上。改成软删：`layers.deleted_at`（迁移 `0025_layer_deleted_at`），`delete_layer` 只写时间戳，行还在，id 不会被复用；`visible_layers()` 过滤，导出 / 渲染 / 槽位计数 / key 去重都只认未删的层。
- 顺带修两处：`_to_read` 里的 `has_mask` 之前误写成自递归（`return _layer_read(layer)`），改为真正从 `mask_path` 推；页签的绿点从 `generation_id` 改成后端算的 `has_images`（批次删掉后立刻变灰，`generation_id` 仍指着旧批次）。
- 验证：`POST /layer-sets/14/layers` 两次（中间删一次）拿到 id 85 → 86，不再复用；新层 `GET /layers/86/generations` 为 0；删批次后该层 `has_images=false`；`pytest` 186 passed、`tsc` 0 错误。

