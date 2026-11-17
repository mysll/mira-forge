import pathlib
p = pathlib.Path("tests/test_editor.py")
s = p.read_text(encoding="utf-8")
s = s.replace('''        source = store_image(
            session,
            content=_sprite(),
            generation_id=generation_id,
            task_id=task.id,
            index=0,
        )
        source_id = source.id
    finally:''', '''        source = store_image(
            session,
            content=_sprite(),
            generation_id=generation_id,
            task_id=task.id,
            index=0,
        )
        session.commit()
        source_id = source.id
    finally:''')
p.write_text(s, encoding="utf-8")
print("ok")
