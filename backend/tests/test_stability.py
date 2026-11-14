"""P6 验收：取消、重试、启动复位。"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.models.database import SessionLocal
from app.models.generation import Generation
from app.models.task import GenerationTask, TaskStatus
from app.services.generation_service import reset_interrupted_tasks, sync_generation_status

API = "/api/v1"


def _generation(client: TestClient, count: int = 1) -> dict:
    response = client.post(
        f"{API}/generations",
        json={"prompt": "stability probe", "model": "qwen_image_21_turbo", "count": count},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_cancel_pending_task(client: TestClient) -> None:
    body = _generation(client)
    task_id = body["tasks"][0]["id"]

    response = client.post(f"{API}/tasks/{task_id}/cancel")
    assert response.status_code == 200
    assert response.json()["status"] == "cancelled"

    # 整个生成记录跟着变成 cancelled
    generation = client.get(f"{API}/generations/{body['id']}").json()
    assert generation["status"] == "cancelled"


def test_cannot_cancel_finished_task(client: TestClient) -> None:
    body = _generation(client)
    task_id = body["tasks"][0]["id"]

    with SessionLocal() as db:
        task = db.get(GenerationTask, task_id)
        assert task is not None
        task.status = TaskStatus.COMPLETED
        db.commit()

    response = client.post(f"{API}/tasks/{task_id}/cancel")
    assert response.status_code == 409
    assert "无法取消" in response.json()["detail"]


def test_retry_appends_task_with_new_seed(client: TestClient) -> None:
    body = _generation(client)
    task_id = body["tasks"][0]["id"]
    old_seed = body["tasks"][0]["seed"]

    client.post(f"{API}/tasks/{task_id}/cancel")

    response = client.post(f"{API}/tasks/{task_id}/retry")
    assert response.status_code == 201, response.text
    retried = response.json()
    assert retried["id"] != task_id
    assert retried["generation_id"] == body["id"]
    assert retried["seed"] != old_seed
    assert retried["status"] == "pending"

    generation = client.get(f"{API}/generations/{body['id']}").json()
    assert generation["status"] in {"pending", "queued"}
    assert len(generation["tasks"]) == 2


def test_cannot_retry_running_task(client: TestClient) -> None:
    body = _generation(client)
    task_id = body["tasks"][0]["id"]

    with SessionLocal() as db:
        task = db.get(GenerationTask, task_id)
        assert task is not None
        task.status = TaskStatus.RUNNING
        db.commit()

    response = client.post(f"{API}/tasks/{task_id}/retry")
    assert response.status_code == 409


def test_retry_unknown_task_is_404(client: TestClient) -> None:
    assert client.post(f"{API}/tasks/999999/retry").status_code == 404
    assert client.post(f"{API}/tasks/999999/cancel").status_code == 404


def test_startup_reset_turns_stuck_tasks_pending(client: TestClient) -> None:
    body = _generation(client, count=2)
    ids = [task["id"] for task in body["tasks"]]

    with SessionLocal() as db:
        first = db.get(GenerationTask, ids[0])
        second = db.get(GenerationTask, ids[1])
        assert first is not None and second is not None
        first.status = TaskStatus.RUNNING
        first.progress = 42
        first.comfy_prompt_id = "stale-prompt"
        second.status = TaskStatus.QUEUED
        db.commit()

    with SessionLocal() as db:
        recovered = reset_interrupted_tasks(db)
        # 测试库是 session 级共享的，别的用例也可能留下 running 任务，这里只要求「至少这两个」
        assert recovered >= 2

        for task_id in ids:
            task = db.get(GenerationTask, task_id)
            assert task is not None
            assert task.status == TaskStatus.PENDING
            assert task.progress == 0
            assert task.comfy_prompt_id is None
            assert task.error_message is None

        generation = db.get(Generation, body["id"])
        assert generation is not None
        assert generation.status == "pending"


def test_sync_generation_status_marks_completed(client: TestClient) -> None:
    body = _generation(client)
    with SessionLocal() as db:
        generation = db.get(Generation, body["id"])
        assert generation is not None
        for task in generation.tasks:
            task.status = TaskStatus.COMPLETED
        db.commit()

        status = sync_generation_status(db, generation)
        assert status.value == "completed"
        assert generation.completed_at is not None
