"""layers.mask_path：手画遮罩定位这一层

Revision ID: 0024_layer_mask
Revises: 0023_element_mask
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0024_layer_mask"
down_revision = "0023_element_mask"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("layers")}
    if "mask_path" not in columns:
        with op.batch_alter_table("layers") as batch:
            batch.add_column(sa.Column("mask_path", sa.String(length=400), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("layers") as batch:
        batch.drop_column("mask_path")
