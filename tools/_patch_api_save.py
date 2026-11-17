import pathlib
p = pathlib.Path("lib/api.ts")
s = p.read_text(encoding="utf-8")

anchor = '''/** 只校验类型与尺寸，返回原字节。 */'''
if anchor not in s:
    raise SystemExit("anchor missing")

add = '''/** 本地编辑器「保存到资产」的返回。 */
export type LocalEditSaved = {
  generation_id: number;
  image_id: number;
  width: number;
  height: number;
  file_size: number;
};

/** 把编辑器导出的成品存进资产库（后端起一条 local_edit 记录，与生成图同构）。 */
export async function saveEditedImage(
  blob: Blob,
  options: { sourceImageId?: number; prompt?: string } = {},
): Promise<LocalEditSaved> {
  const form = new FormData();
  form.append("image", new File([blob], "edited.png", { type: "image/png" }));
  if (options.sourceImageId) {
    form.append("source_image_id", String(options.sourceImageId));
  }
  if (options.prompt) {
    form.append("prompt", options.prompt);
  }
  const { blob: body } = await postImage("/editor/save", form);
  return (await JSON.parse(await body.text())) as LocalEditSaved;
}

'''
s = s.replace(anchor, add + anchor, 1)
p.write_text(s, encoding="utf-8")
print("ok")
