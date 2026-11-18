/** 模型名的展示文案：注册表里查不到的名字（例如本地编辑器）在这里兜底。 */
const FALLBACK: Record<string, string> = {
  local_editor: "本地编辑器",
  spriteforge: "序列帧工坊",
  framelab: "抽帧台",
};

export function modelLabel(name: string | null | undefined, labels?: Record<string, string>): string {
  if (!name) {
    return "—";
  }
  return labels?.[name] ?? FALLBACK[name] ?? name;
}
