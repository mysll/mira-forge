"""工作台重构所需字段：生成参数 + 图片收藏。

Revision ID: 0003_workspace
Revises: 0002_reference_image
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0003_workspace"
down_revision = "0002_reference_image"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("generations") as batch:
        batch.add_column(sa.Column("negative_prompt", sa.Text(), nullable=True))
        batch.add_column(sa.Column("steps", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("cfg", sa.Float(), nullable=True))
        batch.add_column(sa.Column("sampler", sa.String(length=64), nullable=True))

    with op.batch_alter_table("images") as batch:
        batch.add_column(
            sa.Column(
                "is_favorite",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("0"),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("images") as batch:
        batch.drop_column("is_favorite")

    with op.batch_alter_table("generations") as batch:
        batch.drop_column("sampler")
        batch.drop_column("cfg")
        batch.drop_column("steps")
        batch.drop_column("negative_prompt")
