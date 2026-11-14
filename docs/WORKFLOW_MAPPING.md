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
| `qwen_image_21` / text_to_image | `backend/workflows/qwen_image_21_t2i.json` | KSampler 25 步 | 待落地（P2） |
| `qwen_image_21` / image_edit | `backend/workflows/qwen_image_21_edit.json` | KSampler 25 步 | 待落地（P2） |
| `qwen_image_21_turbo` / text_to_image | `backend/workflows/qwen_image_21_turbo_t2i.json` | SamplerCustomAdvanced + 固定 sigma 表 | 待落地（P2） |
| `qwen_image_21_turbo` / image_edit | `backend/workflows/qwen_image_21_turbo_edit.json` | SamplerCustomAdvanced + 固定 sigma 表 | 待落地（P2） |

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

`filename_prefix` 由 Worker 生成为 `miraforge/{generation_id}_{task_id}`，便于按 task 归集产物；结果通过 `GET /history/{prompt_id}` 的 `outputs[node_id].images[]` 取 `filename`/`subfolder`/`type`，再用 `GET /view` 下载。

## 提示词增强（PE，一期关闭）

官方模板在 `prompt` 前插了一条可选支路：9B 的 `qwen3.5_9b_qwen_image_2.1_pe_*` 文本编码器 + `TextGenerate` 改写提示词，再用 `ComfySwitchNode(switch)` 决定走原句还是改写句。

一期**关闭**（`switch=false`，即直接用用户原句），但保留开关位：

- 位置：文生图接 `TextEncodeQwenImage21.prompt`，编辑接编辑编码器的 `prompt`。
- 打开成本：多加载 9 GB 编码器，16 GB 显存下会显著挤占并增加耗时。
- 待一期跑通后再决定是否作为可选项暴露给前端。

## P2 待验证清单

以下都是**必须真实提交一次才能确认**的项，不写进代码前先不假设：

1. 展平后的图能否通过 `POST /prompt` 的 `validate_prompt`（尤其 `images.image_1` 键名与 AUTOGROW）。
2. int8 权重 + 8.9 GB 文本编码器在 16 GB 显存下的单图耗时与峰值显存。
3. `GET /history/{prompt_id}` 中 `outputs` 的 `SaveImage` 节点键名（取决于我们在 JSON 里用哪个 id）。
4. 25 步 KSampler 与 turbo 8 步在相同 prompt 下的实际出图质量差异。
