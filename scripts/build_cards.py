"""Build all prepared RuiC cards with project-local Blender configuration."""
from pathlib import Path
import argparse, json, shutil, subprocess, sys, struct, hashlib

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--blender', default='J:/Blender 5.2/blender.exe')
parser.add_argument('--skip-render', action='store_true')
parser.add_argument('--force', action='store_true', help='Rebuild even if content matches the previous successful build')
parser.add_argument('--publish-only', action='store_true', help='Publish prepared runtime layers immediately without building Blender scenes')
args = parser.parse_args()
pipeline = root / '.agents/skills/RuiC-card-skill/scripts/run_pipeline.py'
report = {}
roster_path = root / 'public/data/roster.json'
roster = json.loads(roster_path.read_text(encoding='utf-8-sig'))
if len(roster) != len(set(roster)):
    raise RuntimeError('Declared roster contains duplicate ids')

def publish_layers(project):
    public = root / 'public/art/layers' / project.name
    public.mkdir(exist_ok=True)
    for asset in ('subject', 'background', 'lineart', 'text'):
        shutil.copy2(project / f'assets/{asset}.png', public / f'{asset}.png')
    config = json.loads((project / 'card-config.json').read_text(encoding='utf8'))
    config['assets'] = {name: f'/art/layers/{project.name}/{name}.png' for name in ('subject','background','lineart','text')}
    config['assets']['model'] = '/art/layers/card.glb'
    (public / 'card-config.json').write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding='utf8')

# Runtime layers are made complete first; individual packed Blender scenes can
# then rebuild in the background without temporarily leaving roster holes.
for character_id in roster:
    publish_layers(root / 'cards' / character_id)
shared_model = root / 'cards/songjiang/web/assets/card.glb'
if shared_model.exists():
    shutil.copy2(shared_model, root / 'public/art/layers/card.glb')
print('Published runtime layer contracts for', len(roster), 'declared cards', flush=True)
if args.publish_only:
    if not (root / 'public/art/layers/card.glb').exists():
        raise RuntimeError('Shared GLB is missing; run the full pipeline first')
    sys.exit(0)

def build_signature(project):
    digest = hashlib.sha256()
    sources = [project / 'card-config.json', *sorted((project / 'assets').glob('*.png'))]
    sources += [pipeline, pipeline.parent / 'build_card.py', pipeline.parent / 'export_web.py']
    sources += sorted((pipeline.parent.parent / 'assets/web-template').glob('*.*'))
    for source in sources:
        digest.update(source.name.encode('utf8'))
        digest.update(source.read_bytes())
    digest.update(str(Path(args.blender).resolve()).encode('utf8'))
    return digest.hexdigest()

for character_id in roster:
    project = root / 'cards' / character_id
    signature = build_signature(project)
    stamp = project / 'build-signature.json'
    previous = json.loads(stamp.read_text(encoding='utf8')) if stamp.exists() else {}
    outputs_ready = (project / 'card.blend').exists() and (project / 'web/assets/card.glb').exists()
    if not args.skip_render:
        outputs_ready = outputs_ready and (project / 'renders/hero.png').exists() and previous.get('rendered') is True
    rebuild = args.force or not outputs_ready or previous.get('sha256') != signature
    if rebuild:
        command = [sys.executable, str(pipeline), '--project', str(project), '--blender', args.blender, '--skip-npm']
        if args.skip_render:
            command.append('--skip-render')
        with (project / 'pipeline.log').open('w', encoding='utf8') as log:
            subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
        stamp.write_text(json.dumps({'sha256': signature, 'rendered': not args.skip_render}, indent=2), encoding='utf8')
    glb = project / 'web/assets/card.glb'
    data = glb.read_bytes()
    length, kind = struct.unpack_from('<II', data, 12)
    if kind != 0x4e4f534a:
        raise RuntimeError('Invalid GLB JSON chunk')
    model = json.loads(data[20:20+length])
    roles = sorted({material['name'] for material in model['materials']})
    required = {'web_front', 'web_back', 'web_edge', 'web_gold'}
    if not required.issubset(roles) or not model.get('meshes'):
        raise RuntimeError(f'{project.name}: GLB missing geometry/roles')
    publish_layers(project)
    report[project.name] = {'roles': roles, 'meshes': len(model['meshes']), 'glbBytes': len(data), 'sha256': signature, 'rebuilt': rebuild,
                            'blend': str(project / 'card.blend'), 'render': str(project / 'renders/hero.png')}
    print(project.name, 'editable scene + real GLB ready', flush=True)

shutil.copy2(root / 'cards/songjiang/web/assets/card.glb', root / 'public/art/layers/card.glb')
(root / 'cards/build-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
print('Published shared official geometry and all per-card layer contracts', flush=True)
current_roster = json.loads(roster_path.read_text(encoding='utf-8-sig'))
loose_ids = sorted(p.stem for p in (root / 'public/data/characters').glob('*.json') if p.stem not in roster)
(root / 'cards/roster-build-report.json').write_text(json.dumps({
    'declaredSnapshot': roster, 'count': len(roster), 'declarationChangedDuringBuild': current_roster != roster,
    'currentDeclared': current_roster, 'looseCharacterFilesExcluded': loose_ids,
}, ensure_ascii=False, indent=2), encoding='utf8')
if current_roster != roster:
    print('Roster changed during build; rerun to cover the new declaration', flush=True)
