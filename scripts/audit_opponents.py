"""Require every requested opponent's real, registered, compressed art before delivery."""
from pathlib import Path
from PIL import Image
import hashlib, json

ROOT=Path(__file__).resolve().parents[1]
catalog=json.loads((ROOT/'public/data/opponents.json').read_text(encoding='utf-8'))
provenance=json.loads((ROOT/'public/art/opponents/provenance.json').read_text(encoding='utf-8'))
generated=json.loads((ROOT/'docs/art/opponent-art-provenance.json').read_text(encoding='utf-8'))
success={row['id']:row for row in generated if row['status']=='success'}
rows=[*catalog['minions'],*catalog['bosses']]
assert len(catalog['minions'])==30 and len(catalog['bosses'])==12
assert len({row['id'] for row in rows})==42
assert provenance['count']==42 and not provenance['missing']
source_hashes=set(); report=[]
for row in rows:
    key=row['id']; source=ROOT/'cards/opponents/sources'/f'{key}.png'
    digest=hashlib.sha256(source.read_bytes()).hexdigest()
    assert digest not in source_hashes,(key,'duplicate source')
    source_hashes.add(digest)
    if not row.get('hero'): assert key in success,(key,'missing image_gen record')
    files={}
    for name in ('subject','portrait','card'):
        path=ROOT/'public/art/opponents'/key/f'{name}.webp'
        with Image.open(path) as image:
            assert image.size==(512,768),(key,name,image.size)
            if name!='card':
                assert image.mode=='RGBA',(key,name,'missing alpha')
                lo,hi=image.getchannel('A').getextrema()
                assert lo==0 and hi>=240,(key,name,'empty or opaque image',lo,hi)
        assert path.stat().st_size<400*1024,(key,name,'oversized runtime art')
        files[name]=path.stat().st_size
    report.append({'id':key,'sourceSha256':digest,'files':files})

for element in ('metal','wood','water','fire','earth','boss'):
    shared=ROOT/'public/art/opponents/shared'
    with Image.open(shared/f'{element}-frame.webp') as frame:
        assert frame.size==(512,768) and frame.mode=='RGBA'
        lo,hi=frame.getchannel('A').getextrema()
        assert lo==0 and 0<hi<=82,(element,'frame opacity',lo,hi)
    with Image.open(shared/f'{element}-background.webp') as background:
        assert background.size==(512,768)
        if background.mode=='RGBA': assert background.getchannel('A').getextrema()==(255,255)

result={'count':42,'newGenerated':len(success),'reusedHeroes':sum(bool(r.get('hero')) for r in rows),
        'frameOpacity':.32,'runtimeSize':[512,768],'cards':report}
(ROOT/'cards/opponents/asset-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(f"PASS: {len(report)} unique opponents, {len(success)} generated cutouts, 3 reused hero portraits, 6 shared backgrounds/32%-opacity frames")
