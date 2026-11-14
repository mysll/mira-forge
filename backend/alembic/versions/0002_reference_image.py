"""代编辑参考图：generations.reference_image_path

Revision ID: 0002_reference_image
Revises: 0001_initial
Create Date: 2026-11-14

"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "0002_reference_image"
down_revision: str | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # batch 模式：SQLite 改表要重建，alembic/env.py 已开 render_as_batch
    with op.batch_alter_table("generations") as batch:
        batch.add_column(sa.Column("reference_image_path", sa.String(length=512), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("generations") as batch:
        batch.drop_column("reference_image_path")
