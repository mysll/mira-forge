"""参考图可存多张（图生图最多 2 张）。

Revision ID: 0004_reference_images
Revises: 0003_workspace
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0004_reference_images"
down_revision = "0003_workspace"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("generations") as batch:
        batch.add_column(sa.Column("reference_image_paths", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("generations") as batch:
        batch.drop_column("reference_image_paths")
