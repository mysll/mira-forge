"""layers get an engine slot

分层从「LLM 自己给视差系数」改成「固定五个槽位 + 槽内序号」：远景 / 中景 / 近景 /
玩法层 / 前景。老数据按 scroll_scale 落槽，系数与 z 之后由槽位算。

注意：SQLite 的 batch 迁移会重建整张表，中途失败会留下「列已加、版本没记上」的半成品。
所以这里先看实际列，缺什么补什么，重复执行不会报 duplicate column。

Revision ID: 0015_layer_slots
Revises: 0014_layer_selected_image
Create Date: 2026-11-20
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0015_layer_slots"
down_revision = "0014_layer_selected_image"
branch_labels = None
depends_on = None


def _column_names(bind, table: str) -> set[str]:
    return {column["name"] for column in sa.inspect(bind).get_columns(table)}


def _index_names(bind, table: str) -> set[str]:
    return {index["name"] for index in sa.inspect(bind).get_indexes(table)}


def upgrade() -> None:
    bind = op.get_bind()
    columns = _column_names(bind, "layers")
    indexes = _index_names(bind, "layers")

    with op.batch_alter_table("layers") as batch:
        if "slot" not in columns:
            batch.add_column(
                sa.Column("slot", sa.String(length=20), nullable=False, server_default="near")
            )
        if "depth" not in columns:
            batch.add_column(
                sa.Column("depth", sa.Integer(), nullable=False, server_default="0")
            )

    if "ix_layers_slot" not in indexes:
        op.create_index("ix_layers_slot", "layers", ["slot"])

    # 老数据按 scroll_scale 落槽这一步放到 app.core.migrations 里做：
    # SQLite 的 batch 迁移重建整张表之后，同一条连接里再 UPDATE 会抛
    # sqlite3.OperationalError: unable to open database file（真库上稳定复现），
    # 换连接也一样；等迁移结束、连接关掉之后再更新就完全正常。
    # 这里是纯 DDL，重复执行安全。


def downgrade() -> None:
    bind = op.get_bind()
    columns = _column_names(bind, "layers")
    indexes = _index_names(bind, "layers")
    if "ix_layers_slot" in indexes:
        op.drop_index("ix_layers_slot", table_name="layers")
    with op.batch_alter_table("layers") as batch:
        if "depth" in columns:
            batch.drop_column("depth")
        if "slot" in columns:
            batch.drop_column("slot")
