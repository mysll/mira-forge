"""批次名：给一批产物起个人能认出来的名字。

Revision ID: 0010_generation_name
Revises: 0009_prompt_templates
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0010_generation_name"
down_revision = "0009_prompt_templates"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("generations") as batch:
        batch.add_column(sa.Column("name", sa.String(length=60), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("generations") as batch:
        batch.drop_column("name")
