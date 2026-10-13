"""分析用户给的两张卡背图的边缘结构。

先量清楚再裁：这两张图外面是**黑色留白**，留白里面才是一圈浅色描边，
再往里才是卡面画面。第一版裁边把黑色当成了要保留的内容（一裁就停在第 0 行），
所以这里先把「黑留白 / 浅描边 / 画面」三层的实际像素边界打出来。

用法：python scripts/inspect_card_back.py <图1> <图2>
"""
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

from PIL import Image


def scan(img: Image.Image) -> None:
    rgb = img.convert("RGB")
    w, h = rgb.size
    p = rgb.load()

    def row_mean(y: int) -> float:
        xs = range(0, w, 4)
        return sum(sum(p[x, y]) for x in xs) / (len(list(xs)) * 3)

    def col_mean(x: int) -> float:
        ys = range(0, h, 4)
        return sum(sum(p[x, y]) for y in ys) / (len(list(ys)) * 3)

    print(f"  尺寸 {w}×{h}")
    print("  顶行扫描:", " ".join(f"{y}:{row_mean(y):.0f}" for y in range(0, 40, 2)))
    print("  左列扫描:", " ".join(f"{x}:{col_mean(x):.0f}" for x in range(0, 40, 2)))
    # 找到内容包围盒
    top = next(y for y in range(h) if row_mean(y) > 8)
    left = next(x for x in range(w) if col_mean(x) > 8)
    bottom = next(y for y in range(h - 1, -1, -1) if row_mean(y) > 8)
    right = next(x for x in range(w - 1, -1, -1) if col_mean(x) > 8)
    print(f"  非黑内容包围盒: ({left},{top}) ~ ({right},{bottom})  = {right-left+1}×{bottom-top+1}")
    print("  内容框内的上沿:", " ".join(
        f"{y}:{row_mean(y):.0f}" for y in range(top, min(top + 40, bottom), 2)
    ))
    print("  内容框内的左沿:", " ".join(
        f"{x}:{col_mean(x):.0f}" for x in range(left, min(left + 40, right), 2)
    ))
    print(f"  中心像素 {p[w // 2, h // 2]}  内容框中心 {p[(left + right) // 2, (top + bottom) // 2]}")


for label, path in zip(("ally", "enemy"), sys.argv[1:3]):
    print(f"[{label}] {Path(path).name}")
    scan(Image.open(path))
