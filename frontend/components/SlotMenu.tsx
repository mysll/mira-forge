"use client";

/**
 * 加图片时先问一句「从哪来」。
 *
 * 直接弹系统文件框会把「用刚生成的那张图」这条最常见的路径藏起来；
 * 而一上来就拉资产列表又会让单纯想上传本地文件的人白等一次请求。
 * 所以默认只出这两个选项，资产列表等用户真的选了才去取。
 */
export default function SlotMenu({
  open,
  align = "left",
  placement = "up",
  onUpload,
  onPickAsset,
}: {
  open: boolean;
  align?: "left" | "right";
  /** up：贴着底部的输入框向上弹；down：顶部工具栏向下弹 */
  placement?: "up" | "down";
  onUpload: () => void;
  onPickAsset: () => void;
}) {
  if (!open) {
    return null;
  }

  return (
    <div
      role="menu"
      className={[
        "absolute z-30 w-36 overflow-hidden rounded-lg border border-edge bg-surface p-1 shadow-pop",
        placement === "down" ? "top-full mt-1" : "bottom-full mb-2",
        align === "right" ? "right-0" : "left-0",
      ].join(" ")}
    >
      <button
        type="button"
        role="menuitem"
        onClick={onUpload}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink transition hover:bg-white/[0.06]"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-muted" fill="none" aria-hidden>
          <path
            d="M12 16V4m0 0L8 8m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        从本机上传
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={onPickAsset}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink transition hover:bg-white/[0.06]"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-muted" fill="none" aria-hidden>
          <path
            d="M4 6.5A1.5 1.5 0 0 1 5.5 5h4l1.5 2h7.5A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-11Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
        从资产选
      </button>
    </div>
  );
}
