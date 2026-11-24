"""元素支持手画遮罩：elements.mask_path

Revision ID: 0023_element_mask
Revises: 0022_kit_scene
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0023_element_mask"
down_revision = "0022_kit_scene"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "elements" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("elements")}
    if "mask_path" in columns:
        return
    with op.batch_alter_table("elements") as batch:
        batch.add_column(sa.Column("mask_path", sa.String(length=400), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "elements" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("elements")}
    if "mask_path" not in columns:
        return
    with op.batch_alter_table("elements") as batch:
        batch.drop_column("mask_path")
