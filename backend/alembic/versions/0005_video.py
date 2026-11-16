"""视频（二期）：产物表加媒体类型，生成记录记时长与帧率。

Revision ID: 0005_video
Revises: 0004_reference_images
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0005_video"
down_revision = "0004_reference_images"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("generations") as batch:
        batch.add_column(sa.Column("duration_seconds", sa.Float(), nullable=True))
        batch.add_column(sa.Column("fps", sa.Float(), nullable=True))

    with op.batch_alter_table("images") as batch:
        batch.add_column(
            sa.Column("media_type", sa.String(length=16), nullable=False, server_default=sa.text("'image'"))
        )
        batch.add_column(sa.Column("duration_seconds", sa.Float(), nullable=True))
        batch.add_column(sa.Column("fps", sa.Float(), nullable=True))
        batch.add_column(sa.Column("frame_count", sa.Integer(), nullable=True))
    op.create_index("ix_images_media_type", "images", ["media_type"])


def downgrade() -> None:
    op.drop_index("ix_images_media_type", table_name="images")
    with op.batch_alter_table("images") as batch:
        batch.drop_column("frame_count")
        batch.drop_column("fps")
        batch.drop_column("duration_seconds")
        batch.drop_column("media_type")

    with op.batch_alter_table("generations") as batch:
        batch.drop_column("fps")
        batch.drop_column("duration_seconds")
