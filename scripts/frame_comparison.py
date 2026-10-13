"""Inspection-only before/after sheets for outward fixed ornamental frames."""
from pathlib import Path
from PIL import Image, ImageDraw
import json, math

root = Path(__file__).resolve().parents[1]
ids = json.loads((root / 'cards/frame-before/roster.json').read_text(encoding='utf8'))
for page in range(math.ceil(len(ids) / 12)):
    current = ids[page*12:(page+1)*12]
    sheet = Image.new('RGB', (1440, math.ceil(len(current)/3)*410), '#13151a')
    draw = ImageDraw.Draw(sheet)
    for index, character_id in enumerate(current):
        x, y = index%3*480, index//3*410
        draw.text((x+12,y+8), character_id + ' | before / after', fill='#eeeeee')
        before = Image.open(root / 'cards/frame-before' / f'{character_id}.webp').convert('RGB').resize((240,360))
        after = Image.open(root / 'public/art/cards' / f'{character_id}.webp').convert('RGB').resize((240,360))
        sheet.paste(before, (x,y+32)); sheet.paste(after, (x+240,y+32))
    target = root / 'cards' / f'frame-comparison-{page+1}.png'
    sheet.save(target)
    print(target)
