"""程序化执行 Alembic 迁移，保证启动即得到正确 schema。

每个项目一个数据库，所以迁移要按项目分别跑：`upgrade_to_head(project)`。
"""

from __future__ import annotations

import sqlite3

from alembic import command
from alembic.config import Config

from app.core.config import BACKEND_DIR
from app.core.projects import Project, active_project

# 0015 之后的老图层按原来的视差系数落槽，边界与 services/layer_slots.slot_for_scroll 一致。
_SLOT_BACKFILL = """
UPDATE layers SET slot = CASE
    WHEN scroll_scale < 0.15 THEN 'far'
    WHEN scroll_scale < 0.45 THEN 'mid'
    WHEN scroll_scale < 0.75 THEN 'near'
    WHEN scroll_scale <= 1.02 THEN 'gameplay'
    ELSE 'foreground'
END
WHERE slot IS NULL OR slot = 'near'
"""

# 同一套方案里同槽位的层按原 ord 排 depth（0 最远）。
_SLOT_DEPTH = """
WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY set_id, slot ORDER BY ord, id) - 1 AS rn
    FROM layers
)
UPDATE layers SET depth = (SELECT rn FROM ranked WHERE ranked.id = layers.id)
"""

# 系数与 z 改由槽位算，和 services/layer_slots.slot_scroll / slot_z 一致。
def _slot_metrics_sql() -> str:
    """按槽位重算系数与 z（直接从槽位定义生成，加新档位时不会漏）。"""
    from app.services.layer_slots import SLOT_ORDER, SLOTS

    scrolls = " ".join(f"WHEN '{key}' THEN {SLOTS[key].scroll}" for key in SLOT_ORDER)
    depths = " ".join(f"WHEN '{key}' THEN {SLOTS[key].z}" for key in SLOT_ORDER)
    return (
        "UPDATE layers SET\n"
        f"    scroll_scale = CASE slot {scrolls} ELSE 1.12 END,\n"
        f"    z_index = CASE slot {depths} ELSE 20 END + depth * 2\n"
    )


_SLOT_METRICS = _slot_metrics_sql()


def upgrade_to_head(project: Project | None = None) -> None:
    target = project or active_project()
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    config.set_main_option("sqlalchemy.url", target.database_url)
    command.upgrade(config, "head")
    _backfill_layer_slots(target)


def _backfill_layer_slots(project: Project) -> None:
    """迁移结束后单独一条连接补数据。

    迁移里不写这条 UPDATE 的原因：SQLite 的 batch 重建表之后，同一次迁移里的
    连接（以及它派生的新连接）执行 UPDATE 会报 "unable to open database file"。
    这里用标准库 sqlite3 直接开库——SQLAlchemy 的连接在这个库上照样触发同一个错，
    sqlite3 自己则一切正常（实测）。
    """
    if not project.db_path.is_file():
        return
    conn = sqlite3.connect(project.db_path)
    try:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "layers" not in tables:
            return
        columns = {row[1] for row in conn.execute("PRAGMA table_info(layers)")}
        if "slot" not in columns:
            return
        # 整表更新一个带索引的列时 SQLite 走 two-pass，会把中间结果落到临时文件；
        # 这台机器的临时目录不可写，落盘失败就报 "unable to open database file"。
        # 把临时存储指到内存即可（行数很少，没有内存压力）。
        conn.execute("PRAGMA temp_store = memory")
        conn.execute(_SLOT_BACKFILL)
        if "depth" in columns:
            conn.execute("UPDATE layers SET depth = 0 WHERE depth IS NULL")
            conn.execute(_SLOT_DEPTH)
        conn.execute(_SLOT_METRICS)
        conn.commit()
    finally:
        conn.close()
