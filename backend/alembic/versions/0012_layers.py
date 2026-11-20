"""场景分层：layer_sets / layers

Revision ID: 0012_layers
Revises: 0011_scenes
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0012_layers"
down_revision = "0011_scenes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "layer_sets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("scene_id", sa.Integer(), nullable=False),
        sa.Column("source_image_id", sa.Integer(), nullable=True),
        sa.Column("model_name", sa.String(length=80), nullable=False),
        sa.Column("layer_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("count_per_layer", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("brief", sa.Text(), nullable=True),
        sa.Column("negative_prompt", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="analyzing"),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("llm_meta", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["scene_id"], ["scenes.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_layer_sets_scene_id", "layer_sets", ["scene_id"])
    op.create_index("ix_layer_sets_status", "layer_sets", ["status"])
    op.create_index("ix_layer_sets_created_at", "layer_sets", ["created_at"])
    op.create_index("ix_layer_sets_deleted_at", "layer_sets", ["deleted_at"])

    op.create_table(
        "layers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("set_id", sa.Integer(), nullable=False),
        sa.Column("ord", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("key", sa.String(length=40), nullable=False),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("role", sa.String(length=200), nullable=True),
        sa.Column("scroll_scale", sa.Float(), nullable=False, server_default="0.5"),
        sa.Column("z_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("negative_prompt", sa.Text(), nullable=True),
        sa.Column("occluded_by", sa.String(length=240), nullable=True),
        sa.Column("supports", sa.String(length=240), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("generation_id", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="draft"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["set_id"], ["layer_sets.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_layers_set_id", "layers", ["set_id"])


def downgrade() -> None:
    op.drop_index("ix_layers_set_id", table_name="layers")
    op.drop_table("layers")
    for name in (
        "ix_layer_sets_deleted_at",
        "ix_layer_sets_created_at",
        "ix_layer_sets_status",
        "ix_layer_sets_scene_id",
    ):
        op.drop_index(name, table_name="layer_sets")
    op.drop_table("layer_sets")
