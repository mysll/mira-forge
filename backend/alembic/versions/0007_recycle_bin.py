"""回收站：删除改成软删除

Revision ID: 0007_recycle_bin
Revises: 0006_local_edit
Create Date: 2026-11-17 17:30:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0007_recycle_bin"
down_revision = "0006_local_edit"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """三张表各加一个 deleted_at：非空即已进回收站，文件仍留在磁盘上。"""
    with op.batch_alter_table("images") as batch:
        batch.add_column(sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
        batch.create_index("ix_images_deleted_at", ["deleted_at"])

    with op.batch_alter_table("generation_tasks") as batch:
        batch.add_column(sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
        batch.create_index("ix_generation_tasks_deleted_at", ["deleted_at"])

    with op.batch_alter_table("generations") as batch:
        batch.add_column(sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
        batch.create_index("ix_generations_deleted_at", ["deleted_at"])


def downgrade() -> None:
    with op.batch_alter_table("generations") as batch:
        batch.drop_index("ix_generations_deleted_at")
        batch.drop_column("deleted_at")

    with op.batch_alter_table("generation_tasks") as batch:
        batch.drop_index("ix_generation_tasks_deleted_at")
        batch.drop_column("deleted_at")

    with op.batch_alter_table("images") as batch:
        batch.drop_index("ix_images_deleted_at")
        batch.drop_column("deleted_at")
