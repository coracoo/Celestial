"""Create inspection-only card contact sheets for the declared roster."""
from pathlib import Path
from PIL import Image, ImageDraw
import json, math

root = Path(__file__).resolve().parents[1]
roster = json.loads((root / 'public/data/roster.json').read_text(encoding='utf-8-sig'))
for page in range(math.ceil(len(roster) / 12)):
    ids = roster[page*12:(page+1)*12]
    sheet = Image.new('RGB', (1280, math.ceil(len(ids)/4)*510), '#13151a')
    draw = ImageDraw.Draw(sheet)
    for index, character_id in enumerate(ids):
        path = root / 'cards' / character_id / 'renders/hero.png'
        image = Image.open(path).convert('RGB').resize((320,444))
        x, y = index%4*320, index//4*510
        sheet.paste(image, (x,y))
        draw.text((x+16,y+455), character_id, fill='#eee')
    target = root / 'cards' / ('render-contact.png' if page == 0 else f'render-contact-{page+1}.png')
    sheet.save(target)
    print(target)
