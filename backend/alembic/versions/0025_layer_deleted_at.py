"""layer soft delete

Revision ID: 0025_layer_deleted_at
Revises: 0024_layer_mask
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0025_layer_deleted_at"
down_revision = "0024_layer_mask"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 删层改成软删：硬删之后 SQLite 会把同一个 id 分给新建的层，
    # 那一层的历史批次就会重新挂上来（表现为「新层里还有旧批次」）。
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("layers")}
    with op.batch_alter_table("layers") as batch:
        if "deleted_at" not in columns:
            batch.add_column(sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("layers")}
    with op.batch_alter_table("layers") as batch:
        if "deleted_at" in columns:
            batch.drop_column("deleted_at")
