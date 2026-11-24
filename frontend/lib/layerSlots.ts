/** 分层槽位：前端只显示标签，系数与 z 由后端按槽位算。 */
import type { LayerSlot } from "@/types/api";

export type LayerSlotMeta = {
  key: LayerSlot;
  label: string;
  scroll: number;
  hint: string;
};

export const LAYER_SLOTS: LayerSlotMeta[] = [
  { key: "far", label: "远景", scroll: 0.08, hint: "远雾、岩壁剪影、天光" },
  { key: "mid", label: "中景", scroll: 0.28, hint: "遗迹轮廓、大柱、远处拱廊" },
  { key: "near", label: "近景", scroll: 0.58, hint: "贴墙结构、垂根、幕布" },
  { key: "behind", label: "底层美术", scroll: 1.0, hint: "玩法层后面的墙、柱、贴地装饰（不视差）" },
  { key: "gameplay", label: "玩法层", scroll: 1.0, hint: "地形、平台、贴地道具" },
  { key: "foreground", label: "前景", scroll: 1.12, hint: "前景剪影、遮挡栏" },
];

export function layerSlotLabel(slot: string | null | undefined): string {
  return LAYER_SLOTS.find((item) => item.key === slot)?.label ?? "未分档";
}

export function layerSlotMeta(slot: string | null | undefined): LayerSlotMeta | undefined {
  return LAYER_SLOTS.find((item) => item.key === slot);
}
