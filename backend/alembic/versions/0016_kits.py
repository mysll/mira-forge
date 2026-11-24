"""kits and kit items

图集工具：一张 atlas 里放多个透明件，导出 atlas.png + kit.json。
条目只存 image_id，不复制文件。

Revision ID: 0016_kits
Revises: 0015_layer_slots
Create Date: 2026-11-20
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0016_kits"
down_revision = "0015_layer_slots"
branch_labels = None
depends_on = None


def _tables(bind) -> set[str]:
    return set(sa.inspect(bind).get_table_names())


def upgrade() -> None:
    if "kits" not in _tables(op.get_bind()):
        op.create_table(
            "kits",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("name", sa.String(length=60), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("padding", sa.Integer(), nullable=False, server_default="4"),
            sa.Column("max_width", sa.Integer(), nullable=False, server_default="2048"),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_kits_created_at", "kits", ["created_at"])
        op.create_index("ix_kits_deleted_at", "kits", ["deleted_at"])

    if "kit_items" not in _tables(op.get_bind()):
        op.create_table(
            "kit_items",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("kit_id", sa.Integer(), nullable=False),
            sa.Column("image_id", sa.Integer(), nullable=False),
            sa.Column("key", sa.String(length=60), nullable=False, server_default=""),
            sa.Column("anchor", sa.String(length=10), nullable=False, server_default="top"),
            sa.Column("note", sa.String(length=200), nullable=True),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["kit_id"], ["kits.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_kit_items_kit_id", "kit_items", ["kit_id"])
        op.create_index("ix_kit_items_image_id", "kit_items", ["image_id"])


def downgrade() -> None:
    tables = _tables(op.get_bind())
    if "kit_items" in tables:
        op.drop_index("ix_kit_items_image_id", table_name="kit_items")
        op.drop_index("ix_kit_items_kit_id", table_name="kit_items")
        op.drop_table("kit_items")
    if "kits" in tables:
        op.drop_index("ix_kits_deleted_at", table_name="kits")
        op.drop_index("ix_kits_created_at", table_name="kits")
        op.drop_table("kits")
