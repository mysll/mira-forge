/** 分层 / 元素输入框共用的高级参数（页面持有，失焦时提交提示词用）。 */
export type EditAdvanced = {
  negative: string;
  seed: string;
  seedMode: "random" | "fixed";
  steps: string;
  cfg: string;
  sampler: string;
};

/** 分层出图默认 CFG：Qwen 编辑模型 2.0 比 1.0 更听提示词，又不至于过饱和 */
export const DEFAULT_EDIT_ADVANCED: EditAdvanced = {
  negative: "",
  seed: "",
  seedMode: "random",
  steps: "",
  cfg: "2",
  sampler: "",
};

/** 参考图下面的遮罩入口（分层 / 元素共用，语义文案由调用方给）。 */
export type MaskAction = {
  /** 已经画过遮罩：参考图旁边多一个遮罩缩略块，点它改、× 清掉 */
  has: boolean;
  onEdit: () => void;
  onClear?: () => void;
  /** 层是「覆盖范围」，元素是「定位框」——鼠标停留时的说明 */
  title?: string;
};
