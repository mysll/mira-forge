"""图集条目支持缩放：同一张图按比例缩小后再装箱。

Revision ID: 0021_kit_item_scale
Revises: 0020_element_selected_image
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0021_kit_item_scale"
down_revision = "0020_element_selected_image"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "kit_items" not in sa.inspect(op.get_bind()).get_table_names():
        return
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("kit_items")}
    if "scale" in columns:
        return
    with op.batch_alter_table("kit_items") as batch:
        batch.add_column(sa.Column("scale", sa.Float(), nullable=False, server_default="1.0"))


def downgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("kit_items")}
    if "scale" not in columns:
        return
    with op.batch_alter_table("kit_items") as batch:
        batch.drop_column("scale")
