import pathlib
p = pathlib.Path("app/api/editor.py")
s = p.read_text(encoding="utf-8")

s = s.replace('''"""本地图片编辑器接口。

与生成式图片编辑（`/generations/edit`，走 ComfyUI）完全分开：
这里的操作是确定性的、秒级返回、不占用 GPU、不产生新的生成记录。
"""''', '''"""本地图片编辑器接口。

与生成式图片编辑（`/generations/edit`，走 ComfyUI）完全分开：
这里的操作是确定性的、秒级返回、不占用 GPU。除了 `/editor/save`
会把成品存进资产库（建一条 `local_edit` 记录），其余都是无状态处理。
"""''')

s = s.replace('''from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile, status
from starlette.concurrency import run_in_threadpool
''', '''from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.models.database import get_db
from app.models.image import Image
from app.schemas.editor import LocalEditSaved
from app.services.generation_service import create_local_edit
''')

s = s.rstrip() + '''


@router.post("/save", response_model=LocalEditSaved, status_code=status.HTTP_201_CREATED)
async def save_edited_image(
    file: UploadFile = File(...),
    source_image_id: int | None = Form(None),
    prompt: str | None = Form(None),
    db: Session = Depends(get_db),
) -> LocalEditSaved:
    """把编辑器导出的 PNG 存进资产库。

    存成 `local_edit` 类型的一条已完成记录：不用模型、不排队、不碰 GPU，
    但在作品流、资产库、收藏与删除上的行为和生成出来的图完全一致。
    """
    content = await _read_image(file)
    loaded = await run_in_threadpool(load_image, content)

    source: Image | None = None
    if source_image_id is not None:
        source = db.scalar(select(Image).where(Image.id == source_image_id))

    label = (prompt or "").strip()
    if not label:
        label = "本地编辑"
        if source is not None:
            label = f"本地编辑 · 来自图 #{source.id}"

    generation, image = await run_in_threadpool(
        create_local_edit,
        db,
        content=content,
        width=loaded.width,
        height=loaded.height,
        prompt=label[:500],
        source_image=source,
    )
    return LocalEditSaved(
        generation_id=generation.id,
        image_id=image.id,
        width=image.width,
        height=image.height,
        file_size=image.file_size,
    )
'''
p.write_text(s, encoding="utf-8")
print("ok")
