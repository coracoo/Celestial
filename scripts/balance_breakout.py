"""批量把「角色顶部缩在卡面里」的角色摆到上下都探出卡缘。

为什么不能只挪 offsetY
----------------------
**顶部和底部的探出量之和是死的**：它等于立绘缩放后比卡面高出来的那一截，
offsetY 只能把这一截在上下之间重新分配。实测 33 张卡这个总量只有 51~71px，
平分下来上下各 26~36px——卡面高的 2%，大 3D 卡上根本看不出「探出去」，
等于白搬一次。所以必须先放大 scale 造出预算，再用 offsetY 把它分下去。

求解是闭式的
------------
card_layout.subject_box 里图框的上沿是 `BLEED[1] + round(CARD[1]*SUBJECT_TOP/1536)
+ offsetY`——**和 scale 无关**，而图框高与图框宽成正比。于是

    top = BLEED[1] - (上沿 + α·图框高)          α = 剪影上沿在图框内的归一位置
    要 top == target  ⇒  offsetY = -SUBJECT_TOP - target - α·新图框高

而 α 从**成品像素**上量（不是从公式算）——`_feather_top` 会把顶上 64px 羽化掉，
剪影真实起点比图框低六十多像素。闭式解完 bottom 必然也是 target（预算守恒）。

碰的和不碰的
------------
- 只写 cards/<id>/placement.json。SUBJECT_WIDTH / SUBJECT_TOP 一个都没动——
  构图仍然是工作台说了算、管线只执行。
- **顶部已经探出去的卡一张都不碰**（默认 3 张：lujunyi / dongping / liutang，
  那是人在工作台里自己调过的）。要一起重摆用 --force。
- 每张卡的 frame 段原样保留：人物落位和边框落位是两个独立维度。

用法
----
    python scripts/balance_breakout.py                 # 只算不写（默认）
    python scripts/balance_breakout.py --apply
    python scripts/balance_breakout.py --apply --target 150
    python scripts/balance_breakout.py --revert        # 删掉这批 placement.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from card_layout import (CARD, BLEED, SUBJECT_TOP, SUBJECT_WIDTH, BLEED_CANVAS,  # noqa: E402
                         Placement, load_placement, subject_box)

ROOT = Path(__file__).resolve().parent.parent
TOP_ANCHOR_Y = BLEED[1] + round(CARD[1] * SUBJECT_TOP / 1536)   # 图框上沿的常量部分 = 312
CARD_BOTTOM_Y = BLEED[1] + CARD[1]
MAX_BREAK = BLEED[1]          # 探出上限：再多就被出血画布裁掉
MIN_TOP = 24                  # 多少 px 才算「看得出来探出去了」
SCALE_CAP = 1.35              # 不许因为源图特殊就放到离谱


def character(cid: str) -> dict:
    return json.loads((ROOT / 'public/data/characters' / f'{cid}.json')
                      .read_text(encoding='utf-8-sig'))


def silhouette(cid: str) -> tuple[int, int, int, int]:
    with Image.open(ROOT / 'public/art/layers' / cid / 'subject-bleed.png') as im:
        box = im.convert('RGBA').getchannel('A').getbbox()
    assert box is not None, f'{cid}: 出血层是空的'
    return box


def source_alpha(cid: str) -> tuple[tuple[int, int], tuple[int, int]]:
    """这张卡真正在用的源图尺寸 + 它**自身**的 alpha 包围盒。"""
    override = ROOT / 'cards' / cid / 'source.png'
    path = override if override.is_file() else None
    if path is None:
        name = character(cid)['name']
        hits = list((ROOT / '立绘').glob(f'*{name}-立绘-透明.png'))
        if len(hits) != 1:
            raise RuntimeError(f'{cid}/{name}: 立绘源图找到 {len(hits)} 个，应为 1')
        path = hits[0]
    with Image.open(path) as im:
        rgba = im.convert('RGBA')
        box = rgba.getchannel('A').getbbox()
        return im.size, (box if box else (0, 0, im.size[0], im.size[1]))


def solve_from(src_box: tuple[int, int, int, int], source: tuple[int, int],
               target: int) -> dict:
    """闭式解。**纯函数**：不读文件、不碰全局，方便钉成单测。

    src_box 是**源图自身**的 alpha 包围盒。不能用成品上的包围盒——高瘦源图在
    默认落位下已经溢出出血画布几百像素（李应 941×1672 在 scale 1 时图框高 1883，
    下沿落到 y=2195 而画布只有 1920），量到的包围盒是被**裁过**的，拿它当基准
    算出来的 scale 偏大、offsetY 补过头，最后底部还是顶在出血上限 192——脚被裁掉。

    规则只有一条：**让图框高恰好 = 卡面高 + 2×target**。
    高瘦源图因此是「缩小」，矮胖源图是「放大」，不需要分情况。
    """
    sw, sh = source
    alpha_top = src_box[1] / sh
    alpha_bot = src_box[3] / sh
    if alpha_bot - alpha_top <= 1e-6:
        raise ValueError('源图 alpha 是空的')

    fh_new = (CARD[1] + 2 * target) / (alpha_bot - alpha_top)
    fw_new = round(fh_new * sw / sh)
    scale_new = fw_new / SUBJECT_WIDTH
    if not 0.4 <= scale_new <= SCALE_CAP:
        return {'skip': 'scale-out-of-range', 'scale': scale_new}
    _, _, _, nh = subject_box(sw, sh, Placement(scale=scale_new))
    nx, ny, nw, _ = subject_box(sw, sh, Placement(scale=scale_new))
    # 水平方向也必须放得下：图框比出血画布还宽的话，两边都会被裁。
    if nx < 0 or nx + nw > BLEED_CANVAS[0]:
        return {'skip': 'horizontally-clipped', 'x': nx, 'x1': nx + nw}
    offsetY_new = round(BLEED[1] - target - alpha_top * nh - TOP_ANCHOR_Y)

    new_top = BLEED[1] - (TOP_ANCHOR_Y + offsetY_new + alpha_top * nh)
    new_bottom = (TOP_ANCHOR_Y + offsetY_new + alpha_bot * nh) - CARD_BOTTOM_Y
    return {'scale': round(scale_new, 4), 'offsetY': offsetY_new,
            'new_top': new_top, 'new_bottom': new_bottom,
            'ok': abs(new_top - target) <= 2 and abs(new_bottom - target) <= 2
                   and new_top <= MAX_BREAK and new_bottom <= MAX_BREAK}


def solve(cid: str, target: int) -> dict:
    source, src_box = source_alpha(cid)
    place = load_placement(ROOT / 'cards' / cid)
    x0, y0, x1, y1 = silhouette(cid)
    r = {'id': cid, 'top': BLEED[1] - y0, 'bottom': y1 - CARD_BOTTOM_Y,
         'old_scale': place.scale, 'old_offsetY': place.offset_y}
    if r['top'] >= MIN_TOP:
        return {**r, 'skip': 'already'}
    r.update(solve_from(src_box, source, target))
    if r.get('ok'):
        r['payload'] = {'scale': r['scale'], 'offsetX': round(place.offset_x, 1),
                        'offsetY': r['offsetY'], 'frame': place.frame.to_json()}
    else:
        r['skip'] = 'does-not-converge'
    return r


def main() -> int:
    ap = argparse.ArgumentParser(description='批量把角色摆到上下都探出卡缘')
    ap.add_argument('--target', type=int, default=120,
                    help='上下各探出多少 px（默认 120，约卡面高的 7.8%%）')
    ap.add_argument('--apply', action='store_true', help='真的写 placement.json')
    ap.add_argument('--force', action='store_true', help='连顶部已探出的卡也一起重摆')
    ap.add_argument('--revert', action='store_true', help='删掉全部 placement.json，回默认落位')
    ap.add_argument('--verify', action='store_true',
                    help='量一遍成品的真实像素，报告上下探出量（跑完管线之后用）')
    args = ap.parse_args()

    roster = json.loads((ROOT / 'public/data/roster.json').read_text(encoding='utf-8-sig'))

    if args.verify:
        # 不信闭式解。模型算的是「图框」，玩家看到的是「剪影」，中间隔着羽化、
        # LANCZOS 重采样和画布裁切。跑完管线之后一定用真实像素对一遍。
        bad, clipped = [], []
        print(f'{"卡":<12}{"实测 顶/底":>15}{"目标":>8}   判词')
        print('-' * 66)
        for cid in roster:
            x0, y0, x1, y1 = silhouette(cid)
            top, bottom = BLEED[1] - y0, y1 - CARD_BOTTOM_Y
            tuned = load_placement(ROOT / 'cards' / cid)
            tag = ''
            if top < MIN_TOP:
                tag, bad = '顶部还在卡面里', bad + [cid]
            elif abs(top - args.target) > 6 or abs(bottom - args.target) > 6:
                # 你自己调过的那几张不追求 ±target，只要上下都探出就行
                if not tuned.to_json() == Placement().to_json():
                    tag = ''
                else:
                    tag, bad = f'偏离目标 {top - args.target:+d}/{bottom - args.target:+d}', \
                        bad + [cid]
            if bottom >= MAX_BREAK or top >= MAX_BREAK:
                clipped.append(cid)
            print(f'{cid:<12}{f"{top:+d}/{bottom:+d}":>15}{args.target:>8}   {tag}')
        print(f'\n顶部没探出 / 偏离目标：{len(bad)} 张 {bad if bad else ""}')
        print(f'贴到出血上限（会被裁）：{len(clipped)} 张 {clipped if clipped else ""}')
        return 1 if bad else 0

    if args.revert:
        n = 0
        for cid in roster:
            p = ROOT / 'cards' / cid / 'placement.json'
            if p.is_file():
                p.unlink()
                n += 1
        print(f'已删掉 {n} 份 placement.json。跑一遍 prepare_cards.py 就回到默认落位。')
        return 0

    print(f'目标：上下各探出 {args.target}px（出血上限 ±{MAX_BREAK}px，'
          f'需要可分配总量 ≥ {2 * args.target}）')
    print(f'{"卡":<12}{"现 顶/底":>13}{"新 顶/底":>13}{"scale":>18}{"offsetY":>20}')
    print('-' * 82)

    todo, notes = [], []
    for cid in roster:
        r = solve(cid, args.target)
        if 'payload' in r:
            print(f'{cid:<12}{f"{r["top"]:+d}/{r["bottom"]:+d}":>13}'
                  f'{f"{r["new_top"]:+.0f}/{r["new_bottom"]:+.0f}":>13}'
                  f'{f"{r["old_scale"]:g}→{r["scale"]:.3f}":>18}'
                  f'{f"{r["old_offsetY"]:+.0f}→{r["offsetY"]:+d}":>20}')
            todo.append((cid, r['payload']))
            continue
        if r['skip'] == 'already':
            notes.append(f'{cid} 已探出顶{r["top"]:+d}，跳过'
                         + ('' if args.force else '（--force 可强制）'))
        else:
            notes.append(f'{cid} {r["skip"]}，跳过'
                         f'（现 {r["top"]:+d}/{r["bottom"]:+d}）')

    print(f'\n需要摆 {len(todo)} 张。')
    for n in notes:
        print('  · ' + n)
    if not args.apply:
        print('\n没写任何文件（默认 dry-run）。加 --apply 落盘。')
        return 0

    for cid, payload in todo:
        (ROOT / 'cards' / cid / 'placement.json').write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'\n已写 {len(todo)} 份 placement.json。接着跑：')
    print('  python scripts/prepare_cards.py')
    print('  python scripts/balance_breakout.py --verify   # 量一遍真实像素')
    print('  python scripts/audit_card_layout.py')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
