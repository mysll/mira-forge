"""本地编辑器保存的成品不需要 seed

Revision ID: 0006_local_edit
Revises: 0005_video
Create Date: 2026-11-17 11:30:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0006_local_edit"
down_revision = "0005_video"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """本地编辑不采样，`seed` 允许为空。"""
    with op.batch_alter_table("generation_tasks") as batch:
        batch.alter_column("seed", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    with op.batch_alter_table("generation_tasks") as batch:
        batch.alter_column("seed", existing_type=sa.Integer(), nullable=False)
