"""把早期写在 storage/images/ 下的视频挪到 storage/videos/ 并改库里的路径。

背景：视频一开始复用图片目录（storage/images/{generation}/...），
后来按媒体类型分目录（图片进 images/、视频进 videos/）。
新生成的文件已经是 videos/ 了，这个脚本只处理历史数据。

用法（在 backend 目录下）：
    .\\.venv\\Scripts\\python.exe ..\\tools\\move_videos.py --dry-run
    .\\.venv\\Scripts\\python.exe ..\\tools\\move_videos.py

脚本是幂等的：file_path 已经以 videos/ 开头就跳过。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from app.core.projects import active_project, list_projects  # noqa: E402
from app.models.database import session_for  # noqa: E402
from app.models.image import Image  # noqa: E402


def move_project(project, dry_run: bool) -> tuple[int, int]:
    """返回 (移动数量, 文件缺失数量)。"""
    moved = 0
    missing = 0
    with session_for(project) as db:
        videos = [row for row in db.query(Image).filter(Image.media_type == "video").all()]
        for image in videos:
            relative = Path(image.file_path)
            if relative.parts and relative.parts[0] == "videos":
                continue
            source = project.storage_path / relative
            if not source.exists():
                missing += 1
                print(f"  缺失 {image.id} {image.file_path}")
                continue
            target_relative = Path("videos") / relative.parent.name / relative.name
            target = project.storage_path / target_relative
            print(f"  {image.id}: {image.file_path} -> {target_relative.as_posix()}")
            if dry_run:
                moved += 1
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            source.replace(target)
            image.file_path = target_relative.as_posix()
            moved += 1
        if not dry_run:
            db.commit()
    return moved, missing


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--only", default=None, help="只处理某个项目 id")
    args = parser.parse_args()

    projects = list_projects()
    if args.only:
        projects = [item for item in projects if item.id == args.only]

    active = active_project()
    print(f"激活项目：{active.name}（{active.path}）")
    total_moved = 0
    total_missing = 0
    for project in projects:
        print(f"项目 {project.id}（{project.name}）")
        moved, missing = move_project(project, args.dry_run)
        print(f"  移动 {moved} 个，缺失 {missing} 个")
        total_moved += moved
        total_missing += missing

    verb = "将移动" if args.dry_run else "已移动"
    print(f"\n{verb} {total_moved} 个视频文件；缺失 {total_missing} 个。")
    if args.dry_run:
        print("这是 dry-run，没有改任何文件或数据库。")


if __name__ == "__main__":
    main()
