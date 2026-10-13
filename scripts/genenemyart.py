#!/usr/bin/env python3
"""
把 public/art/enemies/ 的五行靶点原图压成 WebP。

为什么要这一步：原图是 1024×1536 的 24bpp RGB PNG，每张约 3MB，五张合计 15.6MB。
但敌人钉的世界半径只有 0.55，18 单位宽的盘面映射到常见 1600px 视口约 89px/单位——
敌人实际显示高度只有 90~100px。贴图比显示尺寸大 16 倍，而每关五枚敌人正好覆盖
金木水火土，进战斗就会把五张图全部拉下来，15.6MB 换不到任何视觉收益。

这个项目本来就有 scripts/genportraits.py 走同一条 WebP 路线，敌人图却漏在外面。
统一到 512×768（与原图同为 2:3，无裁切）后合计约 0.5MB。

同时把 provenance.json 里指向的产物同步改成 WebP —— 那个文件是给后来人查
「这张图从哪来的」用的，留着指向已不存在的 .png 就等于把索引写坏了。

用法：
    python scripts\\genenemyart.py            # 已有 .webp 就跳过
    python scripts\\genenemyart.py --force    # 全部重做
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from PIL import Image

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / 'public' / 'art' / 'enemies'
PROV = DIR / 'provenance.json'

# 与原图同为 2:3，纯缩放不裁切
W, H = 512, 768
QUALITY = 82

ELEMENTS = ('metal', 'wood', 'water', 'fire', 'earth')


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    force = '--force' in sys.argv
    if not DIR.is_dir():
        print(f'!! 找不到 {DIR}')
        return 1

    total_before = 0
    total_after = 0
    entries: list[dict] = []

    for el in ELEMENTS:
        src = DIR / f'{el}.png'
        dst = DIR / f'{el}.webp'
        if not src.is_file():
            print(f'!! 缺少原图 {src.name}，跳过')
            continue

        total_before += src.stat().st_size
        if dst.is_file() and not force:
            kb = dst.stat().st_size / 1024
            total_after += dst.stat().st_size
            print(f'  {el:<6} 已有 {dst.name}  {kb:7.1f} KB   (加 --force 重做)')
            entries.append({
                'element': el,
                'file': dst.name,
                'source_filename': src.name,
                'bytes': dst.stat().st_size,
                'sha256': sha256(dst),
            })
            continue

        with Image.open(src) as im:
            im = im.convert('RGB').resize((W, H), Image.Resampling.LANCZOS)
            im.save(dst, 'WEBP', quality=QUALITY, method=6)

        total_after += dst.stat().st_size
        kb_before = src.stat().st_size / 1024
        kb_after = dst.stat().st_size / 1024
        print(f'  {el:<6} {kb_before:7.1f} KB → {kb_after:7.1f} KB   '
              f'({kb_before / kb_after:.1f}×)')
        entries.append({
            'element': el,
            'file': dst.name,
            'source_filename': src.name,
            'bytes': dst.stat().st_size,
            'sha256': sha256(dst),
        })

    if entries and PROV.is_file():
        prov = json.loads(PROV.read_text(encoding='utf-8'))
        by_el = {e['element']: e for e in entries}
        merged = []
        for old in prov.get('assets', []):
            el = old.get('element')
            if el in by_el:
                new = by_el[el]
                # 别把溯源链弄断：source_filename 记的是生图工具吐出的那个原始文件，
                # 不是本地的中间态 PNG。保留它，再单独说明中间态已删。
                if old.get('source_filename'):
                    new['source_filename'] = old['source_filename']
                new['intermediate_png'] = '已删除（仅作 WebP 转换输入，仓库不保留）'
                merged.append(new)
            else:
                merged.append(old)
        prov['assets'] = merged
        prov['derived'] = {
            'script': 'scripts/genenemyart.py',
            'note': ('assets[].file 是入库的 WebP 产物；source_filename 是生图工具的原始输出；'
                     'intermediate_png 为转换用的本地中间态，已删除，需要重跑本脚本请先用 '
                     'source_filename 找回原图。'),
            'size': f'{W}x{H}',
            'quality': QUALITY,
        }
        PROV.write_text(json.dumps(prov, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print('  provenance.json 已同步指向 .webp')

    if total_before:
        print(f'\n合计 {total_before / 1048576:.1f} MB → {total_after / 1048576:.1f} MB '
              f'（省 {(total_before - total_after) / 1048576:.1f} MB）')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
