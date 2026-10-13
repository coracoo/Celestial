"""把出血层和卡面叠在一起看一眼：角色到底有没有探出卡缘。

不是审计（audit_card_layout.py 管数字），这是给人眼看的。
输出 shots/bleed-check-<id>.png：淡红 = 出血区，卡面线 = 卡缘。
"""
from pathlib import Path
from PIL import Image, ImageDraw
import json, sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from card_layout import CARD, BLEED, BLEED_CANVAS

ROOT = Path(__file__).resolve().parents[1]
ids = sys.argv[1:] or json.loads((ROOT / 'public/data/roster.json').read_text(encoding='utf-8-sig'))
out = ROOT / 'shots'
out.mkdir(exist_ok=True)

tiles = []
for card_id in ids:
    bleed = Image.open(ROOT / 'public/art/layers' / card_id / 'subject-bleed.png').convert('RGBA')
    assert bleed.size == BLEED_CANVAS, (card_id, bleed.size)
    frame = Image.open(ROOT / 'public/art/layers' / card_id / 'frame.png').convert('RGBA')
    background = Image.open(ROOT / 'public/art/layers' / card_id / 'background.png').convert('RGBA')

    tile = Image.new('RGBA', BLEED_CANVAS, (12, 9, 8, 255))
    tile.alpha_composite(bleed)
    # 卡内才铺底衬 + 边框：卡外什么都没有，正是「探出去」的那一圈
    tile.alpha_composite(background, (BLEED[0], BLEED[1]))
    tile.alpha_composite(frame, (BLEED[0], BLEED[1]))
    tile.alpha_composite(bleed, (0, 0))

    box = bleed.getchannel('A').getbbox()
    draw = ImageDraw.Draw(tile)
    draw.rectangle((BLEED[0] - 1, BLEED[1] - 1, BLEED[0] + CARD[0], BLEED[1] + CARD[1]),
                   outline=(255, 217, 160, 255), width=3)
    out_left = BLEED[0] - box[0]
    out_right = box[2] - (BLEED[0] + CARD[0])
    out_top = BLEED[1] - box[1]
    out_bottom = box[3] - (BLEED[1] + CARD[1])
    print(f'{card_id}: 出卡缘 左{out_left}px 右{out_right}px 上{out_top}px 下{out_bottom}px  bbox={box}')
    tiles.append((card_id, tile, box))

if len(tiles) == 1:
    tiles[0][1].convert('RGB').save(out / f'bleed-check-{tiles[0][0]}.png')
    print('wrote', out / f'bleed-check-{tiles[0][0]}.png')
else:
    scale = 0.32
    w, h = (round(BLEED_CANVAS[0] * scale), round(BLEED_CANVAS[1] * scale))
    sheet = Image.new('RGB', (w * len(tiles), h), (12, 9, 8))
    for i, (_, tile, _) in enumerate(tiles):
        sheet.paste(tile.convert('RGB').resize((w, h), Image.Resampling.LANCZOS), (i * w, 0))
    path = out / 'bleed-check.png'
    sheet.save(path)
    print('wrote', path)
