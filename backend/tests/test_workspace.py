"""批量删除与清空工作区。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.projects import active_project
from app.models.database import SessionLocal
from app.models.task import GenerationTask, TaskStatus
from app.services.image_service import store_image

PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
    b"\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00"
    b"\x00\x00IEND\xaeB`\x82"
)


@pytest.fixture(autouse=True)
def empty_workspace(client: TestClient) -> None:
    """每个用例从空工作区开始，避免互相看见对方造的图。"""
    response = client.post("/api/v1/images/clear")
    assert response.status_code == 200, response.text


def _create(client: TestClient, count: int = 2) -> int:
    response = client.post(
        "/api/v1/generations",
        json={
            "prompt": "a clay cup on a windowsill",
            "model": "qwen_image_21_turbo",
            "generation_type": "text_to_image",
            "width": 512,
            "height": 512,
            "count": count,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _register_image(generation_id: int, slot: int = 0) -> int:
    """直接走服务层落一张图（测试里不启动 worker），slot 决定用第几个任务。"""
    db = SessionLocal()
    try:
        tasks = (
            db.query(GenerationTask)
            .filter_by(generation_id=generation_id)
            .order_by(GenerationTask.id)
            .all()
        )
        assert len(tasks) > slot
        image = store_image(
            db,
            content=PNG,
            generation_id=generation_id,
            task_id=tasks[slot].id,
            index=0,
            width=1,
            height=1,
        )
        db.commit()
        return image.id
    finally:
        db.close()


def test_batch_delete_removes_rows_and_files(client: TestClient) -> None:
    generation_id = _create(client, count=3)
    first = _register_image(generation_id, 0)
    second = _register_image(generation_id, 1)

    storage = active_project().storage_path
    files = sorted(storage.glob("images/**/*.png"))
    assert len(files) == 2

    response = client.post("/api/v1/images/batch-delete", json={"ids": [first, second, 999999]})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["deleted"] == [first, second]
    assert payload["missing"] == [999999]

    assert not any(path.is_file() for path in files)
    assert client.get(f"/api/v1/images/{first}").status_code == 404
    assert client.get("/api/v1/images").json()["total"] == 0


def test_batch_delete_empty_payload_is_noop(client: TestClient) -> None:
    response = client.post("/api/v1/images/batch-delete", json={"ids": []})
    assert response.status_code == 200
    assert response.json() == {"deleted": [], "missing": []}


def test_clear_workspace_wipes_images_and_generations(client: TestClient) -> None:
    generation_id = _create(client, count=2)
    _register_image(generation_id, 0)

    storage = active_project().storage_path
    (storage / "uploads").mkdir(parents=True, exist_ok=True)
    (storage / "uploads" / "leftover.png").write_bytes(PNG)

    before = client.get("/api/v1/generations").json()["total"]
    assert before == 1

    response = client.post("/api/v1/images/clear")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["images"] == 1
    assert payload["generations"] == 1

    assert client.get("/api/v1/generations").json()["total"] == 0
    assert client.get("/api/v1/images").json()["total"] == 0
    assert not list((storage / "images").glob("**/*.png"))
    assert not list((storage / "uploads").glob("**/*"))


def test_clear_workspace_refuses_while_a_task_is_active(client: TestClient) -> None:
    generation_id = _create(client, count=1)
    db = SessionLocal()
    try:
        task = db.query(GenerationTask).filter_by(generation_id=generation_id).first()
        assert task is not None
        task.status = TaskStatus.RUNNING
        db.commit()
    finally:
        db.close()

    response = client.post("/api/v1/images/clear")
    assert response.status_code == 409, response.text
    assert "任务" in response.json()["detail"]

    # 收尾：改回 pending，供 autouse fixture 在下一个用例前清空
    db = SessionLocal()
    try:
        task = db.query(GenerationTask).filter_by(generation_id=generation_id).first()
        if task is not None:
            task.status = TaskStatus.PENDING
        db.commit()
    finally:
        db.close()

def test_delete_task_removes_its_products_and_keeps_the_batch(client: TestClient) -> None:
    generation_id = _create(client, count=2)
    first = _register_image(generation_id, 0)
    second = _register_image(generation_id, 1)

    detail = client.get(f"/api/v1/generations/{generation_id}").json()
    task_id = detail["tasks"][0]["id"]

    response = client.delete(f"/api/v1/tasks/{task_id}")
    assert response.status_code == 200, response.text
    assert response.json() == {"task_id": task_id, "generation_deleted": False}

    # 这个任务名下的产物跟着没了，另一个任务不受影响
    assert client.get(f"/api/v1/images/{first}").status_code == 404
    assert client.get(f"/api/v1/images/{second}").status_code == 200
    after = client.get(f"/api/v1/generations/{generation_id}").json()
    assert len(after["tasks"]) == 1


def test_delete_last_task_removes_the_empty_batch(client: TestClient) -> None:
    generation_id = _create(client, count=1)
    image_id = _register_image(generation_id, 0)
    task_id = client.get(f"/api/v1/generations/{generation_id}").json()["tasks"][0]["id"]

    response = client.delete(f"/api/v1/tasks/{task_id}")
    assert response.status_code == 200, response.text
    assert response.json()["generation_deleted"] is True
    assert client.get(f"/api/v1/generations/{generation_id}").status_code == 404
    assert client.get(f"/api/v1/images/{image_id}").status_code == 404


def test_delete_running_task_is_refused(client: TestClient) -> None:
    generation_id = _create(client, count=1)
    task_id = client.get(f"/api/v1/generations/{generation_id}").json()["tasks"][0]["id"]

    db = SessionLocal()
    try:
        task = db.get(GenerationTask, task_id)
        assert task is not None
        task.status = TaskStatus.RUNNING
        db.commit()
    finally:
        db.close()

    response = client.delete(f"/api/v1/tasks/{task_id}")
    assert response.status_code == 409, response.text
    assert "先取消" in response.json()["detail"]

    db = SessionLocal()
    try:
        task = db.get(GenerationTask, task_id)
        if task is not None:
            task.status = TaskStatus.PENDING
        db.commit()
    finally:
        db.close()


def test_delete_generation_wipes_tasks_files_and_the_batch(client: TestClient) -> None:
    generation_id = _create(client, count=2)
    first = _register_image(generation_id, 0)
    second = _register_image(generation_id, 1)

    storage = active_project().storage_path
    files = sorted(storage.glob("images/**/*.png"))
    assert len(files) == 2

    response = client.delete(f"/api/v1/generations/{generation_id}")
    assert response.status_code == 200, response.text
    assert response.json() == {"generation_id": generation_id, "images": 2, "tasks": 2}

    assert not any(path.is_file() for path in files)
    assert client.get(f"/api/v1/generations/{generation_id}").status_code == 404
    assert client.get(f"/api/v1/images/{first}").status_code == 404
    assert client.get(f"/api/v1/images/{second}").status_code == 404


def test_delete_generation_is_refused_while_a_task_runs(client: TestClient) -> None:
    generation_id = _create(client, count=1)
    task_id = client.get(f"/api/v1/generations/{generation_id}").json()["tasks"][0]["id"]

    db = SessionLocal()
    try:
        task = db.get(GenerationTask, task_id)
        assert task is not None
        task.status = TaskStatus.RUNNING
        db.commit()
    finally:
        db.close()

    response = client.delete(f"/api/v1/generations/{generation_id}")
    assert response.status_code == 409, response.text
    assert "先取消" in response.json()["detail"]

    db = SessionLocal()
    try:
        task = db.get(GenerationTask, task_id)
        if task is not None:
            task.status = TaskStatus.PENDING
        db.commit()
    finally:
        db.close()
