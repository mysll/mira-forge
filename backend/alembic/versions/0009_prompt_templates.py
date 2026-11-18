"""视频提示词模板表

Revision ID: 0009_prompt_templates
Revises: 0008_inpaint_mask
Create Date: 2026-11-18 14:20:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0009_prompt_templates"
down_revision = "0008_inpaint_mask"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """一条模板 = 视频创作框下面的一个按钮（侧视、朝右、定点那类动作）。

    内容只存文本，默认值由 `prompt_template_service.seed_defaults` 在项目库为
    空时补上——这样老项目升级后也能直接用，删光了重启会补回默认。
    """
    op.create_table(
        "prompt_templates",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("label", sa.String(length=40), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_prompt_templates_sort_order", "prompt_templates", ["sort_order"])


def downgrade() -> None:
    op.drop_index("ix_prompt_templates_sort_order", table_name="prompt_templates")
    op.drop_table("prompt_templates")
