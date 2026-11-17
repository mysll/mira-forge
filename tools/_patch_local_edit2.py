import pathlib
p = pathlib.Path("app/services/generation_service.py")
s = p.read_text(encoding="utf-8")
s = s.replace('''from app.models.generation import Generation, GenerationStatus, GenerationType''', '''from app.models.generation import Generation, GenerationStatus, GenerationType
from app.models.image import Image''')
s = s.replace('''from app.schemas.generation import GenerationCreate
from app.services import workflow_service''', '''from app.schemas.generation import GenerationCreate
from app.services import workflow_service
from app.services.image_service import store_image''')
s = s.rstrip() + '''


def create_local_edit(
    db: Session,
    *,
    content: bytes,
    width: int,
    height: int,
    prompt: str,
    source_image: Image | None = None,
) -> tuple[Generation, Image]:
    """把本地编辑器导出的 PNG 存成一条已完成的作品记录。

    编辑器不经过 ComfyUI，所以这里直接建 generation + 一个已完成 task + 图片行，
    产物与生成出来的图完全同构（同样的目录、同样的 /images 接口、同样的收藏与删除）。
    """
    now = utcnow()
    generation = Generation(
        prompt=prompt,
        generation_type=str(GenerationType.LOCAL_EDIT),
        model_name="local_editor",
        width=width,
        height=height,
        requested_count=1,
        status=GenerationStatus.COMPLETED,
        completed_at=now,
    )
    task = GenerationTask(
        seed=None,
        status=TaskStatus.COMPLETED,
        progress=100,
        started_at=now,
        completed_at=now,
    )
    generation.tasks.append(task)
    db.add(generation)
    db.flush()

    image = store_image(
        db,
        content=content,
        generation_id=generation.id,
        task_id=task.id,
        index=0,
        width=width,
        height=height,
    )
    if source_image is not None:
        image.original_image_id = source_image.id
        generation.reference_image_path = source_image.file_path
    db.commit()
    db.refresh(generation)
    return generation, image
'''
p.write_text(s, encoding="utf-8")
print("ok")
