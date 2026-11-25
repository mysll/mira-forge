"""软删边界与启动迁移的回归测试。

两件事一旦退回去就很难在界面上发现：
- 回收站里的图 / 批次不能被再次收藏、重试、拿去当源图；
- 每次重启不能把用户调过的 layer depth 按 ord 覆盖掉。
"""

from __future__ import annotations

import base64
from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.core.migrations import _backfill_layer_slots
from app.core.projects import active_project
from app.models.database import SessionLocal
from app.models.generation import Generation
from app.models.layer import Layer, LayerSet
from app.models.scene import Scene
from app.models.task import GenerationTask, TaskStatus
from app.services.generation_service import reset_interrupted_tasks
from app.workers.generation_worker import worker

API = "/api/v1"

TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _generation(client: TestClient, count: int = 1) -> dict:
    response = client.post(
        f"{API}/generations",
        json={"prompt": "soft delete probe", "model": "qwen_image_21_turbo", "count": count},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _asset_image(client: TestClient) -> int:
    response = client.post(
        f"{API}/assets",
        files={"file": ("probe.png", TINY_PNG, "image/png")},
        data={"name": "软删探针"},
    )
    assert response.status_code == 201, response.text
    return response.json()["image_id"]


def test_favorite_on_recycled_image_is_404(client: TestClient) -> None:
    image_id = _asset_image(client)
    assert client.delete(f"{API}/images/{image_id}").status_code == 204

    response = client.post(f"{API}/images/{image_id}/favorite", json={"favorite": True})
    assert response.status_code == 404


def test_favorite_returns_the_computed_label(client: TestClient) -> None:
    """收藏返回的是完整 ImageRead：label 漏了前端就会显示成 id。"""
    image_id = _asset_image(client)

    response = client.post(f"{API}/images/{image_id}/favorite", json={"favorite": True})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["is_favorite"] is True
    assert body["label"]


def test_retry_into_recycled_generation_is_409(client: TestClient) -> None:
    """批次进回收站、任务行还活着（旧数据 / 手工修库）：不能再排新任务。"""
    body = _generation(client)
    task_id = body["tasks"][0]["id"]
    client.post(f"{API}/tasks/{task_id}/cancel")

    with SessionLocal() as db:
        generation = db.get(Generation, body["id"])
        assert generation is not None
        generation.deleted_at = datetime.now(timezone.utc)
        db.commit()

    response = client.post(f"{API}/tasks/{task_id}/retry")
    assert response.status_code == 409
    assert "已不存在" in response.json()["detail"]


def test_claim_pending_ignores_recycled_tasks(client: TestClient) -> None:
    body = _generation(client, count=2)
    task_ids = [task["id"] for task in body["tasks"]]

    with SessionLocal() as db:
        for task_id in task_ids:
            task = db.get(GenerationTask, task_id)
            assert task is not None
            task.deleted_at = datetime.now(timezone.utc)
        db.commit()

    claimed = worker._claim_pending(active_project())
    assert claimed not in task_ids

    with SessionLocal() as db:
        for task_id in task_ids:
            task = db.get(GenerationTask, task_id)
            assert task is not None
            assert task.status == TaskStatus.PENDING  # 没被认领走


def test_startup_reset_ignores_recycled_tasks(client: TestClient) -> None:
    body = _generation(client, count=2)
    live_id, gone_id = body["tasks"][0]["id"], body["tasks"][1]["id"]

    with SessionLocal() as db:
        for task_id in (live_id, gone_id):
            task = db.get(GenerationTask, task_id)
            assert task is not None
            task.status = TaskStatus.RUNNING
            task.comfy_prompt_id = "dead-prompt"
        gone = db.get(GenerationTask, gone_id)
        assert gone is not None
        gone.deleted_at = datetime.now(timezone.utc)
        db.commit()

    with SessionLocal() as db:
        reset_interrupted_tasks(db)
        live = db.get(GenerationTask, live_id)
        gone = db.get(GenerationTask, gone_id)
        assert live is not None and gone is not None
        assert live.status == TaskStatus.PENDING
        assert gone.status == TaskStatus.RUNNING  # 回收站里的不动
        assert gone.comfy_prompt_id == "dead-prompt"


def _scene_with_layers(depths: list[int], slot: str = "near", scroll: float = 0.58) -> list[int]:
    with SessionLocal() as db:
        scene = Scene(name="迁移探针")
        db.add(scene)
        db.flush()
        layer_set = LayerSet(scene_id=scene.id, model_name="qwen_image_21_turbo")
        db.add(layer_set)
        db.flush()
        layers = []
        for index, depth in enumerate(depths):
            layer = Layer(
                set_id=layer_set.id,
                ord=index,
                key=f"layer_{index}",
                name=f"第 {index} 层",
                slot=slot,
                depth=depth,
                scroll_scale=scroll,
                z_index=depth * 2,
                prompt="probe",
            )
            db.add(layer)
            layers.append(layer)
        db.commit()
        return [layer.id for layer in layers]


def test_backfill_keeps_user_tuned_depth(client: TestClient) -> None:
    """数据完好时启动迁移一条 UPDATE 都不该执行，depth 原样保留。"""
    layer_ids = _scene_with_layers([1, 0])
    project = active_project()

    _backfill_layer_slots(project)
    _backfill_layer_slots(project)

    with SessionLocal() as db:
        depths = [db.get(Layer, layer_id).depth for layer_id in layer_ids]
    assert depths == [1, 0]


def test_backfill_repairs_legacy_slot_from_scroll(client: TestClient) -> None:
    """0015 之前的老行：slot 是默认值 near，但 scroll_scale 属于 mid。"""
    layer_ids = _scene_with_layers([0], slot="near", scroll=0.3)

    _backfill_layer_slots(active_project())

    with SessionLocal() as db:
        layer = db.get(Layer, layer_ids[0])
        assert layer is not None
        assert layer.slot == "mid"
