"""场景：images / generations 各加一列 scene_id，并新建 scenes 表。

场景 = 隔离容器：场景里的产物落在 `storage/scenes/<id>/`，默认列表只查
`scene_id IS NULL`，所以场景产物不进主图片流。

Revision ID: 0011_scenes
Revises: 0010_generation_name
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0011_scenes"
down_revision = "0010_generation_name"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "scenes",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("cover_image_id", sa.Integer(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_scenes_created_at", "scenes", ["created_at"])
    op.create_index("ix_scenes_deleted_at", "scenes", ["deleted_at"])

    with op.batch_alter_table("generations") as batch:
        batch.add_column(sa.Column("scene_id", sa.Integer(), nullable=True))
        batch.create_index("ix_generations_scene_id", ["scene_id"])

    with op.batch_alter_table("images") as batch:
        batch.add_column(sa.Column("scene_id", sa.Integer(), nullable=True))
        batch.create_index("ix_images_scene_id", ["scene_id"])


def downgrade() -> None:
    with op.batch_alter_table("images") as batch:
        batch.drop_index("ix_images_scene_id")
        batch.drop_column("scene_id")

    with op.batch_alter_table("generations") as batch:
        batch.drop_index("ix_generations_scene_id")
        batch.drop_column("scene_id")

    op.drop_index("ix_scenes_deleted_at", table_name="scenes")
    op.drop_index("ix_scenes_created_at", table_name="scenes")
    op.drop_table("scenes")
