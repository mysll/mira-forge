# 工作流映射

把 API 参数映射到 ComfyUI API 格式的 prompt graph。

## 依据

本文件的节点结构来自三处**可验证的事实**，没有猜节点 ID：

1. 本机 ComfyUI `GET /object_info` 的实时节点 schema（0.44.0）。
2. 官方模板 `comfyui_workflow_templates_json\templates\image_qwen_image_2_1_{t2i,turbo_t2i,image_edit,turbo_image_edit}.json`（UI 格式，用 subgraph 封装）。
3. 用户**真实执行过**的 API 格式图 `D:\AI\Workflows\QwenImage21LayerExtraction\qwen21_layer_extract_api.json`——它证明 API 格式下各输入键名与连接写法。

UI 模板是 subgraph 结构，**不能直接提交给 `/prompt`**；必须展平成扁平的 API 图。P2 落地的 `backend/workflows/*.json` 就是展平后的图，由本文件描述，并会用真实提交验证。

## 参考图（已验证）的节点结构

用户那张真实跑通的编辑图，节点编号如下（这是**事实**，不是命名建议）：

| id | class_type | 关键输入 |
| --- | --- | --- |
| 1 | `LoadImage` | `image` |
| 2 | `UNETLoader` | `unet_name=qwen_image_2.1_int8_convrot.safetensors`, `weight_dtype=default` |
| 3 | `CLIPLoader` | `clip_name=qwen3vl_8b_int8_convrot.safetensors`, `type=qwen_image`, `device=default` |
| 4 | `VAELoader` | `vae_name=qwen_image_2.1_vae_bf16.safetensors` |
| 5 | `QwenImage21Cache` | `model=[2,0]`, `device=auto`, `dtype=default` |
| 6 | `TextEncodeQwenImage21` | `clip=[3,0]`, `vae=[4,0]`, `prompt`, `negative_prompt=""`, `resolution=0`, `images.image_1=[1,0]` |
| 7 | `KSampler` | `model=[5,0]`, `seed`, `steps=25`, `cfg=1.0`, `sampler_name=euler`, `scheduler=simple`, `positive=[6,0]`, `negative=[6,1]`, `latent_image=[6,2]`, `denoise=1.0` |
| 8 | `VAEDecode` | `samples=[7,0]`, `vae=[4,0]` |
| 9 | `SaveImage` | `images=[8,0]`, `filename_prefix` |

两个容易踩的点，已由该图证实：

- **AUTOGROW 输入的 API 键名带子前缀**：第 1 张参考图写作 `"images.image_1"`，不是 `images`，也不是数组。
- **编辑链路的 latent 直接取自编码器第 3 个输出**：`latent_image=[6,2]`（`TextEncodeQwenImage21` 的 output `['positive','negative','latent']`）。因此编辑时 `EmptyLatentImage` 不参与，宽高不生效。

## 四个目标工作流

| 注册表条目 | 文件 | 采样方式 | 状态 |
| --- | --- | --- | --- |
| `qwen_image_21` / text_to_image | `backend/workflows/qwen_image_21_t2i.json` | KSampler 25 步 | ✅ 真实出图验证（4 张） |
| `qwen_image_21` / image_edit | `backend/workflows/qwen_image_21_edit.json` | KSampler 25 步 | 结构就绪，待 P4 接上传后验证 |
| `qwen_image_21_turbo` / text_to_image | `backend/workflows/qwen_image_21_turbo_t2i.json` | SamplerCustomAdvanced + 固定 sigma 表 | ✅ 真实出图验证（多张） |
| `qwen_image_21_turbo` / image_edit | `backend/workflows/qwen_image_21_turbo_edit.json` | SamplerCustomAdvanced + 固定 sigma 表 | 结构就绪，待 P4 接上传后验证 |

编辑图的结构来自用户已真实执行过的 `qwen21_layer_extract_api.json`，但 MiraForge 自己的编辑图**尚未经过 POST /prompt 跑通**（P4 才接参考图上传），因此注册表里 `validated: false`。

### 文生图链路

```
UNETLoader(qwen_image_2.1_int8_convrot) ─► QwenImage21Cache ─┐
CLIPLoader(qwen3vl_8b_int8_convrot, type=qwen_image) ─► TextEncodeQwenImage21 (无 images/vae)
                                                             ├─ positive ─┐
                                                             └─ negative ─┤
EmptyLatentImage(width,height,batch_size=1) ─────────────────────────────► KSampler ─► VAEDecode ─► SaveImage
VAELoader(qwen_image_2.1_vae_bf16) ───────────────────────────────────────┘ (VAEDecode.vae)
```

文生图时 `TextEncodeQwenImage21` 只接 `clip` + `prompt` + `negative_prompt`，**不接 `images`、不接 `vae`**——它只输出第 1、2 个口（positive/negative），第 3 个 latent 输出无意义。

### 图片编辑链路

```
LoadImage ─► TextEncodeQwenImage21(clip, vae, prompt, negative_prompt, resolution, images.image_1)
                        │positive │negative │latent
                        ▼         ▼         ▼
                     KSampler(latent_image = 编码器 latent) ─► VAEDecode ─► SaveImage
```

- 参考图数量 1–10，键名依次 `images.image_1` … `images.image_10`。
- `resolution=0` 表示沿用参考图原尺寸；非 0 时编码器按 `resolution×resolution` 近似并保持比例、对齐到 32 的倍数。
- 默认 `width`/`height` 不参与计算，所以后端对 image_edit 记录 `null`。

### Turbo 的固定 sigma 表

`ManualSigmas.sigmas` 固定为 8 步：

```
1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0
```

所以 Turbo **不可调步数**，注册表里 `capabilities.exposes_steps: false`，前端显示"步数固定 8 步，由 sigma 表决定，不可调"而不是放一个无效的输入框。Turbo 走 `SamplerCustomAdvanced(noise=RandomNoise, guider=CFGGuider(cfg=1), sampler=KSamplerSelect(euler), sigmas=ManualSigmas, latent_image=…)`，不使用 `KSampler`。

## 参数映射表

| API 参数 | 文生图落点 | 编辑落点 |
| --- | --- | --- |
| `prompt` | `TextEncodeQwenImage21.prompt` | 同左 |
| `width` / `height` | `EmptyLatentImage.width/height` | 不生效（记 `null`） |
| `seed` | `KSampler.seed` / `RandomNoise.noise_seed` | 同左 |
| `steps` | `KSampler.steps`（turbo 不可调） | 同左 |
| `cfg` | `KSampler.cfg` / `CFGGuider.cfg` | 同左 |
| `sampler` | `KSampler.sampler_name` / `KSamplerSelect.sampler_name` | 同左 |
| `denoise` | `KSampler.denoise`（默认 1.0） | 同左 |
| 参考图 | — | `LoadImage.image` → `images.image_N` |
| 文件名 | `SaveImage.filename_prefix` | 同左 |

`filename_prefix` 由 Worker 生成为 `miraforge/g{generation_id}_t{task_id}`，便于按 task 归集产物；结果通过 `GET /history/{prompt_id}` 的 `outputs[node_id].images[]` 取 `filename`/`subfolder`/`type`，再用 `GET /view` 下载。

落盘路径为 `storage/images/{generation_id}/{task_id}_{序号}.png`，`images` 表记录相对路径（不带 storage 前缀），因此整个项目目录可以整体搬迁。

## 参数绑定配置

节点 id 只出现在 `backend/workflow_configs/*.yaml` 里，Python 代码里没有硬编码节点：

```yaml
output_node: "13"

reference_image:              # 仅编辑类工作流有这一段
  loader_node: "1"
  loader_input: image
  encoder_node: "6"
  encoder_input: images.image_1

bindings:
  prompt: { node: "5", input: prompt }
  seed:   { node: "7", input: noise_seed }
```

`build_prompt()` 会把参数写进 `bindings` 指定的落点，落点不存在时直接报错：
`参数 X 的落点 a.b 在工作中不存在（该类节点的输入为：…）`——避免悄悄生成一张参数没生效的图。
换工作流只需换 YAML，不用改代码。

## 实测结果（RTX 5070 Ti 16 GB，1024×1024）

| 模型 | 任务数 | 单张耗时 | 说明 |
| --- | --- | --- | --- |
| `qwen_image_21`（25 步） | 4 | 首张 12.1 s，其后 9.7 / 9.8 / 9.9 s | int8 权重 + 8.9 GB 文本编码器 |
| `qwen_image_21_turbo`（8 步） | 3 | 6.3 / 3.9 / 6.3 s | 冷启动首张约 10 s |

产物由 `GET /history/{prompt_id}` 的 `outputs["13"]["images"][0]` 给出，`metadata` 自带 `width`/`height`，无需解析 PNG 头。

## 已验证 / 待验证

已验证：

1. 展平后的图能通过 `POST /prompt` 的 `validate_prompt`；文生图**省略 `images` 输入合法**（`TextEncodeQwenImage21.images` 的 AUTOGROW `min=0`，全缺省时置空字典）。
2. `/ws` 的 `{"type":"progress","data":{"value","max","prompt_id","node"}}` 能驱动 0–100 进度；二进制预览帧需忽略。
3. `SaveImage` 节点 id 即 `outputs` 的键，与配置里的 `output_node` 一致。
4. 25 步与 turbo 8 步在相同 prompt 下均可正常出图（质量差异待人工评估）。

待验证：

1. 编辑图经 `POST /prompt` 的真实执行（需先解决参考图上传，P4）。
2. 连续多任务时显存是否稳定（P3 批量 8 张压力测试）。
3. PE 支路（9 GB 编码器）在 16 GB 显存下的可行性——一期不启用。

## 提示词增强（PE，一期关闭）

官方模板在 `prompt` 前插了一条可选支路：9B 的 `qwen3.5_9b_qwen_image_2.1_pe_*` 文本编码器 + `TextGenerate` 改写提示词，再用 `ComfySwitchNode(switch)` 决定走原句还是改写句。

一期**关闭**（`switch=false`，即直接用用户原句），但保留开关位：

- 位置：文生图接 `TextEncodeQwenImage21.prompt`，编辑接编辑编码器的 `prompt`。
- 打开成本：多加载 9 GB 编码器，16 GB 显存下会显著挤占并增加耗时。
- 待一期跑通后再决定是否作为可选项暴露给前端。

## 新增一个模型需要做什么

1. 在 ComfyUI 里把工作流导出成 **API 格式**（不是 UI 格式），得到扁平的节点字典。
2. 放进 `backend/workflows/<name>.json`，节点 id 可以随意，但要在 YAML 里引用。
3. 写 `backend/workflow_configs/<name>.yaml`：`output_node` + `bindings` +（编辑类）`reference_image`。
4. 在 `registry.yaml` 的 `models:` 下加条目，`json` / `config` 指向上面两个文件。
5. 刷新 `/api/v1/models` 即可看到新模型；前端下拉自动出现，无需改代码。
6. 真实跑通后把该工作流的 `validated` 改成 `true`。
