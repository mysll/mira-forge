import pathlib
p = pathlib.Path("app/schemas/generation.py")
s = p.read_text(encoding="utf-8")
s = s.replace('''class TaskRead(TimestampedModel):
    id: int
    generation_id: int
    seed: int''', '''class TaskRead(TimestampedModel):
    id: int
    generation_id: int
    # 本地编辑不采样，所以 seed 可能为空
    seed: int | None = None''')
p.write_text(s, encoding="utf-8")
print("ok")
