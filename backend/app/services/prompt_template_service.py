"""视频提示词模板的读写与默认值。

默认模板是给「2D 游戏角色动作 → 抽帧做序列帧」用的：侧视、朝右、定点、镜头
不动。所有模板都是普通文本，用户可以在设置里增删改。
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.prompt_template import PromptTemplate

# 动作描述之外的那半句：这一批模板共用的镜头与朝向约束
_COMMON = (
    "2D game sprite animation for frame-by-frame extraction, strict side view with the character facing right, "
    "full body always inside the frame, fixed camera and fixed framing, the character stays in the exact same spot "
    "and never travels forward or sideways, no camera movement, no zoom, no rotation, even soft lighting, "
    "clean uncluttered background, consistent proportions, outfit and colors"
)

_LABEL_LIMIT = 40
_PROMPT_LIMIT = 2000


def _template(label: str, action: str) -> dict[str, str]:
    return {"label": label, "prompt": f"{action}, {_COMMON}."}


DEFAULT_TEMPLATES: list[dict[str, str]] = [
    _template("待机", "A character standing idle, subtle breathing and a small weight shift, arms relaxed"),
    _template(
        "走路",
        "A character walking in place, steady walk cycle with alternating steps, arms swinging naturally, "
        "feet lift and land without moving forward",
    ),
    _template(
        "跑步",
        "A character running in place, fast run cycle, torso leaning forward, arms pumping, legs cycling quickly",
    ),
    _template(
        "攻击",
        "A character attacking with a quick sword swing, wind-up then strike, feet planted, "
        "no forward step, returns to a guard stance",
    ),
    _template(
        "跳跃",
        "A character jumping straight up in place, crouch, take-off, legs tucked in mid-air, "
        "lands back at the same position",
    ),
    _template(
        "下落",
        "A character falling in place, arms raised, legs trailing, hair and clothes lifted by the fall, "
        "vertical drop with no sideways drift",
    ),
    _template(
        "受伤",
        "A character taking a hit, flinching backward, head snapping back, brief stagger, feet stay planted",
    ),
    _template(
        "死亡",
        "A character collapsing to the ground, knees buckle, drops backward and lies still, "
        "one single motion that does not loop",
    ),
    _template(
        "翻滚",
        "A character dodging with a roll in place, tuck, roll over the shoulder, come back up to a crouch, "
        "ends facing right at the same spot",
    ),
]


class TemplateError(ValueError):
    """模板内容不合法。"""


def _clean(label: str, prompt: str) -> tuple[str, str]:
    text = label.strip()
    body = prompt.strip()
    if not text:
        raise TemplateError("模板名字不能为空")
    if not body:
        raise TemplateError("模板提示词不能为空")
    if len(text) > _LABEL_LIMIT:
        raise TemplateError(f"模板名字最多 {_LABEL_LIMIT} 个字")
    if len(body) > _PROMPT_LIMIT:
        raise TemplateError(f"模板提示词最多 {_PROMPT_LIMIT} 个字")
    return text, body


def list_templates(db: Session) -> list[PromptTemplate]:
    statement = select(PromptTemplate).order_by(PromptTemplate.sort_order, PromptTemplate.id)
    return list(db.scalars(statement))


def seed_defaults(db: Session) -> int:
    """表里一条都没有时塞入默认模板（已有内容就什么都不做）。"""
    existing = db.scalar(select(func.count()).select_from(PromptTemplate)) or 0
    if existing:
        return 0
    for index, item in enumerate(DEFAULT_TEMPLATES):
        db.add(PromptTemplate(label=item["label"], prompt=item["prompt"], sort_order=index))
    db.commit()
    return len(DEFAULT_TEMPLATES)


def reset_defaults(db: Session) -> list[PromptTemplate]:
    """清空并恢复默认（设置页的「恢复默认」按钮）。"""
    for item in db.scalars(select(PromptTemplate)):
        db.delete(item)
    db.flush()
    for index, item in enumerate(DEFAULT_TEMPLATES):
        db.add(PromptTemplate(label=item["label"], prompt=item["prompt"], sort_order=index))
    db.commit()
    return list_templates(db)


def _next_order(db: Session) -> int:
    largest = db.scalar(select(func.max(PromptTemplate.sort_order)))
    return 0 if largest is None else int(largest) + 1


def create_template(db: Session, label: str, prompt: str) -> PromptTemplate:
    name, body = _clean(label, prompt)
    item = PromptTemplate(label=name, prompt=body, sort_order=_next_order(db))
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def update_template(
    db: Session, template: PromptTemplate, label: str | None, prompt: str | None
) -> PromptTemplate:
    name, body = _clean(
        label if label is not None else template.label,
        prompt if prompt is not None else template.prompt,
    )
    template.label = name
    template.prompt = body
    db.commit()
    db.refresh(template)
    return template
