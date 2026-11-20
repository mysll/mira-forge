"""layer remembers which image to export

导出时每一层默认取最新的那张；用户点了「使用这张」之后就用选中的那张。

Revision ID: 0014_layer_selected_image
Revises: 0013_generation_layer
Create Date: 2026-11-19
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0014_layer_selected_image"
down_revision = "0013_generation_layer"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("layers") as batch:
        batch.add_column(sa.Column("selected_image_id", sa.Integer(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("layers") as batch:
        batch.drop_column("selected_image_id")
