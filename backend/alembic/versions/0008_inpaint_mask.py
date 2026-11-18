"""局部编辑：生成记录加遮罩路径

Revision ID: 0008_inpaint_mask
Revises: 0007_recycle_bin
Create Date: 2026-11-18 11:05:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0008_inpaint_mask"
down_revision = "0007_recycle_bin"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """generations 加 mask_image_path：灰度 PNG 的相对路径，白色区域会被重绘。

    遮罩与参考图分开存，是因为它不参与「参考图第几张」的序号语义；
    编辑路径（第 1 张定结构）仍然只看 reference_image_paths。
    """
    with op.batch_alter_table("generations") as batch:
        batch.add_column(sa.Column("mask_image_path", sa.String(length=512), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("generations") as batch:
        batch.drop_column("mask_image_path")
