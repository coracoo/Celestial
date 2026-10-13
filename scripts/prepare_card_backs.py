"""把用户给的两张卡背图转成项目资产（裁黑留白、去浅描边、按卡面比例居中裁切）。

三步，每一步都对应原图里实际量出来的一层结构（见 `inspect_card_back.py` 的扫描输出）：

1. **黑留白**  两张图外面都垫着一圈纯黑（亮度 0），直接当画面会多出黑边。
2. **浅描边**  留白里面是一圈约 12~14px 的浅色描边（亮度 150~180），
   那是「这张图画在一张卡上」的示意边。卡牌网格 `card.glb` 自己有倒角和金色压边，
   留着它会在卡面上多一道白线，所以按量出来的宽度切掉。
3. **比例对齐**  裁完的画是 917×1453（≈0.631）和 920×1475（≈0.624），
   而卡面是 2/3=0.667。**居中裁掉多出来的边，而不是拉伸**——
   背面是左右对称的纹样，裁掉两侧各 3~4% 肉眼看不出来，拉伸则整个纹样都变形。

用法：python scripts/prepare_card_backs.py <我方图> <敌方图>
"""
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "art" / "back"
# 卡面正面在图鉴里最大约 512×768，3D 里更小。背面是 36 张卡共用的全局资产，
# 留 1.5 倍余量就够，再高只是白占带宽。
TARGET_W = 752
ASPECT = 2 / 3
# 浅描边的亮度判据：描边约 150~180，卡面画面约 40~90
LIGHT = 120


def means(img: Image.Image):
    px = img.load()
    w, h = img.size
    steps_x = max(1, w // 160)
    steps_y = max(1, h // 160)

    def row(y: int) -> float:
        xs = range(0, w, steps_x)
        return sum(sum(px[x, y]) for x in xs) / (len(list(xs)) * 3)

    def col(x: int) -> float:
        ys = range(0, h, steps_y)
        return sum(sum(px[x, y]) for y in ys) / (len(list(ys)) * 3)

    return row, col


def content_box(img: Image.Image) -> tuple[int, int, int, int]:
    """第一层：非黑内容的包围盒。"""
    row, col = means(img)
    w, h = img.size
    top = next(y for y in range(h) if row(y) > 8)
    left = next(x for x in range(w) if col(x) > 8)
    bottom = next(y for y in range(h - 1, -1, -1) if row(y) > 8)
    right = next(x for x in range(w - 1, -1, -1) if col(x) > 8)
    return left, top, right + 1, bottom + 1


def past_frame(img: Image.Image) -> tuple[int, int, int, int]:
    """
    第二层：从内容框边缘往里，跳过浅色描边，返回画面的实际范围。

    **必须走中线逐像素判断，不能用整列/整行的平均亮度。**
    第一版用列均值，裁左边时完全没生效：卡是圆角的，列均值被角外的黑区拉低，
    框边那一列的均值只有 47（描边本身是 157），于是「亮度 < 120」立刻成立，
    扫描一步没走就退出了——裁出来的图左边还留着半截白描边。
    中线上没有圆角干扰，是一条干净的横线/竖线，逐像素判断才准。
    """
    px = img.load()
    w, h = img.size
    left, top, right, bottom = content_box(img)
    limit = min(right - left, bottom - top) // 2
    # 连着 3 像素都「暗」才算进了画面，避免抗锯齿的过渡像素骗过判断
    RUN = 3

    def walk(coord: int, step: int, getter) -> int:
        run = 0
        for i in range(limit):
            c = coord + step * i
            # `content_box` 的 right/bottom 是开区间端点，会等于 w/h，必须夹住
            if not (0 <= c < w):
                return coord
            r, g, b = getter(c)
            if (r + g + b) / 3 < LIGHT:
                run += 1
                if run >= RUN:
                    return c
            else:
                run = 0
        return coord

    mid_y, mid_x = h // 2, w // 2
    x0 = walk(left, +1, lambda x: px[x, mid_y])
    x1 = walk(right, -1, lambda x: px[x, mid_y])
    y0 = walk(top, +1, lambda y: px[mid_x, y])
    y1 = walk(bottom, -1, lambda y: px[mid_x, y])
    # 描边是 1px 实线 + 抗锯齿过渡，多留 5px 余量（敌方那张左边还剩一丝亮线）
    inset = 5
    return x0 + inset, y0 + inset, x1 - inset, y1 - inset


def to_card_box(img: Image.Image) -> Image.Image:
    """第三层：居中裁成卡面比例，不拉伸。"""
    w, h = img.size
    if w / h > ASPECT:  # 太宽 → 裁两侧
        nw = round(h * ASPECT)
        off = (w - nw) // 2
        return img.crop((off, 0, off + nw, h))
    nh = round(w / ASPECT)  # 太高 → 裁上下
    off = (h - nh) // 2
    return img.crop((0, off, w, off + nh))


def main(sources: list[str]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, src in zip(("ally", "enemy"), sources):
        img = Image.open(src).convert("RGB")
        print(f"[{name}] 原图 {img.size}")
        l1 = content_box(img)
        print(f"  去黑留白 → {l1} = {l1[2] - l1[0]}×{l1[3] - l1[1]}")
        img = img.crop(l1)
        l2 = past_frame(img)
        print(f"  去浅描边 → {l2} = {l2[2] - l2[0]}×{l2[3] - l2[1]}"
              f"  描边 左{l2[0] - l1[0] - 2} 上{l2[1] - l1[1] - 2}"
              f" 右{l1[2] - l2[2] - 2} 下{l1[3] - l2[3] - 2}")
        img = img.crop(l2)
        before = img.size
        img = to_card_box(img)
        print(f"  对齐 2:3  {before} → {img.size}")
        if img.width > TARGET_W:
            img = img.resize((TARGET_W, round(img.height * TARGET_W / img.width)), Image.LANCZOS)
        out = OUT_DIR / f"{name}.webp"
        img.save(out, "WEBP", quality=90, method=6)
        print(f"  写出 {out}  {out.stat().st_size // 1024}KB")


if __name__ == "__main__":
    main(sys.argv[1:3])
