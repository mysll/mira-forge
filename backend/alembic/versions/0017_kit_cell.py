"""图集加「格子」：按 N×N 对齐摆放。

Revision ID: 0017_kit_cell
Revises: 0016_kits
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0017_kit_cell"
down_revision = "0016_kits"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("kits")}
    if "cell" not in columns:
        with op.batch_alter_table("kits") as batch:
            batch.add_column(
                sa.Column("cell", sa.Integer(), nullable=False, server_default="64")
            )


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("kits")}
    if "cell" in columns:
        with op.batch_alter_table("kits") as batch:
            batch.drop_column("cell")
