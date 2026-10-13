"""已退役：这条管线的职责全部并入 scripts/prepare_cards.py。

为什么退役（不是「顺手重构」，是有具体故障的）：

  1. **同一个输出路径被两条管线抢。**
     本脚本写 `public/art/cards/<id>.webp`（裁到 CARD_ASPECT=0.6 的立绘），
     prepare_cards.py 也写同一个路径（1024x1536 的完整卡面合成）。
     谁后跑谁赢——资源内容取决于执行顺序，不是取决于代码。

  2. **输入写死是 `立绘/`，不看 `cards/<id>/source.png`。**
     所以在工作台里换过源图之后，图鉴 36 格和详情弹窗纹丝不动。
     游戏里 5 个显示位置（3D 大图 / 出征选将 / 抽卡撕包 / 图鉴网格 / 详情弹窗）
     实际有 3 套来源不一致的图，其中 2 套长期停在几天前。

  3. **CARD_ASPECT = 0.6 和卡面的 1024/1536 = 0.667 打架。**
     同一张卡在网格和大图里是两个比例，这就是「高度不一样」的来源。
     比例应该跟卡面走，不该另立一个定义。

现在 prepare_cards.py 一条命令产出全部四套（layers / cards / thumbs / portraits），
比例和尺寸都从 scripts/card_layout.py 的契约出，输入一律走 `source_of()`：

    python -X utf8 scripts/prepare_cards.py
    python -X utf8 scripts/prepare_cards.py --ids lujunyi wusong

本文件保留为一个会拒绝执行的说明牌，免得有人照着旧文档跑出一条
「成功但资源是错的」结果——那比直接报错难查得多。
"""

from pathlib import Path
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except AttributeError:
    pass

MESSAGE = """
genportraits.py 已退役，职责并入 scripts/prepare_cards.py。

原因（按危害排序）：
  · 它和 prepare_cards.py 抢同一个输出 public/art/cards/<id>.webp，谁后跑谁赢
  · 它的输入是 立绘/，工作台存的 cards/<id>/source.png 它根本不看，
    所以换过源图之后图鉴网格和详情弹窗还是老画
  · 它的 CARD_ASPECT=0.6 和卡面 1024/1536=0.667 不是一回事，
    同一张卡在网格和大图里两个比例

请改用：
    python -X utf8 scripts/prepare_cards.py
    python -X utf8 scripts/prepare_cards.py --ids lujunyi
"""


def main() -> int:
    print(MESSAGE)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())