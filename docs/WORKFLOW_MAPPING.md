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

## 图片目标工作流

| 注册表条目 | 文件 | 采样方式 | 状态 |
| --- | --- | --- | --- |
| `qwen_image_21` / text_to_image | `backend/workflows/qwen_image_21_t2i.json` | KSampler 25 步 | ✅ 真实出图验证（4 张） |
| `qwen_image_21` / image_edit | `backend/workflows/qwen_image_21_edit.json` | KSampler 25 步 | ✅ 真实编辑验证（2 张，约 12 s/张） |
| `qwen_image_21` / image_to_image | `backend/workflows/qwen_image_21_i2i.json` | KSampler 25 步 | ✅ 结构验证（同一套节点，仅 latent 换成 EmptyLatentImage） |
| `qwen_image_21_turbo` / text_to_image | `backend/workflows/qwen_image_21_turbo_t2i.json` | SamplerCustomAdvanced + 固定 sigma 表 | ✅ 真实出图验证（多张） |
| `qwen_image_21_turbo` / image_edit | `backend/workflows/qwen_image_21_turbo_edit.json` | SamplerCustomAdvanced + 固定 sigma 表 | ✅ 真实编辑验证（多张，3–6 s/张） |
| `qwen_image_21_turbo` / image_to_image | `backend/workflows/qwen_image_21_turbo_i2i.json` | SamplerCustomAdvanced + 固定 sigma 表 | ✅ 真实出图验证（1 张 / 2 张参考图） |
| `z_image_turbo` / text_to_image | `backend/workflows/z_image_turbo_t2i.json` | KSampler 8 步 + ModelSamplingAuraFlow(shift 3) | ✅ 真实出图验证（1024²，10.1 s） |
| `flux2_klein_distilled` / text_to_image | `backend/workflows/flux2_klein_distilled_t2i.json` | SamplerCustomAdvanced + Flux2Scheduler(4 步) | ✅ 真实出图验证（1024²，8.1 s） |
| `flux2_klein_base` / text_to_image | `backend/workflows/flux2_klein_base_t2i.json` | SamplerCustomAdvanced + Flux2Scheduler(20 步) | ✅ 真实出图验证（1024²，14.2 s） |

四张图都已通过 MiraForge 的 `POST /prompt` 真实跑通，注册表里 `validated: true`。编辑链路的参考图由 Worker 先 `POST /upload/image` 送进 ComfyUI 的 `input/`，再写进 `LoadImage.image`。

## Z-Image 与 FLUX.2 Klein（另外三套文生图）

三个新模型都是**纯数据接入**：只加了 3 个 JSON、3 个 YAML 和 registry 里的 3 个条目，`prompt_builder` / Worker / 前端代码一行没改。

| 模型 | 权重 | 文本编码器 | VAE | 采样 |
| --- | --- | --- | --- | --- |
| Z-Image Turbo | `z_image_turbo_int8_convrot` | `qwen_3_4b_fp8_mixed`（`type=lumina2`） | `ae` | KSampler，8 步，cfg 1.0，`res_multistep` + `simple` |
| Klein 4B Distilled | `flux-2-klein-4b-fp8` | `qwen_3_4b`（`type=flux2`） | `flux2-vae` | Flux2Scheduler 4 步，cfg 1.0，euler |
| Klein 4B Base | `flux-2-klein-base-4b-fp8` | `qwen_3_4b`（`type=flux2`） | `flux2-vae` | Flux2Scheduler 20 步，cfg 5.0，euler |

### Z-Image-Turbo 链路

```
UNETLoader(z_image_turbo_int8_convrot) ─► ModelSamplingAuraFlow(shift 3.0) ─┐
CLIPLoader(qwen_3_4b_fp8_mixed, lumina2) ─► CLIPTextEncode(prompt) ─────────┤
                                            └► ConditioningZeroOut ────────┤ negative
VAELoader(ae) ──────────────────────────────────────────────────────────────┤
EmptySD3LatentImage(width, height) ─────────────────────────────────────────┴─► KSampler
   (8 步 / cfg 1.0 / res_multistep / simple) ─► VAEDecode ─► SaveImage
```

- 潜空间必须用 `EmptySD3LatentImage`：Lumina2 的 latent 是 16 通道、8 倍下采样，节点里 `width`/`height` 的 step 是 16（前端尺寸面板正好按 16 对齐）。
- 负面提示词在这套图里**是被架空的**：官方模板用 `ConditioningZeroOut` 把正向条件零化当负向，cfg 又是 1.0（ComfyUI 在 cfg≈1 时直接跳过 uncond 分支）。所以 registry 里 `exposes_negative_prompt: false`、`exposes_steps/cfg: false`，前端不会出现这三个控件。

### FLUX.2 Klein 链路

```
UNETLoader(flux-2-klein-*) ─────────────► CFGGuider(positive, negative, cfg) ─┐
CLIPLoader(qwen_3_4b, flux2) ─► CLIPTextEncode(prompt) ──► positive ─────────┤
                              └► CLIPTextEncode(neg) / ConditioningZeroOut ─► negative
PrimitiveInt(width) ─┬─► EmptyFlux2LatentImage ──────────────────────────────┤
PrimitiveInt(height) ┤        (128 通道、16 倍下采样)                        │
                     └─► Flux2Scheduler(steps, width, height) ─► SIGMAS ─────┤
RandomNoise(seed) ─► NOISE ──────────────────────────────────────────────────┤
KSamplerSelect(euler) ─► SAMPLER ────────────────────────────────────────────┴─► SamplerCustomAdvanced
   ─► VAEDecode ─► SaveImage
```

- **宽高有两个落点**：`Flux2Scheduler` 要用面积算 sigmas，`EmptyFlux2LatentImage` 要用它定尺寸。YAML 绑定是「一个参数一个落点」，所以在图里插两个 `PrimitiveInt`，让两处都连它，YAML 只绑 `width/height → PrimitiveInt.value`——`prompt_builder` 因此零改动。
- 蒸馏版（`flux2_klein_distilled`）的负向是 `ConditioningZeroOut`、cfg 1.0、4 步；基础版（`flux2_klein_base`）的负向是第二个 `CLIPTextEncode`、cfg 5.0、20 步，负面提示词真的参与计算（正负两个编码器分别进 `CFGGuider.positive/negative`）。
- 两者都**不需要** `scheduler` 绑定：sigmas 由 `Flux2Scheduler` 内部按 `simple` 风格算，YAML 里没有这个键，前端也不显示。
- 接口层面只暴露到「步数 / CFG / 负面提示词」：基础版三个都能调，蒸馏版全锁死（改了只会更差）。

## 两个视频目标工作流（MiniMax H3）

| 注册表条目 | 文件 | 采样方式 | 状态 |
| --- | --- | --- | --- |
| `minimax_h3` / text_to_video | `backend/workflows/minimax_h3_t2v.json` | SamplerCustomAdvanced + BasicScheduler(simple, 6 步) | ✅ 真实出片（3 秒 73 帧约 40 s；5 秒 124 帧 1280×736 约 1 min） |
| `minimax_h3` / image_to_video | `backend/workflows/minimax_h3_i2v.json` | 同上 | ✅ 真实出片（3 秒、5 秒；只给首帧 / 首帧 + 尾帧都验过） |

两套图结构相同，唯一的差别是 i2v 多了 `LoadImage` → `MiniMaxH3ImageToVideo.first_frame / last_frame`。首帧、尾帧都是**可选输入**：缺哪一帧，`prompt_builder` 会把那个输入和对应的 `LoadImage` 节点一起摘掉（两帧都缺时就是纯文生视频），所以不需要为「只给首帧」再准备第三套图。

### 视频链路

```
UNETLoader(minimax_h3_fl2va_pruned_int8_convrot)
  └─► LoraLoaderModelOnly(minimax_h3_fl2v_turbo_8step_v1.0, strength 1.0) ─┐
CLIPLoader(qwen3vl_32b_minimax_h3_nvfp4_awq, type=minimax) ────────────────┤
VAELoader(minimax_h3_video_vae_int8_convrot) ─┐                            │
VAELoader(minimax_h3_audio_vae_fp32) ─────────┼──► MiniMaxH3ImageToVideo ──┤
LoadImage(首帧, 可选) ────────────────────────┤   (prompt/width/height/length)
LoadImage(尾帧, 可选) ────────────────────────┘        ├─ positive ─► BasicGuider
                                                       └─ LATENT ───► SamplerCustomAdvanced
                                                                          ├─► VAEDecode ─► CreateVideo(fps, audio) ─► SaveVideo(.mp4)
                                                                          └─► VAEDecodeAudio ─┘
VAEDecode ─► ImageFromBatch(batch_index 0, length 1) ─► SaveImage(封面帧)
```

- 采样：`RandomNoise` + `BasicGuider(cfg 1.0)` + `KSamplerSelect(res_multistep)` + `BasicScheduler(simple, steps 6, denoise 1.0)`，6 步是 turbo LoRA 的档位。
- **帧数由时长算**，不是自由填：`frames = max(5, round(seconds × fps))`，再补到 `5 + 17k`（模型 `length` 的 step 是 17）。5 秒 24fps → 120 → 124 帧（5.17 s）；3 秒 → 73 帧；1–15 秒任意整数都落在 `5 + 17k` 上。
- **尺寸按「比例 × 档位」算**：前端给 480p / 720p / 1080p 三档，宽高都对齐到 32（如 864×480、1280×736、1920×1088），因为模型的 `width` / `height` step 是 32，1280×720 这种「标准 720p」反而会被拒。
- 声音与画面一起出：`VAEDecodeAudio` 的音频接到 `CreateVideo.audio`，再由 `SaveVideo` 封装成 mp4。
- 封面帧：`ImageFromBatch` 取第 0 帧存成 png，Worker 把它下载下来压成缩略图（视频本身没法用 Pillow 解码），列表里因此有海报图。

### 实测结果（RTX 5070 Ti 16 GB）

| 任务 | 时长 / 帧数 | 分辨率 | 实测耗时 | 峰值显存 |
| --- | --- | --- | --- | --- |
| text_to_video（6 步） | 5 s / 124 帧 | 864×480 | 109 s（首次冷启） | 15.33 GB |
| text_to_video（6 步） | 3 s / 73 帧 | 864×480 | 40 s（模型常驻后） | ~15 GB |
| text_to_video（6 步） | 5 s / 124 帧 | 1280×736 | 161 s | ~15 GB |
| image_to_video（首帧） | 3 s / 73 帧 | 864×480 | 30 s | ~15 GB |
| image_to_video（首帧 + 尾帧） | 3 s / 73 帧 | 864×480 | 35 s | ~15 GB |
| text_to_video × 2 条（串行） | 3 s / 73 帧 ×2 | 864×480 | 55 s | ~15 GB |

720p 的耗时大约是 480p 的 4 倍（像素 2.4 倍 + 注意力随长度平方增长），1080p × 10 秒以上在 16GB 卡上不保证能出——前端在估算偏重时会提示一句，但不拦着（真跑挂了任务会 `failed` 并带 ComfyUI 的报错）。

产物走 `GET /history/{prompt_id}`：`outputs[node]["images"][0]` 的 `metadata` 直接给出 `width` / `height` / `duration` / `fps` / `frame_count`，`animated: true`；扩展名是 `.mp4`。

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
LoadImage#1  (第 1 张：定结构) ─┐
LoadImage#20 (第 2 张：可选)  ─┴─► TextEncodeQwenImage21(clip, vae, prompt, negative_prompt, resolution,
                                                        images.image_1, images.image_2)
                                  │positive │negative │latent
                                  ▼         ▼         ▼
                               KSampler(latent_image = 编码器 latent) ─► VAEDecode ─► SaveImage
```

- 我们只开两个槽位：`images.image_1` ← 节点 `1`，`images.image_2` ← 节点 `20`。节点本身支持 `images.image_1` … `images.image_10`，要加槽位只需在工作流 JSON 里补 `LoadImage` 并在 YAML 的 `loaders` 里追一项。
- **第 1 张决定被编辑的画面**：编码器输出的 latent 是「按第 1 张尺寸的零张量」，`KSampler.latent_image` 直接用它（`["6", 2]`），所以结构、比例、构图都跟着第 1 张；第 2 张只作为补充条件（典型用法：第 1 张角色 + 第 2 张服装）。
- 只给 1 张时，`prompt_builder` 会摘掉 `images.image_2` 并删掉节点 `20`（否则 ComfyUI 会去找模板里的 `placeholder.png`）。
- `resolution=0` 表示沿用参考图原尺寸；非 0 时编码器按 `resolution×resolution` 近似并保持比例、对齐到 32 的倍数。
- 默认 `width`/`height` 不参与计算，所以后端对 image_edit 记录 `null`。

### 参考图引导（图生图）链路

```
LoadImage#20 / LoadImage#21 ─► TextEncodeQwenImage21(clip, vae, prompt, negative_prompt, resolution,
                                                      images.image_1, images.image_2)
                                              │positive │negative │latent(不用)
EmptyLatentImage(width,height,1) ─────────────┴─────────┴─────────┴────► KSampler ─► VAEDecode ─► SaveImage
```

- 与图片编辑**只差潜空间来源**：编辑用编码器的 `latent`（跟随参考图比例），图生图用 `EmptyLatentImage`（宽高生效、参考图只进条件）。
- 参考图槽位固定为 `images.image_1` ← 节点 `20`、`images.image_2` ← 节点 `21`；只给 1 张时 `prompt_builder` 会摘掉 `images.image_2` 并删掉节点 `21`（否则 ComfyUI 会去找模版里的 `placeholder.png`）。
- `resolution` 决定参考图进入编码器前的分辨率，Worker 用 `round(sqrt(w×h)/32)×32`（夹 256–4096）换算。
- 没有"强度/denoise"参数：参考图只影响条件，不控制保留程度。需要"只在原图上改一点"时用图片编辑链路（或二期补经典 img2img：`VAEEncode` + 可调 denoise）。

### Turbo 的固定 sigma 表

`ManualSigmas.sigmas` 固定为 8 步：

```
1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0
```

所以 Turbo **不可调步数**，注册表里 `capabilities.exposes_steps: false`，前端不显示步数输入框，而不是放一个无效的输入框。Turbo 走 `SamplerCustomAdvanced(noise=RandomNoise, guider=CFGGuider(cfg=1), sampler=KSamplerSelect(euler), sigmas=ManualSigmas, latent_image=…)`，不使用 `KSampler`。CFG 与采样器则是**独立于 sigma 表**的参数（分别落在 `CFGGuider.cfg` 与 `KSamplerSelect.sampler_name`），改了真生效，因此 `exposes_cfg` 与 `exposes_sampler` 都是 `true`；只有默认 CFG=1.0 时（cfg1 优化会跳过 uncond 分支）负面提示词不参与采样，而换采样器时用的仍是那张按 euler 调的 8 步表。

## 负面提示词与 CFG

**默认 CFG=1 时，负面提示词完全不参与计算。** ComfyUI 的 `comfy/samplers.py:610`：

```python
def sampling_function(model, x, timestep, uncond, cond, cond_scale, model_options={}, seed=None):
    if math.isclose(cond_scale, 1.0) and model_options.get("disable_cfg1_optimization", False) == False:
        uncond_ = None        # cfg1 优化：负面分支连算都不算
```

`cfg_function`（同文件 598 行）的公式是 `uncond_pred + (cond_pred - uncond_pred) * cond_scale`，把 `cond_scale` 固定成 1 时结果恒等于 `cond_pred`；而上面的 cfg1 优化更彻底——`uncond` 直接置 `None`，`/history` 里还能看到负面的 CONDITIONING 被建过，但它从未进入采样。`SamplerCustomAdvanced` 用的 `CFGGuider.predict_noise`（同文件 1217 行）也转调同一个 `sampling_function`，所以 **Turbo 的 CFGGuider 在 cfg=1 时同样跳过负面**。

注册表因此给每个模型一个建议值：

```yaml
  - id: qwen_image_21
    negative_prompt_cfg: 3.0     # 标准模型：CFG 提到 3.0 画质仍然稳
  - id: qwen_image_21_turbo
    negative_prompt_cfg: 2.0     # 蒸馏模型 CFG 弹性差，3.0 开始过饱和
```

规则（`generation_service.create_generation`）：

| 情况 | 实际使用的 CFG |
| --- | --- |
| 有负面提示词 + 用户没填 CFG | 模型的 `negative_prompt_cfg`（标准 3.0 / Turbo 2.0），并写进 `generation.cfg` |
| 有负面提示词 + 用户显式填了 CFG | 用户的值，原样保留（包括显式 1.0，前端会提示此时不生效） |
| 没有负面提示词 | 模型默认 1.0 |

落库的 `generation.cfg` 永远是**实际生效值**，所以详情弹窗里看到的就是真正跑的那个数。实测确认：`POST /generations` 带负面提示词不填 CFG → 返回 `cfg: 3.0`，并从 `/history` 的 `prompt[2]` 里读到提交给 ComfyUI 的 `KSampler.cfg` 确实是 3.0。

> 注意：本机 ComfyUI **不是逐位可复现的**——同 seed 同参数跑两次，产物 sha256 也不一样（实测 `d6418b44…` vs `217c705b…`）。所以不要用"产物是否完全相同"来判断某个参数有没有生效，要么看 `/history` 里提交的图，要么目视对比。

## 参数映射表

| API 参数 | 文生图落点 | 编辑落点 |
| --- | --- | --- |
| `prompt` | `TextEncodeQwenImage21.prompt` | 同左 |
| `width` / `height` | `EmptyLatentImage.width/height` | 不生效（记 `null`） |
| `seed` | `KSampler.seed` / `RandomNoise.noise_seed` | 同左 |
| `steps` | `KSampler.steps`（turbo 不可调，走固定 sigma 表） | 同左 |
| `cfg` | `KSampler.cfg` / `CFGGuider.cfg`（turbo 也可调） | 同左 |
| `sampler` | `KSampler.sampler_name` / `KSamplerSelect.sampler_name`（turbo 也可调） | 同左 |
| `denoise` | `KSampler.denoise`（默认 1.0） | 同左 |
| 参考图 | — | `LoadImage.image` → `images.image_N` |
| 文件名 | `SaveImage.filename_prefix` | 同左 |

`filename_prefix` 由 Worker 生成为 `miraforge/g{generation_id}_t{task_id}`，便于按 task 归集产物；结果通过 `GET /history/{prompt_id}` 的 `outputs[node_id].images[]` 取 `filename`/`subfolder`/`type`，再用 `GET /view` 下载。

落盘路径为 `storage/images/{generation_id}/{task_id}_{序号}.png`（视频进 `storage/videos/{generation_id}/{task_id}_{序号}.mp4`，封面帧在 `thumbnails/`），`images` 表记录相对路径（不带 storage 前缀），因此整个项目目录可以整体搬迁。

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
| `qwen_image_21` / image_edit | 2 | 约 12 s | 含参考图上传与 latent 来自编码器 |
| `qwen_image_21_turbo` / image_edit | 3 | 3–6 s | 换场景/换主体的指令式编辑 |
| `qwen_image_21_turbo` / image_to_image（1 张参考图） | 1 | 17.4 s | 陶壶原图 → 秋日庭院，器型/角度/光影跟随参考图 |
| `qwen_image_21_turbo` / image_to_image（2 张参考图） | 1 | 15.1 s | 陶壶 + 黄铜台灯同时进同一个庭院石桌场景 |
| `z_image_turbo`（8 步） | 1 | 10.1 s | 首次加载权重（5.78 GB + 5.25 GB 编码器）之后的单张耗时 |
| `flux2_klein_distilled`（4 步） | 1 | 8.1 s | 同样含首次加载；4 步是官方蒸馏档位 |
| `flux2_klein_base`（20 步） | 1 | 14.2 s | 20 步基础版，负面提示词可用 |

图生图的对照实验（同 prompt、同 seed）：带参考图 10.0 s、不带参考图 6.1 s；带参考图那张连树形、苔藓土丘、左下角耙纹走向都跟着参考图，不带参考图则自己编了螺旋纹、石头与远山 —— 说明参考图确实进了条件分支，而不是被忽略。

实测的编辑样例（同一张黄铜狐原图）：

| 指令 | 结果 |
| --- | --- |
| `same scene but at night, moonlight` | 街景与霓虹保留，光线整体转夜 |
| `replace the fox with a white marble statue of a fox` | 主体变白色大理石雕，构图与背景不变 |
| `polished black granite` | 主体材质变黑花岗岩 |

产物由 `GET /history/{prompt_id}` 的 `outputs["13"]["images"][0]` 给出，`metadata` 自带 `width`/`height`，无需解析 PNG 头。

## 已验证 / 待验证

已验证：

1. 展平后的图能通过 `POST /prompt` 的 `validate_prompt`；文生图**省略 `images` 输入合法**（`TextEncodeQwenImage21.images` 的 AUTOGROW `min=0`，全缺省时置空字典）。
2. `/ws` 的 `{"type":"progress","data":{"value","max","prompt_id","node"}}` 能驱动 0–100 进度；二进制预览帧需忽略。
3. `SaveImage` 节点 id 即 `outputs` 的键，与配置里的 `output_node` 一致。
4. 25 步与 turbo 8 步在相同 prompt 下均可正常出图（质量差异待人工评估）。
5. 编辑图四张全部经 `POST /prompt` 真实执行；`images.image_1` 键名、`latent_image=[6,2]`、`resolution` 换算均正确。
6. 批量 8 张串行、中途取消 / 重试、后端强杀后重启续跑均未出现显存问题。
7. 图生图的 `EmptyLatentImage` 潜空间 + `images.image_1/image_2` 双槽位：1 张与 2 张参考图都真实出图；只给 1 张时多余的 `LoadImage` 节点被摘掉，ComfyUI 未报「找不到 placeholder.png」。
8. 视频：`length` 必须落在 `5 + 17k`；t2v、只给首帧、首帧 + 尾帧三种输入都真实出片；`SaveVideo` 的产出是 mp4 且 `metadata.kind == "video"`；封面帧靠 `ImageFromBatch` 单独存一张 png。
9. Z-Image Turbo / Klein Distilled / Klein Base 三套文生图都经 `POST /prompt` 真实出图（1024²，10.1 / 8.1 / 14.2 s）；Klein 的宽高经两个 `PrimitiveInt` 同时喂 `Flux2Scheduler` 与 `EmptyFlux2LatentImage`，两次实测都没出现尺寸不一致；基础版换负面提示词后图确实变了（同 seed 两张输出哈希不同），但因为本机 ComfyUI 本来就不可逐位复现，这一点以「图里有独立的负向编码器 + cfg 5.0」为准。

仍待观察：

0. 视频的峰值显存 15.33 GB 已经贴着 16 GB 上限：如果同时还有图片任务排队，Worker 的串行调度要保证不会两个大模型同时驻留（当前靠单协程串行，实测未出问题）。
1. PE 支路（9 GB 编码器）在 16 GB 显存下的可行性——一期不启用。
2. 16 GB 卡上同时跑编辑 + 大批量的极端情况（目前实测最多 8 张串行）。

## 提示词增强（PE，一期关闭）

官方模板在 `prompt` 前插了一条可选支路：9B 的 `qwen3.5_9b_qwen_image_2.1_pe_*` 文本编码器 + `TextGenerate` 改写提示词，再用 `ComfySwitchNode(switch)` 决定走原句还是改写句。

一期**关闭**（`switch=false`，即直接用用户原句），但保留开关位：

- 位置：文生图接 `TextEncodeQwenImage21.prompt`，编辑接编辑编码器的 `prompt`。
- 打开成本：多加载 9 GB 编码器，16 GB 显存下会显著挤占并增加耗时。
- 待一期跑通后再决定是否作为可选项暴露给前端。

## 新增一个模型需要做什么

视频模型与图片模型的流程一致，但多三件事：`capabilities.media: video`（前端据此把它的创作页放到 `/video`）、`durations` / `resolutions` 两个档位表（校验与下拉都读它）、以及绑定里的 `poster_node`（封面帧输出节点）。

1. 在 ComfyUI 里把工作流导出成 **API 格式**（不是 UI 格式），得到扁平的节点字典。
2. 放进 `backend/workflows/<name>.json`，节点 id 可以随意，但要在 YAML 里引用。
3. 写 `backend/workflow_configs/<name>.yaml`：`output_node` + `bindings` +（编辑类）`reference_image`。
4. 在 `registry.yaml` 的 `models:` 下加条目，`json` / `config` 指向上面两个文件。
5. 刷新 `/api/v1/models` 即可看到新模型；前端下拉自动出现，无需改代码。
6. 真实跑通后把该工作流的 `validated` 改成 `true`。
