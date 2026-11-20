"""generation belongs to layer

Revision ID: 0013_generation_layer
Revises: 0012_layers
Create Date: 2026-11-19
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0013_generation_layer"
down_revision = "0012_layers"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("generations") as batch:
        batch.add_column(sa.Column("layer_id", sa.Integer(), nullable=True))
        batch.create_index("ix_generations_layer_id", ["layer_id"])


def downgrade() -> None:
    with op.batch_alter_table("generations") as batch:
        batch.drop_index("ix_generations_layer_id")
        batch.drop_column("layer_id")
