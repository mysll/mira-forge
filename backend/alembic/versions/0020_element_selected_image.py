"""元素选图：每一件可以指定图集里用哪一张。

Revision ID: 0020_element_selected_image
Revises: 0019_element_gen
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0020_element_selected_image"
down_revision = "0019_element_gen"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "elements" not in sa.inspect(op.get_bind()).get_table_names():
        return
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("elements")}
    if "selected_image_id" in columns:
        return
    with op.batch_alter_table("elements") as batch:
        batch.add_column(sa.Column("selected_image_id", sa.Integer(), nullable=True))


def downgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("elements")}
    if "selected_image_id" not in columns:
        return
    with op.batch_alter_table("elements") as batch:
        batch.drop_column("selected_image_id")
