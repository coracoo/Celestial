"""Compile real generated cutouts into the existing game's layered card layout.

No character is drawn or substituted here: each input is image_gen output or an
explicitly reused existing hero portrait. Keep runtime WebP images small.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps
import argparse, hashlib, json, math, shutil
from card_layout import prepare_frame, prepare_subject

ROOT = Path(__file__).resolve().parents[1]
CATALOG = json.loads((ROOT/'public/data/opponents.json').read_text(encoding='utf-8'))
SOURCE = ROOT/'cards/opponents/sources'
OUT = ROOT/'public/art/opponents'
SIZE = (512, 768)
DONORS = {'metal':'卢俊义', 'wood':'柴进', 'water':'张顺', 'fire':'秦明', 'earth':'鲁智深', 'boss':'宋江'}
PALETTES = {'metal':(70,49,24), 'wood':(19,52,35), 'water':(16,38,67),
            'fire':(71,20,18), 'earth':(64,42,25), 'boss':(50,21,49)}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def shared_layers():
    directory = OUT/'shared'; directory.mkdir(parents=True,exist_ok=True)
    for element, donor in DONORS.items():
        source = next((ROOT/'立绘').glob(f'*{donor}-边框-透明.png'))
        frame = prepare_frame(Image.open(source)).resize(SIZE, Image.Resampling.LANCZOS)
        frame.putalpha(frame.getchannel('A').point(lambda a:min(82,a)))
        frame.save(directory/f'{element}-frame.webp','WEBP',lossless=True,method=6)
        # Quiet code-native lacquer vignette; never a substitute for character art.
        center=PALETTES[element]
        bg=Image.new('RGB',SIZE)
        pixels=[]
        for y in range(SIZE[1]):
            for x in range(SIZE[0]):
                d=min(1,math.hypot((x-256)/370,(y-320)/520))
                pixels.append(tuple(round(v*(1-.62*d)) for v in center))
        bg.putdata(pixels)
        ink=ImageDraw.Draw(bg)
        line=tuple(min(255,round(c*.9+25)) for c in center)
        for inset in (22,30): ink.rounded_rectangle((inset,inset,SIZE[0]-inset-1,SIZE[1]-inset-1),radius=9,outline=line,width=1)
        ink.ellipse((62,142,450,530),outline=line,width=1)
        bg.save(directory/f'{element}-background.webp','WEBP',quality=86,method=6)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--partial',action='store_true')
    args=parser.parse_args(); SOURCE.mkdir(parents=True,exist_ok=True); OUT.mkdir(parents=True,exist_ok=True)
    shared_layers()
    rows=[]; missing=[]
    for entry in [*CATALOG['minions'],*CATALOG['bosses']]:
        key=entry['id']; source=SOURCE/f'{key}.png'
        if entry.get('hero'):
            hero=json.loads((ROOT/'public/data/characters'/f"{entry['hero']}.json").read_text(encoding='utf-8-sig'))
            original=next((ROOT/'立绘').glob(f"*{hero['name']}-立绘-透明.png"))
            if not source.exists(): shutil.copy2(original,source)
        if not source.exists(): missing.append(key);continue
        original=Image.open(source).convert('RGBA')
        alpha=original.getchannel('A');lo,hi=alpha.getextrema()
        assert lo==0 and hi>=240,(key,'requires true alpha')
        directory=OUT/key;directory.mkdir(parents=True,exist_ok=True)
        portrait=ImageOps.contain(original,SIZE,Image.Resampling.LANCZOS)
        portrait_canvas=Image.new('RGBA',SIZE)
        portrait_canvas.alpha_composite(portrait,((SIZE[0]-portrait.width)//2,(SIZE[1]-portrait.height)//2))
        portrait_canvas.save(directory/'portrait.webp','WEBP',quality=88,method=6)
        subject=prepare_subject(original).resize(SIZE,Image.Resampling.LANCZOS)
        subject.save(directory/'subject.webp','WEBP',quality=88,method=6)
        element=entry.get('wuxing','boss')
        bg=Image.open(OUT/'shared'/f'{element}-background.webp').convert('RGBA')
        frame=Image.open(OUT/'shared'/f'{element}-frame.webp').convert('RGBA')
        card=Image.alpha_composite(Image.alpha_composite(bg,subject),frame)
        card.convert('RGB').save(directory/'card.webp','WEBP',quality=85,method=6)
        rows.append({'id':key,'source':str(source.relative_to(ROOT)), 'sourceSha256':digest(source),
          'reusedHero':entry.get('hero'), 'alpha':[lo,hi], 'runtimeSize':list(SIZE),
          'files':{p.name:{'bytes':p.stat().st_size,'sha256':digest(p)} for p in directory.glob('*.webp')},
          'frameOpacity':.32,'frameDonor':DONORS[element]})
        print('Prepared',key,flush=True)
    report={'count':len(rows),'expected':42,'missing':missing,'cards':rows}
    (OUT/'provenance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print('Prepared',len(rows),'/42; missing',len(missing))
    if missing and not args.partial: raise RuntimeError('Missing generated portraits: '+', '.join(missing))


if __name__=='__main__':main()
