"""元素提取：element_sets / elements 两张表，外加 kit_items 支持引用元素。

Revision ID: 0018_elements
Revises: 0017_kit_cell
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0018_elements"
down_revision = "0017_kit_cell"
branch_labels = None
depends_on = None


def _tables(bind) -> set[str]:
    return set(sa.inspect(bind).get_table_names())


def upgrade() -> None:
    bind = op.get_bind()
    tables = _tables(bind)
    if "element_sets" not in tables:
        op.create_table(
            "element_sets",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "scene_id",
                sa.Integer(),
                sa.ForeignKey("scenes.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("source_image_id", sa.Integer(), nullable=True),
            sa.Column("status", sa.String(20), nullable=False, server_default="analyzing"),
            sa.Column("brief", sa.Text(), nullable=True),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("llm_meta", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index("ix_element_sets_scene_id", "element_sets", ["scene_id"])
        op.create_index("ix_element_sets_status", "element_sets", ["status"])
        op.create_index("ix_element_sets_created_at", "element_sets", ["created_at"])
        op.create_index("ix_element_sets_deleted_at", "element_sets", ["deleted_at"])

    if "elements" not in tables:
        op.create_table(
            "elements",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "set_id",
                sa.Integer(),
                sa.ForeignKey("element_sets.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("kind", sa.String(20), nullable=False, server_default="prop"),
            sa.Column("name", sa.String(60), nullable=False),
            sa.Column("key", sa.String(60), nullable=False),
            sa.Column("x", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("y", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("width", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("height", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("anchor", sa.String(10), nullable=False, server_default="top"),
            sa.Column("note", sa.String(200), nullable=True),
            sa.Column("file_path", sa.String(400), nullable=False, server_default=""),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_elements_set_id", "elements", ["set_id"])

    columns = {column["name"] for column in sa.inspect(bind).get_columns("kit_items")}
    if "element_id" not in columns:
        with op.batch_alter_table("kit_items") as batch:
            batch.add_column(sa.Column("element_id", sa.Integer(), nullable=True))
            # image_id 之前是 NOT NULL：图集条目现在也可以直接指向「提取出来的元素」
            batch.alter_column(
                "image_id", existing_type=sa.Integer(), nullable=True, existing_nullable=False
            )
            batch.create_index("ix_kit_items_element_id", ["element_id"])


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("kit_items")}
    if "element_id" in columns:
        with op.batch_alter_table("kit_items") as batch:
            batch.drop_index("ix_kit_items_element_id")
            batch.alter_column(
                "image_id", existing_type=sa.Integer(), nullable=False, existing_nullable=True
            )
            batch.drop_column("element_id")

    tables = _tables(bind)
    if "elements" in tables:
        op.drop_table("elements")
    if "element_sets" in tables:
        op.drop_table("element_sets")
