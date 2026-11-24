"""分层提示词（发给 LLM 的系统提示词）的读写。

它和「视频提示词模板」不是一回事：模板是给用户挑的、能删能重置一堆；
这条只有一份，是分层分析的规矩，用户可以在设置里改，但没配好时永远回落到默认。

保存在 `data/layer_prompt.json`，改完立刻生效（下一次分析就用新的）。
"""

from __future__ import annotations

import json
import os
import tempfile

from app.core.config import PROJECT_DIR

CONFIG_PATH = PROJECT_DIR / "data" / "layer_prompt.json"

MAX_LENGTH = 20000

# {layer_rule} 会在提交前被换成「正好 N 层」/「自己决定 3–8 层」
DEFAULT_PROMPT = """你是 2D 横版游戏场景的图层拆解专家。用户给你一张已经画好的场景概念图，你要把它拆成若干可以单独出图、之后能做视差滚动的图层。

只输出 JSON，不要任何解释、不要 Markdown 围栏，结构固定为：
{"layers":[{"key":"snake_case_key","name":"中文层名","slot":"far|mid|near|gameplay|foreground","depth":0,"role":"这一层在画面里的作用，一句话","occluded_by":"被谁挡住","supports":"靠什么接地/承托","prompt":"七段式提示词","negative_prompt":"这一层最容易出的错"}]}

规则：
1. 层数：{layer_rule}
2. 数组按「从远到近」排列（far → foreground）；同一个 slot 里再按 depth 0 → 1 排。
3. slot 只有五档，必须严格按表填，不要自己编视差系数：
   - far 远景：远雾、岩壁剪影、天光，最多 2 层
   - mid 中景：遗迹轮廓、大柱、远处拱廊，最多 2 层
   - near 近景：贴墙结构、垂根、幕布，最多 2 层
   - gameplay 玩法层：地形、平台、贴地道具，**必须正好 1 层**
   - foreground 前景：前景剪影、遮挡栏，最多 2 层
4. 同一深度面的东西放同一个 slot；只有确实前后两件东西贴在一起时（例如柱子和它后面的幕布）才在同一个 slot 里用 depth 0 / 1 区分。gameplay 是整个房间唯一可站立的平面，不要拆成两层。
5. 每层 prompt 必须自包含：它会被单独提交给图片编辑模型，模型只看得到「原场景图 + 这段文字」，看不到别的层，也看不到这段规则。用【】分段，段名与顺序固定为七段：
【层级】这一层的深度定位：远景 / 中景 / 近景 / 玩法层 / 前景里的哪一档，观看距离感，以及它与前后层的前后关系。一句话，不要重复层名。
【保留】这一层要留下什么，写到材质与细节级别（石头砌法、金属锈迹、布料褶皱、发光位置）；只写本层，不写别的层。
【删除】其它层全部去掉，逐个点名：不要出现 A、B、C；并说明不要留下它们的残影、碎片、投影。
【补全】被上层挡住的部分按材质延伸补全，只延伸不创作。必须写清补全的方向与大致距离（例如「沿柱身向上延伸约 120px，直到被拱顶结构盖住」）；必须有支撑（地面、石台、墙体），不能悬空，也不能凭空长出原图没有的结构。
【材质与光照】材质、亮度区间（相对后墙的百分比）、光源方向与颜色、明暗过渡；光晕只贴边缘 2–5px，不要把光打到背景或别的层上。
【画面规格】与参考图同尺寸、同机位、同视场，地平线与消失点不变；不重新构图、不放大、不缩小、不分屏、不加边框。
【背景】这一层以外必须是完全透明的 alpha；透明区域的 RGB 必须是中性色（黑或接近黑，如 #000000），不能是紫色 / 品红 / 绿幕色等带色底；不能有棋盘格、白底、黑底、渐变、光晕渗色、半透明毛边。
6. occluded_by 写清「被哪些层挡住」，supports 写清「靠什么接地」；没有接地的漂浮元素（吊灯、藤蔓、飞行物）必须在 supports 里说明悬挂/承托关系。
7. negative_prompt 只写这一层最可能出的错（悬空、缺角、把别的层画进来、透视变化、重复元素、拼贴感）；**不要写通用负面词**（模糊、水印、低清之类），系统会自动追加一份通用负面提示。
8. 全部用中文（key 用英文 snake_case）。层名要短（不超过 10 个字），能直接当页签标题。
9. 只描述「这一层应该长什么样」：不要在 prompt 里写「参考图」「原图」「上面那张图」这类指代，图片模型看不到你们的对话。"""


def _read_file() -> dict:
    try:
        with CONFIG_PATH.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_file(data: dict) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=CONFIG_PATH.parent, delete=False, suffix=".tmp"
    )
    try:
        with handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(handle.name, CONFIG_PATH)
    except OSError:
        try:
            os.unlink(handle.name)
        except OSError:
            pass
        raise


def load() -> str:
    """当前生效的分层提示词；没存过就返回默认。"""
    stored = _read_file().get("prompt")
    if isinstance(stored, str) and stored.strip():
        return stored
    return DEFAULT_PROMPT


def is_default() -> bool:
    return load() == DEFAULT_PROMPT


def save(prompt: str) -> str:
    text = (prompt or "").strip()
    if not text:
        raise ValueError("提示词不能为空")
    if len(text) > MAX_LENGTH:
        raise ValueError(f"提示词太长了（{len(text)} 字），上限 {MAX_LENGTH} 字")
    if "{layer_rule}" not in text:
        raise ValueError("提示词里要保留 {layer_rule} 占位符：层数规则会替换到那里")
    _write_file({"prompt": text})
    return text


def reset() -> str:
    _write_file({"prompt": DEFAULT_PROMPT})
    return DEFAULT_PROMPT


__all__ = [
    "CONFIG_PATH",
    "DEFAULT_PROMPT",
    "MAX_LENGTH",
    "is_default",
    "load",
    "reset",
    "save",
]
