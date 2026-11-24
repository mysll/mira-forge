"""元素提取改成「LLM 只点名、图片编辑逐件重绘」。

旧版本按 LLM 给的归一化框裁图，实测框不可信（会把拱门框到灯笼上），
而且裁出来的是带背景的矩形，进图集没法当贴图。
新版本把坐标整段去掉：元素只存名字/类别/提示词，产物由 image_edit 生成（真 alpha）。

Revision ID: 0019_element_gen
Revises: 0018_elements
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0019_element_gen"
down_revision = "0018_elements"
branch_labels = None
depends_on = None


def _columns(bind, table: str) -> set[str]:
    inspector = sa.inspect(bind)
    if table not in inspector.get_table_names():
        return set()
    return {column["name"] for column in inspector.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    existing = _columns(bind, "elements")
    if not existing:
        return

    with op.batch_alter_table("elements") as batch:
        if "prompt" not in existing:
            batch.add_column(sa.Column("prompt", sa.Text(), nullable=True))
        if "generation_id" not in existing:
            batch.add_column(sa.Column("generation_id", sa.Integer(), nullable=True))
        if "status" not in existing:
            batch.add_column(
                sa.Column("status", sa.String(length=20), nullable=False, server_default="draft")
            )
        for column in ("x", "y", "width", "height", "file_path"):
            if column in existing:
                batch.drop_column(column)

    indexes = {index["name"] for index in sa.inspect(bind).get_indexes("elements")}
    if "ix_elements_generation_id" not in indexes:
        op.create_index("ix_elements_generation_id", "elements", ["generation_id"])

    # 每个元素一个页签：出图记录挂在 generations.element_id 上（和 layers 一样）
    generation_columns = _columns(bind, "generations")
    if generation_columns and "element_id" not in generation_columns:
        with op.batch_alter_table("generations") as batch:
            batch.add_column(sa.Column("element_id", sa.Integer(), nullable=True))
        op.create_index("ix_generations_element_id", "generations", ["element_id"])

    # 旧数据是「按框裁出来的」候选，没有提示词也无法重绘，直接清空（开发期数据）。
    # 注意：删掉 element_sets 之后，旧 elements 是孤儿（SQLite 复用 id，
    # 新记录的 set_id 会正好撞上旧孤儿），这里一并清掉。
    op.execute("DELETE FROM element_sets")
    op.execute(
        "DELETE FROM elements WHERE prompt IS NULL "
        "OR set_id NOT IN (SELECT id FROM element_sets)"
    )


def downgrade() -> None:
    bind = op.get_bind()
    existing = _columns(bind, "elements")
    if not existing:
        return
    with op.batch_alter_table("elements") as batch:
        for column in ("prompt", "generation_id", "status"):
            if column in existing:
                batch.drop_column(column)
        if "x" not in existing:
            batch.add_column(sa.Column("x", sa.Integer(), nullable=False, server_default="0"))
        if "y" not in existing:
            batch.add_column(sa.Column("y", sa.Integer(), nullable=False, server_default="0"))
        if "width" not in existing:
            batch.add_column(sa.Column("width", sa.Integer(), nullable=False, server_default="0"))
        if "height" not in existing:
            batch.add_column(sa.Column("height", sa.Integer(), nullable=False, server_default="0"))
        if "file_path" not in existing:
            batch.add_column(
                sa.Column("file_path", sa.String(length=400), nullable=False, server_default="")
            )
