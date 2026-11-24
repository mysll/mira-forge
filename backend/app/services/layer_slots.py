"""分层的「槽位」：引擎侧只认这几档，LLM 只负责决定每层落到哪一档。

场景图拆出来的层，最终要变成 Godot 里五个 `Parallax2D`（远景/中景/近景/玩法/前景）。
层层自由给系数的话，导出之后还得人肉映射一遍；所以这里把系数、z、每档能放几层
全部固定下来，`layers.slot` 存枚举，`scroll_scale` / `z_index` 由它算出来。
"""

from __future__ import annotations

from dataclasses import dataclass

SLOT_FAR = "far"
SLOT_MID = "mid"
SLOT_NEAR = "near"
SLOT_BEHIND = "behind"
SLOT_GAMEPLAY = "gameplay"
SLOT_FOREGROUND = "foreground"


@dataclass(frozen=True)
class SlotSpec:
    key: str
    label: str
    # 视差系数（同槽位的层用同一个系数，物理上就是同一个深度面）
    scroll: float
    # z 基准：槽内第 n 层用 z + n*2
    z: int
    # 这一档最多放几层
    limit: int
    content: str


SLOTS: dict[str, SlotSpec] = {
    SLOT_FAR: SlotSpec(SLOT_FAR, "远景", 0.08, -40, 2, "远雾、岩壁剪影、天光"),
    SLOT_MID: SlotSpec(SLOT_MID, "中景", 0.28, -30, 2, "遗迹轮廓、大柱、远处拱廊"),
    SLOT_NEAR: SlotSpec(SLOT_NEAR, "近景", 0.58, -20, 2, "贴墙结构、垂根、幕布"),
    # 和玩法层同一个深度面（不视差），只是画在地形后面：墙、柱、贴地装饰
    SLOT_BEHIND: SlotSpec(SLOT_BEHIND, "底层美术", 1.0, -10, 3, "玩法层后面的墙面、柱、装饰"),
    SLOT_GAMEPLAY: SlotSpec(SLOT_GAMEPLAY, "玩法层", 1.0, 0, 1, "地形、平台、贴地道具"),
    SLOT_FOREGROUND: SlotSpec(SLOT_FOREGROUND, "前景", 1.12, 20, 2, "前景剪影、遮挡栏"),
}

SLOT_ORDER: tuple[str, ...] = (
    SLOT_FAR,
    SLOT_MID,
    SLOT_NEAR,
    SLOT_BEHIND,
    SLOT_GAMEPLAY,
    SLOT_FOREGROUND,
)

# LLM / 老数据可能写成中文或别的英文词
_ALIASES = {
    "far": SLOT_FAR,
    "bg": SLOT_FAR,
    "background": SLOT_FAR,
    "backdrop": SLOT_FAR,
    "远景": SLOT_FAR,
    "背景": SLOT_FAR,
    "后景": SLOT_FAR,
    "mid": SLOT_MID,
    "middle": SLOT_MID,
    "中景": SLOT_MID,
    "near": SLOT_NEAR,
    "近景": SLOT_NEAR,
    "behind": SLOT_BEHIND,
    "back_art": SLOT_BEHIND,
    "art": SLOT_BEHIND,
    "底层": SLOT_BEHIND,
    "底层美术": SLOT_BEHIND,
    "玩法层后": SLOT_BEHIND,
    "gameplay": SLOT_GAMEPLAY,
    "play": SLOT_GAMEPLAY,
    "terrain": SLOT_GAMEPLAY,
    "玩法": SLOT_GAMEPLAY,
    "玩法层": SLOT_GAMEPLAY,
    "foreground": SLOT_FOREGROUND,
    "front": SLOT_FOREGROUND,
    "fg": SLOT_FOREGROUND,
    "前景": SLOT_FOREGROUND,
}


def normalize_slot(value: str | None) -> str | None:
    """把各种写法归一到枚举；认不出来返回 None（交给调用方决定是报错还是猜）。"""
    if not value:
        return None
    return _ALIASES.get(str(value).strip().lower())


def slot_for_scroll(scroll_scale: float | None) -> str:
    """按老数据的 scroll_scale 落槽（没有 slot 字段时的迁移/兼容路径）。"""
    try:
        scroll = float(scroll_scale if scroll_scale is not None else 1.0)
    except (TypeError, ValueError):
        scroll = 1.0
    if scroll < 0.15:
        return SLOT_FAR
    if scroll < 0.45:
        return SLOT_MID
    if scroll < 0.75:
        return SLOT_NEAR
    if scroll <= 1.02:
        return SLOT_GAMEPLAY
    return SLOT_FOREGROUND


def resolve_slot(slot: str | None, scroll_scale: float | None = None) -> str:
    """LLM 给了 slot 就用它；没给就按 scroll 猜；都认不出来再报错。"""
    normalized = normalize_slot(slot)
    if normalized:
        return normalized
    if scroll_scale is not None:
        return slot_for_scroll(scroll_scale)
    raise ValueError(f"不知道这一层属于哪个槽位：{slot!r}")


def slot_spec(slot: str) -> SlotSpec:
    return SLOTS[slot]


def slot_scroll(slot: str) -> float:
    return SLOTS[slot].scroll


def slot_z(slot: str, depth: int = 0) -> int:
    """槽内第 depth 层：同一深度面，z 往上抬 2，越靠后画。"""
    return SLOTS[slot].z + max(0, min(depth, 5)) * 2


def slot_label(slot: str) -> str:
    spec = SLOTS.get(slot)
    return spec.label if spec else slot


def slot_max(slot: str) -> int:
    return SLOTS[slot].limit


__all__ = [
    "SLOTS",
    "SLOT_BEHIND",
    "SLOT_FAR",
    "SLOT_FOREGROUND",
    "SLOT_GAMEPLAY",
    "SLOT_MID",
    "SLOT_NEAR",
    "SLOT_ORDER",
    "SlotSpec",
    "normalize_slot",
    "resolve_slot",
    "slot_for_scroll",
    "slot_label",
    "slot_max",
    "slot_scroll",
    "slot_spec",
    "slot_z",
]
