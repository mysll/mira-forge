"""图集记录来源场景：从元素提取页顺手建图集时带上 scene_id

Revision ID: 0022_kit_scene
Revises: 0021_kit_item_scale
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0022_kit_scene"
down_revision = "0021_kit_item_scale"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "kits" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("kits")}
    indexes = {index["name"] for index in inspector.get_indexes("kits")}
    with op.batch_alter_table("kits") as batch:
        if "scene_id" not in columns:
            batch.add_column(sa.Column("scene_id", sa.Integer(), nullable=True))
        if "ix_kits_scene_id" not in indexes:
            batch.create_index("ix_kits_scene_id", ["scene_id"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "kits" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("kits")}
    indexes = {index["name"] for index in inspector.get_indexes("kits")}
    with op.batch_alter_table("kits") as batch:
        if "ix_kits_scene_id" in indexes:
            batch.drop_index("ix_kits_scene_id")
        if "scene_id" in columns:
            batch.drop_column("scene_id")
