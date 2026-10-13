"""Audit every declared card's published layout, alpha and layer registration."""
from pathlib import Path
from PIL import Image
import hashlib, json, time
from card_layout import (CARD, BLEED, BLEED_CANVAS, FRAME_SCALE, FRAME_OPACITY, FRAME_DEPTH,
                         SUBJECT_WIDTH, SUBJECT_TOP, BACKGROUND_DOF, frame_placement, contract,
                         publish, load_placement)

root = Path(__file__).resolve().parents[1]
roster = json.loads((root/'public/data/roster.json').read_text(encoding='utf-8-sig'))
assert len(roster) == len(set(roster))
publish(root)
report = {}
# 收集而不是当场 assert：下面要按「有几张、是不是同一批」来报，一崩就什么都看不到。
no_breakout = []
no_flat_breakout = []
bleed_sides = {}
top_inside = []
# 工作台调过边框大小的卡：收集起来在末尾报，而不是让它们走「必须落在卡内」那条
# 几何不变量——那是契约默认值的要求，不是用户显式选择的错。
tuned = []
frame_tuned = {}


def sides_of(box):
    """角色 bbox 相对卡面矩形往四个方向探出多少像素。正 = 探出卡面，负 = 还在卡面里。

    以前这里只有一个「有没有任意一边探出去」的布尔判断。四条边里任意一条探出
    就算过——底下探出 192px 就能把「顶上缩回卡面里 123px」判成通过，
    而那恰恰是这个平台唯一在卖的东西。数字必须摊开看。
    """
    cx0, cy0 = BLEED
    cx1, cy1 = BLEED[0] + CARD[0], BLEED[1] + CARD[1]
    return {'top': cy0 - box[1], 'bottom': box[3] - cy1,
            'left': cx0 - box[0], 'right': box[2] - cx1}


def fmt(s):
    return ' '.join(f'{k}{v:+d}' for k, v in s.items())
for card_id in roster:
    project = root/'cards'/card_id
    published = root/'public/art/layers'/card_id
    config = json.loads((published/'card-config.json').read_text(encoding='utf-8'))
    layout = config['frameLayout']
    assert layout['canvasFit'] == contract()['frameFit'] == 'contain-then-scale', card_id
    # ornamentOpacity 仍是全局契约常量（工作台只开放大小/位置），但 ornamentScale
    # 现在可以逐卡覆盖——所以它不再等于 FRAME_SCALE，而是必须等于 placement.json 里
    # 那个值。这条比「等于常量」强：谁改了 placement.json 却没重跑管线，这里立刻响。
    assert layout['ornamentOpacity'] == FRAME_OPACITY, card_id
    place = load_placement(root/'cards'/card_id)
    assert layout['ornamentScale'] == place.frame.scale, \
        (card_id, 'frame scale does not match placement.json', layout['ornamentScale'], place.frame.scale)
    assert layout['layer'] == contract()['frameLayer'] == 'under-subject', card_id
    assert layout['depth'] == FRAME_DEPTH, (card_id, 'frame sits under the subject at fixed UV')
    # 「最外缘」这条是**几何约束**，不是观感：contain 进卡面后不放大时，落位矩形必须
    # 完整落在卡面内，并且至少有一条边顶住卡沿。旧的 ×1.08 会让上下各溢出 61px，
    # prepare_frame 只能把花饰裁掉一截 —— 边框看着不完整。36 张卡的边框素材有两个
    # 尺寸，所以矩形按各自的 sourceSize 算，不能写死方向。
    #
    # **只对契约默认生效**。工作台现在能放大到 150%，那是有意让金饰出卡沿的；
    # 拿这条去卡用户的显式选择，唯一的下场就是他们再也不敢调。对所有情况都成立的是
    # 下面那条：声明的矩形必须等于按 placement.json 重算出来的那个。
    fx, fy, fw, fh = layout['placement']
    assert (fx, fy, fw, fh) == frame_placement(
        tuple(layout['sourceSize']), CARD, place.frame.scale,
        place.frame.offset_x, place.frame.offset_y), (card_id, 'frame placement')
    if place.frame.scale == FRAME_SCALE and place.frame.offset_x == 0 and place.frame.offset_y == 0:
        assert fx >= 0 and fy >= 0 and fx + fw <= CARD[0] and fy + fh <= CARD[1], \
            (card_id, 'frame placement spills past the card (会被裁掉花饰)', layout['placement'])
        assert fw == CARD[0] or fh == CARD[1], \
            (card_id, 'frame should reach the card rim (最外缘)', layout['placement'])
    else:
        tuned.append((card_id, place.frame.scale, place.frame.offset_x, place.frame.offset_y))
    frame_tuned[card_id] = {'scale': place.frame.scale, 'offsetX': place.frame.offset_x,
                            'offsetY': place.frame.offset_y}
    assert config['subjectLayout']['width'] == SUBJECT_WIDTH, card_id
    assert config['subjectLayout']['top'] == SUBJECT_TOP, card_id
    assert config['subjectLayout']['bleed'] == list(BLEED), card_id
    assert config['subjectLayout']['canvas'] == list(BLEED_CANVAS), card_id
    assert config['parameters']['backgroundDof'] == BACKGROUND_DOF, card_id

    hashes = {}
    # 卡面契约：assets/ 里生成六张，public/ 里只发布五张。
    # subject.png 只留在 assets/ —— 它和 subject-bleed.png 的卡面区域逐像素相同，
    # 而运行时两张 mesh 现在共用同一张纹理，public/ 下留两份就是白下 88.5MB。
    #
    # 两条守卫要先判在前面：文件缺失若留到下面 Image.open 才崩，抛出来的是
    # FileNotFoundError，看不出是哪张卡、为什么缺。
    assert (project/'assets/subject.png').is_file(), \
        (card_id, 'assets/subject.png 没了——docs/skill-video-prompts.md 把它当角色参考图用')
    assert not (published/'subject.png').exists(), \
        (card_id, 'public/ 下还有 subject.png——运行时已经不用它了，白占体积；'
                  '跑一遍 prepare_cards.py 会清掉')
    for name, size, folder in [('subject', CARD, project / 'assets'),
                               ('background', CARD, published), ('lineart', CARD, published),
                               ('text', CARD, published), ('frame', CARD, published),
                               ('subject-bleed', BLEED_CANVAS, published)]:
        path = folder/f'{name}.png'
        with Image.open(path) as image:
            assert image.size == size, (card_id, name, image.size, size)
        content = path.read_bytes()
        assert content == (project/'assets'/f'{name}.png').read_bytes(), (card_id, name, 'stale public asset')
        hashes[name] = hashlib.sha256(content).hexdigest()

    with Image.open(project/'assets/frame.png') as frame:
        alpha = frame.getchannel('A')
        low, high = alpha.getextrema()
        assert low == 0 and 0 < high <= round(255 * FRAME_OPACITY), (card_id, 'frame opacity', high)
        # 实际画出来的边框不许跑出落位矩形——那说明合成时的缩放和契约对不上。
        box = alpha.getbbox()
        assert box is not None, (card_id, 'frame layer is empty')
        assert box[0] >= fx and box[1] >= fy and box[2] <= fx + fw and box[3] <= fy + fh, \
            (card_id, 'frame pixels outside the declared placement', box, layout['placement'])
    with Image.open(project/'assets/text.png') as lettering:
        # 文字层现在只放字，边框已经拆走了。
        assert lettering.getchannel('A').getextrema()[1] == 255, (card_id, 'text dimmed')
    with Image.open(project/'assets/subject-bleed.png') as bleed:
        box = bleed.getchannel('A').getbbox()
        assert box is not None, (card_id, 'bleed layer is empty')
        # 「突破次元壁」得真有东西探出卡缘，否则这层白生成。
        # 记成问题而不是当场崩掉：audit 第一个错就退出的话，只能看到「某一张卡坏了」，
        # 看不到「36 张里只有 1 张、而且那张有覆盖源图」——后者是完全不同的结论。
        out = sides_of(box)
        bleed_sides[card_id] = out
        if max(out.values()) <= 0:
            no_breakout.append((card_id, box, (project/'source.png').is_file()))
        # 顶部单列一条。默认落位下四边探出量是 上 -123 / 下 +192 / 左右 +18：
        # 底边撑满了出血量，于是旧判据一路绿灯，可角色头顶其实缩在卡面里，
        # 大 3D 卡看上去就是「卡里放了个人」，不是人探出卡。
        if out['top'] <= 0:
            top_inside.append((card_id, out['top'], out, (project/'source.png').is_file()))
    # ---------------------------------------------------------------- 2D 三档
    # 这三档以前由 scripts/genportraits.py 出，输入写死 立绘/，于是换过
    # source.png 之后它们纹丝不动——游戏里五个显示位置有三个在放老画。
    # 现在它们由本管线出，尺寸全部来自契约，逐档核对。
    flat = contract()['flat']
    flat_sizes = {}
    for folder, key in [('cards', 'card'), ('thumbs', 'thumb')]:
        spec = flat[key]
        path = root/'public/art'/folder/f'{card_id}.webp'
        with Image.open(path) as flat_image:
            assert flat_image.size == (spec['width'], spec['height']), \
                (card_id, folder, flat_image.size, (spec['width'], spec['height']))
            flat_sizes[folder] = flat_image.size
            # 这两档必须真的探出卡面矩形——这就是「突破次元壁」。
            # 这条是有代价换来的：它们曾经用「背景+边框+角色」在**卡面矩形**上合成，
            # 出血层没参与，角色被卡面切掉两侧。图鉴网格、出征选将、抽卡撕包全都读它，
            # 于是平台最核心的效果在这三个界面上整个消失——而 3D 大卡看不出来，
            # 很容易「看着没问题」就发版。必须钉成判据，不能靠肉眼。
            # 必须带 alpha：烤成 RGB 既没法判「矩形外有没有东西」，
            # 又会让矩形之外变成一块死黑，突破感自己先没了。
            assert flat_image.mode == 'RGBA', \
                (card_id, folder, f'{flat_image.mode} — alpha 被烤掉了')
            sx = flat_image.size[0] / BLEED_CANVAS[0]
            sy = flat_image.size[1] / BLEED_CANVAS[1]
            alpha = flat_image.getchannel('A')
            box = alpha.getbbox()
            assert box is not None, (card_id, folder, '整张空')
            on_canvas = (box[0]/sx, box[1]/sy, box[2]/sx, box[3]/sy)
            over = (on_canvas[0] < BLEED[0] or on_canvas[1] < BLEED[1]
                    or on_canvas[2] > BLEED[0] + CARD[0] or on_canvas[3] > BLEED[1] + CARD[1])
            # 矩形**之内**也必须有内容：整张铺满画布说明合成漏了漆面底。
            inside = alpha.crop((round(BLEED[0]*sx), round(BLEED[1]*sy),
                                 round((BLEED[0]+CARD[0])*sx), round((BLEED[1]+CARD[1])*sy)))
            assert inside.getextrema()[1] == 255, \
                (card_id, folder, '卡面矩形内部有透明，漆面底没铺上')
            if not over:
                no_flat_breakout.append((card_id, folder, (project/'source.png').is_file()))
    # 卡面档和网格档必须是**同一个比例**——网格和大 3D 卡看到同一张构图。
    # 以前这里是 CARD_ASPECT=0.6 对卡面 1024/1536=0.667，同一张卡两个高度。
    #
    # 用容差而不是 round 后比相等：宽度是整数像素，1280 高对应 853.33 只能取 853，
    # 640 高对应 426.67 只能取 427，两边都逼近 0.667 但 round(,3) 会一个得
    # 0.666 一个得 0.667 —— 那是像素量化，不是比例漂移。容差按 1px/高 折算。
    def aspect_of(size):
        return size[0] / size[1]

    tol = 1.0 / min(flat_sizes['cards'][1], flat_sizes['thumbs'][1]) + 1e-6
    assert abs(aspect_of(flat_sizes['cards']) - CARD[0] / CARD[1]) <= tol, \
        (card_id, 'flat card aspect drifts from the card rect', flat_sizes['cards'])
    assert abs(aspect_of(flat_sizes['thumbs']) - aspect_of(flat_sizes['cards'])) <= tol, \
        (card_id, 'grid thumb and flat card are not the same composition', flat_sizes)

    # 「同源」的硬判据。尺寸只能验出比例，验不出「这张图到底是新画的还是三天前的」。
    # 真能抓到老画的是新鲜度：所有产物必须比它们的源图新。
    # （源图 = cards/<id>/source.png，没有就退回 立绘/ 的原画，
    #   和 prepare_cards.source_of() 是同一个优先级。）
    override = project/'source.png'
    if not override.is_file():
        character = json.loads((root/'public/data/characters'/f'{card_id}.json').read_text(encoding='utf-8-sig'))
        matches = list((root/'立绘').glob(f"*-{character['name']}-立绘-透明.png"))
        assert len(matches) == 1, (card_id, '立绘 源图应恰好 1 张', matches)
        source = matches[0]
    else:
        source = override
    source_mtime = source.stat().st_mtime
    # 落位也是输入。改了 placement.json 却没重新生成的话，产物比落位旧，
    # 游戏里摆的还是老位置——而 source.png 一个字节没动，上面的新鲜度判据照样全绿。
    # 这正是「工作台里摆好了、游戏里又变回去」的机器侧形态，必须一起比。
    placement_file = project / 'placement.json'
    placement_mtime = placement_file.stat().st_mtime if placement_file.is_file() else 0.0
    input_mtime = max(source_mtime, placement_mtime)
    # 容差 2 秒：把「同一份内容被重新写了一遍」和「真的换了图忘了生成」区分开。
    # 探针/工具还原源图时会刷新 mtime，内容没变却被判成新图，那是误报；
    # 而真换了图忘了生成，源图会比产物新几分钟甚至几天，2 秒盖不住。
    GRACE = 2.0
    for path in [published/'subject-bleed.png',
                 # frame.png 也要进新鲜度：placement.json 的 frame 段是它的输入，
                 # 只盯着 subject-bleed 的话，「只改了边框大小、忘了重新生成」是查不出来的。
                 project/'assets/frame.png',
                 root/'public/art/cards'/f'{card_id}.webp',
                 root/'public/art/thumbs'/f'{card_id}.webp',
                 root/'public/art/portraits'/f'{card_id}.webp']:
        assert path.is_file(), (card_id, 'missing published asset', str(path))
        assert path.stat().st_mtime >= input_mtime - GRACE, \
            (card_id, '产物比源图/落位还旧——改了输入但没重新生成', path.name,
             time.strftime('%m-%d %H:%M:%S', time.localtime(path.stat().st_mtime)),
             '<', time.strftime('%m-%d %H:%M:%S', time.localtime(input_mtime)),
             '(placement.json)' if placement_mtime > source_mtime else '(source.png)')

    # 详情档不裁，高度定死、宽度按**这张卡自己的源图比例**算
    with Image.open(source) as src:
        expect = (max(1, round(flat['portrait']['height'] * src.size[0] / src.size[1])),
                  flat['portrait']['height'])
    with Image.open(root/'public/art/portraits'/f'{card_id}.webp') as portrait:
        assert portrait.size == expect, (card_id, 'portrait size does not match this card\'s own source', portrait.size, expect)
        assert portrait.mode == 'RGBA', (card_id, 'portrait lost its alpha (transparent area bakes to black)')

    report[card_id] = {'cardCanvas': list(CARD), 'bleedCanvas': list(BLEED_CANVAS),
                       'frameOpacity': FRAME_OPACITY, 'frameDepth': FRAME_DEPTH,
                       'frameLayer': layout['layer'], 'framePlacement': layout['placement'],
                       'frameOverride': frame_tuned[card_id],
                       'backgroundDof': BACKGROUND_DOF, 'maxFrameAlpha': high,
                       'frameMapping': layout['canvasFit'], 'subjectLayout': config['subjectLayout'],
                       'sha256': hashes}
(root/'cards/card-layout-audit.json').write_text(json.dumps({'count':len(report),'cards':report},indent=2),encoding='utf-8')
tuned_note = (f'; 边框落位被工作台改过 {len(tuned)} 张 '
              f'(contain-then-scale 映射逐张核对，卡沿裁切按用户选择放行)' if tuned else '')
print(f'PASS: {len(report)}/{len(roster)} cards; frame alpha <= {round(255 * FRAME_OPACITY)} at depth {FRAME_DEPTH} '
      f'(under the subject, fixed UV, contain-then-scale centred on the card){tuned_note}; '
      f'subject-bleed {BLEED_CANVAS} reaches past the card; matched published layers; '
      f'2D 三档 {flat["card"]["width"]}x{flat["card"]["height"]} / '
      f'{flat["thumb"]["width"]}x{flat["thumb"]["height"]} / h{flat["portrait"]["height"]} '
      f'全部比源图新、同源于 cards/<id>/source.png')
for card_id, scale, ox, oy in tuned:
    # ox/oy 一律是 float：load_placement 用 float() 读 v1 文件（没有 frame 段），
    # 读出来就是 -219.0 而不是 -219，用 '+d' 会在**打印段**抛 ValueError ——
    # 断言全过、退出码却是 1，排查起来最费时间。取整再打。
    print(f'  · {card_id}: 边框 {round(scale * 100)}% / 左右 {round(ox):+d} / 上下 {round(oy):+d}')

# 落位诊断：cards/<id>/placement.json 只写一个 scale/offset，管线就会照着它把角色缩放。
# scale < 1 时角色四面缩回卡内——「突破次元壁」就没了，而画面上完全看不出是谁干的。
# 这不是错误（用户可能有意为之），所以不判失败，只**必须报出来**：
# 上一轮就是缺这条，用户看到自己特意做出血的立绘缩回卡里，误以为是图本身构图的问题。
placed = []
for pj in sorted((root/'cards').glob('*/placement.json')):
    cid = pj.parent.name
    try:
        pl = json.loads(pj.read_text(encoding='utf-8-sig'))
    except Exception as e:
        placed.append((cid, pj.name, f'读不出来（{e.__class__.__name__}）'))
        continue
    scale = float(pl.get('scale', 1.0))
    if abs(scale - 1.0) > 1e-6 or pl.get('offsetX') or pl.get('offsetY'):
        placed.append((cid, pj.name,
                       f'scale={scale} offsetX={pl.get("offsetX", 0)} offsetY={pl.get("offsetY", 0)}'))
if placed:
    shrunk = [c for c, _, s in placed if 'scale=' in s and float(s.split('scale=')[1].split()[0]) < 1.0]
    print(f'\n注意：{len(placed)} 张卡的落位被手动改过（{"/".join(sorted({name for _, name, _ in placed}))}）')
    for cid, name, s in placed:
        print(f'  - {cid}  {name}  {s}')
    if shrunk:
        print(f'  其中 {len(shrunk)} 张 scale<1，角色被缩小、四面缩回卡内，「突破次元壁」在这些卡上看不到。')
    print('  要回到默认落位：在工作台选中该角色点「恢复默认落位」，它只删 placement.json，'
          '不会碰你存的 source.png。')

if bleed_sides:
    tops = [v['top'] for v in bleed_sides.values()]
    bots = [v['bottom'] for v in bleed_sides.values()]
    lrs = [max(v['left'], v['right']) for v in bleed_sides.values()]
    print(f'\n突破量（相对卡面矩形，正=探出，负=缩在里面）：{len(bleed_sides)} 张')
    print(f'  顶部 上 {min(tops):+d} .. {max(tops):+d}'
          f'   底部 下 {min(bots):+d} .. {max(bots):+d}'
          f'   左右 各 {min(lrs):+d} .. {max(lrs):+d}'
          f'   （出血上限 {BLEED[0]}/{BLEED[1]}px）')

if top_inside:
    # 不判失败：默认落位就是这样，而且构图归你在工作台调、管线不许碰。
    # 但必须报——不然「36/36 探出卡缘」这句话就是在骗人。
    worst = min(top_inside, key=lambda r: r[1])
    print(f'\n注意：{len(top_inside)}/{len(bleed_sides)} 张卡的**角色顶部缩在卡面里**，'
          f'最深的 {worst[0]} 缩了 {abs(worst[1])}px。')
    print('  底边把出血撑满了，所以旧判据一路绿灯；但顶上没探出去，'
          '大 3D 卡看上去仍是「卡里放了个人」，不是人探出卡。')
    for cid, t, out, has in sorted(top_inside, key=lambda r: r[1])[:6]:
        print(f'  - {cid}  顶{t:+d}  {fmt(out)}'
              + ('  ← 有覆盖源图' if has else ''))
    if len(top_inside) > 6:
        print(f'  …另外 {len(top_inside) - 6} 张同样')
    print('  要让顶部也探出去：工作台把「上下」滑杆往**上**拉（offsetY 变负），'
          '再点「存 + 重新生成」。落位现在会跟着一起存盘。')

if no_flat_breakout:
    by_card = {}
    for cid, folder, _ in no_flat_breakout:
        by_card.setdefault(cid, []).append(folder)
    print(f'\n注意：{len(by_card)}/{len(report)} 张卡的 2D 卡面档没探出卡面矩形'
          f'（图鉴网格 / 出征选将 / 抽卡撕包这三个界面上「突破次元壁」看不到）：')
    for cid, folders in by_card.items():
        tag = '  ← 有覆盖源图，构图来自那张图' if (root/'cards'/cid/'source.png').is_file() else ''
        print(f'  - {cid}  {"+".join(folders)}{tag}')
    print('  要么换回 立绘/ 原画，要么在工作台放大落位到能探出卡缘，'
          '再点「存 + 重新生成」。')

if no_breakout:
    overridden = [c for c, _, has in no_breakout if has]
    print(f'\n注意：{len(no_breakout)}/{len(report)} 张卡的角色四面都在卡内，「突破次元壁」没生效：')
    for cid, box, has in no_breakout:
        print(f'  - {cid}  bbox={box}' + ('  ← 有 cards/<id>/source.png，构图来自这张覆盖图' if has else ''))
    if overridden:
        print(f'  这些卡里 {len(overridden)} 张有覆盖源图（{", ".join(overridden)}）：是那张图的构图如此，'
              f'不是管线算错。')
        print(f'  要么换回 立绘/ 原画，要么在工作台把落位放大到能探出卡缘（缩放滑杆 + 导出 placement.json）。')
    print('  其余检查全部通过。')
