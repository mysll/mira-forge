"""图集装箱：格子对齐、互不重叠、格子不共享、超宽件自动缩小。"""

from __future__ import annotations

import math
from types import SimpleNamespace

from PIL import Image

from app.services import kit_service


def _piece(width: int, height: int) -> Image.Image:
    return Image.new("RGBA", (width, height), (10, 20, 30, 255))


def _items(sizes: list[tuple[int, int]]):
    out = []
    for index, (width, height) in enumerate(sizes):
        item = SimpleNamespace(
            id=index + 1, key=f"item_{index}", image_id=index + 1, anchor="top", note=None
        )
        out.append((item, _piece(width, height)))
    return out


def test_grid_pack_aligns_to_cells_and_never_shares_one():
    cell = 64
    padding = 6
    pieces = _items([(646, 358), (646, 358), (326, 710), (646, 710), (326, 326), (326, 710)])

    placements, width, height, shrunk = kit_service._pack_grid(
        pieces, max_width=1024, padding=padding, cell=cell
    )

    assert shrunk == []
    assert width % cell == 0 and height % cell == 0
    occupied: dict[tuple[int, int], str] = {}
    for item, piece, x, y in placements:
        # 坐标落在格子上
        assert x % cell == padding and y % cell == padding
        # 每件占的格子，不允许别人再占
        cols = math.ceil(piece.width / cell)
        rows = math.ceil(piece.height / cell)
        start_col = (x - padding) // cell
        start_row = (y - padding) // cell
        for row in range(start_row, start_row + rows):
            for col in range(start_col, start_col + cols):
                key = (col, row)
                assert key not in occupied, f"{item.key} 与 {occupied[key]} 共用了格子 {key}"
                occupied[key] = item.key
        # 画布装得下
        assert (x - padding) // cell + cols <= width // cell
        assert (start_row + rows) <= height // cell


def test_grid_pack_shrinks_piece_wider_than_atlas():
    """一件比画布还宽时不再整张报错，而是等比缩到放得下。"""
    pieces = _items([(2000, 300), (320, 320)])
    placements, width, height, shrunk = kit_service._pack_grid(
        pieces, max_width=1024, padding=6, cell=64
    )

    assert shrunk == ["item_0"]
    assert width <= 1024
    for _item, piece, x, y in placements:
        assert x + piece.width <= width
        assert y + piece.height <= height


def test_free_pack_stays_inside_canvas_and_does_not_overlap():
    pieces = _items([(646, 358), (326, 710), (646, 710), (326, 326)])
    placements, width, height, shrunk = kit_service._pack_free(
        pieces, max_width=1024, padding=6
    )

    assert shrunk == []
    assert width <= 1024
    boxes = []
    for _item, piece, x, y in placements:
        assert x >= 0 and y >= 0
        assert x + piece.width <= width
        assert y + piece.height <= height
        boxes.append((x, y, piece.width, piece.height))
    for index, a in enumerate(boxes):
        for b in boxes[index + 1 :]:
            overlap_x = a[0] < b[0] + b[2] and b[0] < a[0] + a[2]
            overlap_y = a[1] < b[1] + b[3] and b[1] < a[1] + a[3]
            assert not (overlap_x and overlap_y)
