import pathlib
p = pathlib.Path("app/api/editor.py")
s = p.read_text(encoding="utf-8")
s = s.replace('''async def save_edited_image(
    file: UploadFile = File(...),''', '''async def save_edited_image(
    image: UploadFile = File(...),''')
s = s.replace('''    content = await _read_image(file)
    loaded = await run_in_threadpool(load_image, content)''', '''    content = await _read_image(image)
    loaded = await run_in_threadpool(load_image, content)''')
p.write_text(s, encoding="utf-8")
print("ok")
