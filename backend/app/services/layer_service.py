"""场景分层：把一张场景图 + 创作者需求交给 LLM，换回一套可编辑的层方案。

分层是**纯文本工作**：LLM 只出语义（层名、作用、视差系数、提示词、遮挡/承托关系），
不出坐标。所以这里没有任何 GPU 调用，分析失败也不影响场景里已有的图。

流程：`create_layer_set` 落一条 analyzing 记录 → 后台线程调 LLM → 校验 →
写 layers + planned（失败则 failed + error_message）。前端轮询即可。

发给 LLM 的系统提示词存在 `data/layer_prompt.json`（设置页可改），不在代码里写死。
"""

from __future__ import annotations

import json
import threading
import time
import traceback
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.projects import get_project
from app.models.database import session_for
from app.models.generation import Generation
from app.models.image import Image
from app.models.layer import Layer, LayerSet, LayerSetStatus
from app.schemas.layer import LayerSetCreate, LayerUpdate
from app.services import layer_prompt_service, llm_client, workflow_service


class LayerError(Exception):
    """分层校验失败（映射成 400/422）。"""


# 背景 / 中景 / 同平面 / 前景的系数区间，既写在提示里也用来校验
_SCROLL_MIN = 0.05
_SCROLL_MAX = 1.30

# 各段的名字，用来检查「七段式」是否齐全
_SEGMENTS = ("【层级】", "【保留】", "【删除】", "【补全】", "【材质与光照】", "【画面规格】", "【背景】")

# 通用负面词：每条层提示词出图时自动追加，LLM 不用重复写
UNIVERSAL_NEGATIVE = (
    "低分辨率，模糊，失焦，噪点，压缩痕迹，水印，签名，文字，字幕，logo，UI 元素，边框，画框，"
    "分屏，拼贴，多视角，构图改变，镜头旋转，放大，缩小，裁切，拉伸变形，重复元素，"
    "透视不一致，光照方向不一致，颜色偏移，棋盘格背景，白底，纯黑底，渐变遮罩，"
    "半透明重影，发丝状毛边，悬空平台，缺失的支撑结构"
)


def merge_negative(*parts: str | None) -> str:
    """把层自带的负向词和通用负面词合并、去重（逗号 / 顿号都当分隔符）。"""
    seen: list[str] = []
    for part in parts:
        if not part:
            continue
        for piece in part.replace("、", "，").replace(",", "，").split("，"):
            item = piece.strip()
            if item and item not in seen:
                seen.append(item)
    return "，".join(seen)


def _layer_rule(layer_count: int) -> str:
    if layer_count <= 0:
        return "由你判断，拆成 3–8 层，够用就好，不要为了多而多"
    return f"必须正好 {layer_count} 层，不多不少"


def _system_prompt(layer_count: int) -> str:
    """取设置页里的提示词，把 {layer_rule} 换成这次要求的层数规则。"""
    return layer_prompt_service.load().replace("{layer_rule}", _layer_rule(layer_count))


def _user_prompt(
    *,
    scene_name: str,
    scene_description: str | None,
    brief: str | None,
    layer_count: int,
    count_per_layer: int,
    image_size: tuple[int, int],
) -> str:
    width, height = image_size
    parts = [
        f"场景：{scene_name}",
        f"参考图尺寸：{width}×{height}（这是游戏要用的画面尺寸，所有层都按它出）",
        "视口与视差参考：游戏视口 1600×900、相机水平行程约 ±118px；"
        "scroll_scale 越大越靠近镜头。",
    ]
    if scene_description:
        parts.append(f"场景说明（美术设定）：{scene_description}")
    if brief:
        parts.append(f"创作者需求（优先满足，但不要违反上面的规则）：{brief}")
    parts.append(f"每层之后会先生成 {count_per_layer} 张候选。请给出完整的层拆解 JSON。")
    return "\n".join(parts)


def _validate_plan(data: dict, layer_count: int) -> list[dict]:
    """把 LLM 输出规整成可落库的层列表；不合规直接抛 LayerError。"""
    layers = data.get("layers")
    if not isinstance(layers, list) or not layers:
        raise LayerError("模型没给出 layers 数组")

    cleaned: list[dict] = []
    seen_keys: set[str] = set()
    for index, raw in enumerate(layers):
        if not isinstance(raw, dict):
            raise LayerError(f"第 {index + 1} 层不是对象")
        name = str(raw.get("name") or "").strip()
        prompt = str(raw.get("prompt") or "").strip()
        if not name:
            raise LayerError(f"第 {index + 1} 层缺少 name")
        if not prompt:
            raise LayerError(f"第 {index + 1} 层（{name}）缺少 prompt")
        present = [segment for segment in _SEGMENTS if segment in prompt]
        if "【保留】" not in present or "【删除】" not in present or "【补全】" not in present:
            missing = "、".join(s for s in ("【保留】", "【删除】", "【补全】") if s not in present)
            raise LayerError(f"第 {index + 1} 层（{name}）的 prompt 缺段：{missing}")
        if len(present) < 5:
            missing = "、".join(s for s in _SEGMENTS if s not in present)
            raise LayerError(f"第 {index + 1} 层（{name}）的 prompt 分段不全（缺 {missing}）")

        key = str(raw.get("key") or f"layer_{index + 1}").strip().lower().replace(" ", "_")
        if key in seen_keys:
            key = f"{key}_{index + 1}"
        seen_keys.add(key)

        try:
            scroll = float(raw.get("scroll_scale", 0.5))
        except (TypeError, ValueError):
            raise LayerError(f"第 {index + 1} 层（{name}）的 scroll_scale 不是数字")
        scroll = min(max(scroll, _SCROLL_MIN), _SCROLL_MAX)

        try:
            z_index = int(raw.get("z_index", -60 + index * 10))
        except (TypeError, ValueError):
            z_index = -60 + index * 10

        cleaned.append(
            {
                "ord": index,
                "key": key[:40],
                "name": name[:60],
                "role": (str(raw.get("role") or "").strip() or None),
                "scroll_scale": round(scroll, 3),
                "z_index": z_index,
                "prompt": prompt,
                "negative_prompt": (str(raw.get("negative_prompt") or "").strip() or None),
                "occluded_by": (str(raw.get("occluded_by") or "").strip() or None),
                "supports": (str(raw.get("supports") or "").strip() or None),
            }
        )

    if layer_count > 0 and len(cleaned) != layer_count:
        raise LayerError(f"要求 {layer_count} 层，模型给了 {len(cleaned)} 层")
    if len(cleaned) > 8:
        raise LayerError(f"层数 {len(cleaned)} 超过上限 8")

    cleaned.sort(key=lambda item: item["z_index"])
    for index, item in enumerate(cleaned):
        item["ord"] = index
    return cleaned


def get_layer_set(db: Session, set_id: int) -> LayerSet:
    layer_set = db.get(LayerSet, set_id)
    if layer_set is None or layer_set.deleted_at is not None:
        raise HTTPException(status_code=404, detail=f"分层方案 {set_id} 不存在")
    return layer_set


def list_layer_sets(db: Session, scene_id: int, limit: int = 20) -> list[LayerSet]:
    statement = (
        select(LayerSet)
        .where(LayerSet.scene_id == scene_id, LayerSet.deleted_at.is_(None))
        .order_by(LayerSet.id.desc())
        .limit(limit)
    )
    return list(db.scalars(statement).all())


def create_layer_set(db: Session, scene_id: int, payload: LayerSetCreate) -> LayerSet:
    image = db.get(Image, payload.source_image_id)
    if image is None or image.deleted_at is not None:
        raise LayerError(f"源图 {payload.source_image_id} 不存在")
    if image.scene_id != scene_id:
        raise LayerError("源图不属于这个场景")
    if workflow_service.get_model(payload.model) is None:
        raise LayerError(f"模型 {payload.model} 不在注册表里")

    layer_set = LayerSet(
        scene_id=scene_id,
        source_image_id=image.id,
        model_name=payload.model,
        layer_count=payload.layer_count,
        count_per_layer=payload.count_per_layer,
        brief=(payload.brief or "").strip() or None,
        negative_prompt=(payload.negative_prompt or "").strip() or None,
        status=LayerSetStatus.ANALYZING.value,
    )
    db.add(layer_set)
    db.commit()
    db.refresh(layer_set)
    return layer_set


def update_layer(db: Session, layer: Layer, payload: LayerUpdate) -> Layer:
    fields = payload.model_dump(exclude_unset=True)
    # 前端输入框清空后 blur 会 PATCH 一个空串上来，别把好好的提示词覆盖掉
    for text_key in ("prompt", "negative_prompt"):
        if text_key in fields and isinstance(fields[text_key], str):
            if not fields[text_key].strip():
                fields.pop(text_key)
    # 指定导出用的那张图：必须是这一层自己出的图，否则会把别的层导出去
    if "selected_image_id" in fields and fields["selected_image_id"] is not None:
        image = db.get(Image, int(fields["selected_image_id"]))
        if image is None or image.deleted_at is not None:
            raise LayerError("这张图已经不在了，刷新一下再选")
        generation = db.get(Generation, image.generation_id) if image.generation_id else None
        if generation is None or generation.layer_id != layer.id:
            raise LayerError("这张图不是这一层出的，不能指定")
    for key, value in fields.items():
        setattr(layer, key, value)
    db.commit()
    db.refresh(layer)
    return layer


def delete_layer_set(db: Session, layer_set: LayerSet) -> None:
    layer_set.deleted_at = datetime.now(timezone.utc)
    db.commit()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def run_analysis(project_id: str, set_id: int) -> None:
    """后台线程：调 LLM → 校验 → 落库。异常一律写进 status=failed。"""
    project = get_project(project_id)
    if project is None:
        return
    session = session_for(project)
    try:
        layer_set = session.get(LayerSet, set_id)
        if layer_set is None:
            return

        started = time.monotonic()
        meta: dict = {"attempts": 0}
        # 前端要按「对话」展示：每条都留下 system / user / 应答原文
        exchange: list[dict] = []
        meta["exchange"] = exchange
        try:
            image = session.get(Image, layer_set.source_image_id) if layer_set.source_image_id else None
            if image is None:
                raise LayerError("源图不见了，重新选一张再分析")
            image_path = project.storage_path / image.file_path
            if not image_path.exists():
                raise LayerError("源图文件不在磁盘上")

            data_uri = llm_client.image_data_uri(image_path)
            scene_name = ""
            scene_description = None
            from app.models.scene import Scene

            scene = session.get(Scene, layer_set.scene_id)
            if scene is not None:
                scene_name = scene.name
                scene_description = scene.description

            user_prompt = _user_prompt(
                scene_name=scene_name,
                scene_description=scene_description,
                brief=layer_set.brief,
                layer_count=layer_set.layer_count,
                count_per_layer=layer_set.count_per_layer,
                image_size=(image.width, image.height),
            )
            system_prompt = _system_prompt(layer_set.layer_count)
            meta["system_prompt_chars"] = len(system_prompt)
            meta["image"] = {"id": image.id, "width": image.width, "height": image.height}

            plan: list[dict] | None = None
            last_error: Exception | None = None
            feedback = ""
            # 同一次分析的两次请求共用一个会话 id（OpenCode Go 靠它做路由/缓存）
            chat_session = uuid.uuid4().hex
            meta["session"] = chat_session
            for attempt in (1, 2):
                meta["attempts"] = attempt
                sent_user = user_prompt + feedback
                entry: dict = {
                    "attempt": attempt,
                    "system": system_prompt,
                    "user": sent_user,
                    "has_image": True,
                    "response": "",
                    "error": None,
                    "duration_ms": None,
                }
                exchange.append(entry)
                attempt_started = time.monotonic()
                try:
                    text, usage = llm_client.chat_json(
                        system=system_prompt,
                        user=sent_user,
                        image=data_uri,
                        session=chat_session,
                    )
                except Exception as error:  # noqa: BLE001 - 记进对话再往上抛
                    entry["error"] = str(error)[:2000]
                    entry["duration_ms"] = int((time.monotonic() - attempt_started) * 1000)
                    meta["duration_ms"] = int((time.monotonic() - started) * 1000)
                    layer_set.llm_meta = json.dumps(meta, ensure_ascii=False)
                    session.commit()
                    raise
                entry["response"] = text[:20000]
                entry["duration_ms"] = int((time.monotonic() - attempt_started) * 1000)
                meta["usage"] = usage
                meta["raw"] = text[:8000]
                try:
                    plan = _validate_plan(llm_client.extract_json(text), layer_set.layer_count)
                    break
                except LayerError as error:
                    last_error = error
                    entry["error"] = f"校验失败：{error}"
                    feedback = (
                        "\n\n上一版不合规：" + str(error) + "。请严格按规则重出新版 JSON，只输出 JSON。"
                    )
                    meta["first_error"] = str(error)
                    layer_set.llm_meta = json.dumps(meta, ensure_ascii=False)
                    session.commit()

            if plan is None:
                raise last_error or LayerError("模型没有给出可用的层方案")

            for item in plan:
                session.add(
                    Layer(
                        set_id=layer_set.id,
                        ord=item["ord"],
                        key=item["key"],
                        name=item["name"],
                        role=item["role"],
                        scroll_scale=item["scroll_scale"],
                        z_index=item["z_index"],
                        prompt=item["prompt"],
                        negative_prompt=item["negative_prompt"],
                        occluded_by=item["occluded_by"],
                        supports=item["supports"],
                        status="draft",
                    )
                )
            meta["duration_ms"] = int((time.monotonic() - started) * 1000)
            layer_set.status = LayerSetStatus.PLANNED.value
            layer_set.layer_count = len(plan)
            layer_set.error_message = None
            layer_set.completed_at = _now()
            layer_set.llm_meta = json.dumps(meta, ensure_ascii=False)
        except Exception as error:  # noqa: BLE001 - 线程里必须吞掉，写状态交给前端
            layer_set.status = LayerSetStatus.FAILED.value
            layer_set.error_message = str(error)[:2000]
            meta["traceback"] = traceback.format_exc()[:2000]
            layer_set.completed_at = _now()
            layer_set.llm_meta = json.dumps(meta, ensure_ascii=False)
        session.commit()
    finally:
        session.close()


def start_analysis(project_id: str, set_id: int) -> None:
    """在线程里跑，接口立刻返回 analyzing；服务重启后残留的 analyzing 由调用方重置。"""
    thread = threading.Thread(
        target=run_analysis, args=(project_id, set_id), name=f"layer-analyze-{set_id}", daemon=True
    )
    thread.start()
