import pathlib

p = pathlib.Path("app/models/generation.py")
s = p.read_text(encoding="utf-8")
s = s.replace('''    # 视频（二期）：首帧 / 尾帧都可选，两张都不给就是纯文生视频''', '''    # 本地编辑器保存的成品：不用模型、不排队，直接是一条已完成记录
    LOCAL_EDIT = "local_edit"
    # 视频（二期）：首帧 / 尾帧都可选，两张都不给就是纯文生视频''')
p.write_text(s, encoding="utf-8")

p = pathlib.Path("app/api/generations.py")
s = p.read_text(encoding="utf-8")
s = s.replace('_IMAGE_TYPES = ("text_to_image", "image_to_image", "image_edit")', '_IMAGE_TYPES = ("text_to_image", "image_to_image", "image_edit", "local_edit")')
p.write_text(s, encoding="utf-8")
print("ok")
