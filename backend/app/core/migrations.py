"""程序化执行 Alembic 迁移，保证启动即得到正确 schema。

每个项目一个数据库，所以迁移要按项目分别跑：`upgrade_to_head(project)`。
"""

from __future__ import annotations

import sqlite3

from alembic import command
from alembic.config import Config

from app.core.config import BACKEND_DIR
from app.core.projects import Project, active_project


def upgrade_to_head(project: Project | None = None) -> None:
    target = project or active_project()
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    config.set_main_option("sqlalchemy.url", target.database_url)
    command.upgrade(config, "head")
    _backfill_layer_slots(target)


def _backfill_layer_slots(project: Project) -> None:
    """把 0015 之前的老图层补上「槽位 / 槽内序号 / 视差系数」。

    只修「确实还没修过」的行，正常启动的库一条 UPDATE 都不会执行：

    - 0015 加的 `slot` 列默认值是 near，所以老行的特征是「slot=near 但
      scroll_scale 是别的档」——按 scroll_scale 反推真实槽位；
    - 老行的 `depth` 全是 0，同一槽位里会出现两个 0，需要按 ord 重排；
    - 槽位/深度定下来之后，系数与 z 由 services/layer_slots 的公式重算。

    以前这里是「每次都整表重算」，于是用户在界面上（或 LLM 方案里）调过的
    depth 每次重启都被按 ord 覆盖回去。现在只有上面两种残缺特征才动手。

    迁移里不写这些 UPDATE 的原因：SQLite 的 batch 重建表之后，同一次迁移里的
    连接（以及它派生的新连接）执行 UPDATE 会报 "unable to open database file"。
    这里用标准库 sqlite3 直接开库——SQLAlchemy 的连接在这个库上照样触发同一个错，
    sqlite3 自己则一切正常（实测）。
    """
    if not project.db_path.is_file():
        return
    conn = sqlite3.connect(project.db_path)
    try:
        tables = {
            row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        if "layers" not in tables:
            return
        columns = {row[1] for row in conn.execute("PRAGMA table_info(layers)")}
        if not {"slot", "depth", "scroll_scale", "z_index"} <= columns:
            return
        # 整表更新一个带索引的列时 SQLite 走 two-pass，会把中间结果落到临时文件；
        # 这台机器的临时目录不可写，落盘失败就报 "unable to open database file"。
        # 把临时存储指到内存即可（行数很少，没有内存压力）。
        conn.execute("PRAGMA temp_store = memory")

        from app.services.layer_slots import slot_for_scroll, slot_scroll, slot_z

        rows = conn.execute(
            "SELECT id, set_id, slot, depth, ord, scroll_scale FROM layers"
        ).fetchall()
        if not rows:
            return

        near_scroll = float(slot_scroll("near"))
        overrides: dict[int, str] = {}
        seen: set[tuple[int, str, int]] = set()
        dirty_sets: set[int] = set()
        for layer_id, set_id, slot, depth, _ord, scroll in rows:
            if slot is None or (slot == "near" and abs(float(scroll) - near_scroll) > 1e-6):
                # 0015 的默认值 near 或列还是空：按老的 scroll_scale 反推槽位
                overrides[int(layer_id)] = slot_for_scroll(float(scroll))
                dirty_sets.add(int(set_id))
                continue
            if depth is None:
                dirty_sets.add(int(set_id))
                continue
            key = (int(set_id), str(slot), int(depth))
            if key in seen:  # 同一槽位里两个 0：老数据，需要按 ord 重排
                dirty_sets.add(int(set_id))
            seen.add(key)

        for set_id in sorted(dirty_sets):
            set_rows = conn.execute(
                "SELECT id, slot FROM layers WHERE set_id = ? ORDER BY ord, id",
                (set_id,),
            ).fetchall()
            by_slot: dict[str, list[int]] = {}
            for layer_id, slot in set_rows:
                key = overrides.get(int(layer_id)) or (str(slot) if slot else "near")
                by_slot.setdefault(key, []).append(int(layer_id))
            for slot, ids in by_slot.items():
                for depth, layer_id in enumerate(ids):
                    conn.execute(
                        "UPDATE layers SET slot = ?, depth = ?, scroll_scale = ?, z_index = ?"
                        " WHERE id = ?",
                        (slot, depth, slot_scroll(slot), slot_z(slot, depth), layer_id),
                    )
        conn.commit()
    finally:
        conn.close()
