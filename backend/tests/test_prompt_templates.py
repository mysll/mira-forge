"""视频提示词模板：默认值、增删改、恢复默认、旧默认文案的升级。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

API = "/api/v1"


@pytest.fixture(autouse=True)
def fresh_templates(client: TestClient) -> None:
    """每个用例都从 9 条默认模板开始，避免互相带状态。"""
    response = client.post(f"{API}/prompt-templates/reset")
    assert response.status_code == 200, response.text


def _items(client: TestClient) -> list[dict]:
    response = client.get(f"{API}/prompt-templates")
    assert response.status_code == 200, response.text
    return response.json()["items"]


def test_defaults_describe_side_view_actions(client: TestClient) -> None:
    items = _items(client)
    labels = [item["label"] for item in items]
    assert labels[:3] == ["待机", "走路", "跑步"]
    assert {"攻击", "跳跃", "下落", "受伤", "死亡", "翻滚"} <= set(labels)
    # 每个默认模板都要带上「侧视 + 朝右 + 定点 + 镜头不动」这组约束
    for item in items:
        assert "side view" in item["prompt"]
        assert "facing right" in item["prompt"]
        assert "fixed camera" in item["prompt"]
        assert "anchored to the same spot" in item["prompt"]
        assert "horizontal position of the body does not change" in item["prompt"]


def test_jump_prompt_forbids_travelling(client: TestClient) -> None:
    """跳跃最容易跑偏：提示词里必须明确「原地起跳 + 落回同一点 + 不左右移动」。"""
    jump = next(item for item in _items(client) if item["label"] == "跳跃")
    prompt = jump["prompt"]
    assert "jumping vertically on the spot" in prompt
    assert "lands on the exact same ground point" in prompt
    assert "nothing moves left or right" in prompt


def test_create_appends_and_can_be_edited(client: TestClient) -> None:
    before = _items(client)
    created = client.post(
        f"{API}/prompt-templates",
        json={"label": "施法", "prompt": "A character casting a spell, hands raised"},
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["sort_order"] == len(before)

    after = _items(client)
    assert [item["label"] for item in after][-1] == "施法"

    patched = client.patch(
        f"{API}/prompt-templates/{body['id']}",
        json={"label": "施法（蓄力）", "prompt": "A character charging a spell"},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["label"] == "施法（蓄力）"
    assert patched.json()["prompt"] == "A character charging a spell"

    # 只改提示词时，名字保持不变
    only_prompt = client.patch(
        f"{API}/prompt-templates/{body['id']}", json={"prompt": "A character casting"}
    )
    assert only_prompt.status_code == 200, only_prompt.text
    assert only_prompt.json()["label"] == "施法（蓄力）"


def test_delete_removes_exactly_one(client: TestClient) -> None:
    items = _items(client)
    target = items[1]
    response = client.delete(f"{API}/prompt-templates/{target['id']}")
    assert response.status_code == 204
    remaining = _items(client)
    assert len(remaining) == len(items) - 1
    assert all(item["id"] != target["id"] for item in remaining)


def test_empty_content_is_rejected(client: TestClient) -> None:
    blank_label = client.post(f"{API}/prompt-templates", json={"label": "  ", "prompt": "x"})
    assert blank_label.status_code == 400
    assert "名字" in blank_label.json()["detail"]

    blank_prompt = client.post(f"{API}/prompt-templates", json={"label": "x", "prompt": "   "})
    assert blank_prompt.status_code == 400
    assert "提示词" in blank_prompt.json()["detail"]

    too_long = client.post(
        f"{API}/prompt-templates", json={"label": "x" * 41, "prompt": "ok"}
    )
    assert too_long.status_code == 400
    assert "40" in too_long.json()["detail"]


def test_unknown_id_is_404(client: TestClient) -> None:
    assert client.patch(f"{API}/prompt-templates/999999", json={"label": "x"}).status_code == 404
    assert client.delete(f"{API}/prompt-templates/999999").status_code == 404


def test_reset_restores_the_defaults(client: TestClient) -> None:
    for item in _items(client):
        assert client.delete(f"{API}/prompt-templates/{item['id']}").status_code == 204
    assert _items(client) == []

    response = client.post(f"{API}/prompt-templates/reset")
    assert response.status_code == 200, response.text
    labels = [item["label"] for item in response.json()["items"]]
    assert labels[:3] == ["待机", "走路", "跑步"]
    assert len(labels) == 9


def test_upgrade_rewrites_untouched_defaults_only(client: TestClient) -> None:
    """启动时的升级只换「逐字等于旧默认」的行，用户改过的不能碰。"""
    from app.models.database import SessionLocal
    from app.models.prompt_template import PromptTemplate
    from app.services.prompt_template_service import (
        _OLD_COMMON,
        _PREVIOUS_DEFAULTS,
        upgrade_defaults,
    )

    legacy = {item["label"]: f"{item['action']}, {_OLD_COMMON}." for item in _PREVIOUS_DEFAULTS}
    db = SessionLocal()
    try:
        rows = list(db.query(PromptTemplate).order_by(PromptTemplate.sort_order).all())
        assert len(rows) >= 2
        rows[0].prompt = legacy[rows[0].label]
        rows[1].prompt = "A character doing something of my own"
        db.commit()

        assert upgrade_defaults(db) == 1
        refreshed = {row.label: row.prompt for row in db.query(PromptTemplate).all()}
        assert refreshed[rows[0].label] != legacy[rows[0].label]
        assert "anchored to the same spot" in refreshed[rows[0].label]
        assert refreshed[rows[1].label] == "A character doing something of my own"
        # 已经是最新的行不会重复计数
        assert upgrade_defaults(db) == 0
    finally:
        db.close()
