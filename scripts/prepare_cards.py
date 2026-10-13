"""Preserve the supplied artwork and prepare the RuiC aligned layer contract.

四条分层不变量（承自 RuiC-card-skill 的 layer contract，措辞参考
EverettFish/holo-card-studio 的 references/art-direction.md —— 只取结构，
不取它的浮世绘默认画风，那套和本项目的国风赛璐璐正面冲突）：

1. 文字层永远由脚本合成，不进图像模型。标题、称号、技术名、版号都是配置里的
   已知字符串，用装了所需字形的字体（simkai.ttf）排版即可。让图像模型去"画"精确
   字形，得到的是形近但错字，而错字在卡面上比模糊更刺眼。
2. lineart.png 必须与 subject 同源导出，不许独立生成。本文件下面用同一张 raster
   走 FIND_EDGES + alpha 阈值得到轮廓，就是这条的实现：图像模型的二次编辑不保证
   像素级配准，重新描一遍线只会让发光的勾边漂到错误的位置。
3. 装配后再查一次配准，重点是眼睛、手指、发梢这类细结构。这些地方在 subject 上
   看着没问题，叠上箔面和线发光之后最容易糊掉，所以检查对象是装配后的卡面。
4. foil 与线发光的强度要压在"画仍然可读"这条线以下。强度可以高到出效果，
   但不能把五官和织物细节埋掉——材质是加在画上的，不是替代画。
"""
from pathlib import Path
from PIL import Image, ImageOps, ImageFilter
import json, shutil, sys, importlib.util, argparse
from card_layout import (CARD, BLEED, BLEED_CANVAS, FRAME_OPACITY, FRAME_DEPTH,
                         BACKGROUND_DOF, SUBJECT_WIDTH, SUBJECT_TOP, prepare_subject, prepare_bleed,
                         prepare_frame, frame_placement, publish, load_placement, mask_channel,
                         FLAT_CARD_W, FLAT_CARD_H, FLAT_QUALITY, PORTRAIT_H,
                         THUMB_W, THUMB_H, THUMB_QUALITY)

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / '.agents/skills/RuiC-card-skill'
spec = importlib.util.spec_from_file_location('typography', SKILL / 'scripts/generate_typography.py')
typography = importlib.util.module_from_spec(spec)
spec.loader.exec_module(typography)
sys.path.insert(0, str(SKILL / 'scripts'))
from validate_assets import validate

W, H = CARD
# assets/ 里生成什么，public/art/layers/ 里发布什么，是两件事。
#
# subject.png 与 subject-bleed.png 的卡面区域逐像素相同（就是同一张角色图裁一刀），
# 而运行时两张 mesh 现在共用同一张纹理：卡面那张经 toBleed() 采卡面区域，背面那张
# 直接采全画布。所以 public/ 下只需要 subject-bleed.png 一张，36 张共省 88.5MB。
#
# 但 assets/subject.png **必须留着**：docs/skill-video-prompts.md 把
# public/art/layers/<id>/subject.png 当作角色参考图喂给视频生成，
# 直接删会让那套文档工作流失效。它是交付物，不是运行时纹理。
BUILT = ['subject', 'background', 'lineart', 'text', 'frame', 'subject-bleed']
SHIPPED = ['background', 'lineart', 'text', 'frame', 'subject-bleed']


def readable_typography(config, lettering):
    """Lettering only — no plate behind it.

    以前每行字底下都垫一块模糊的黑底圆角矩形（alpha 225）。本轮把它删了：
    文字排在角色**上面**之后，那块黑底正好压在人物的脸和裙摆上，
    看上去就是「名字底下垫了块黑砖」。要压底就压底，压在纸上、压在人身上都难看。

    留着的只有 3px 的墨色描边——那是笔画自己的轮廓，不是底，
    小缩略图上靠它保住字与字的分离度。
    """
    ink = Image.new('RGBA', (W, H), (6, 8, 12, 0))
    ink.putalpha(lettering.getchannel('A').filter(ImageFilter.MaxFilter(7)))
    out = ink
    out.alpha_composite(lettering)
    return out


def artwork(name, kind):
    matches = list((ROOT / '立绘').glob(f'*{name}-{kind}-透明.png'))
    if len(matches) != 1:
        raise RuntimeError(f'{name} {kind}: expected one source, found {len(matches)}')
    return matches[0]


SOURCE_FILE = 'source.png'


def source_of(character):
    """人物源图。`cards/<id>/source.png` 是工作台「存为该角色源图」存下来的，
    有它就用它；没有才回落到 立绘/{编号}-{中文名}-立绘-透明.png。

    工作台那边是 tools/cutout.html 的 sourceOverridePath()。两边必须说同一件事，
    否则工作台上看到的是一张图、生成出来的是另一张。
    """
    override = ROOT / 'cards' / character['id'] / SOURCE_FILE
    return override if override.is_file() else artwork(character['name'], '立绘')


def load_matte(project, character_id):
    """The cutout studio's hand-painted alpha, if this card has one.

    Absent means "keep the source alpha", which is the old automatic behaviour.
    The studio exports it at the bleed-canvas size; see tools/cutout.html.
    """
    file = project / 'matte.png'
    if not file.exists():
        return None
    with Image.open(file) as image:
        # 读 alpha，不是 convert('L')：工作台导出的蒙版是 RGBA、值在 alpha 里，
        # 而 PIL 的 RGBA->L 会丢掉 alpha 只看 RGB（RGB 全白）——那样蒙版恒等于全通。
        matte = mask_channel(image)
    if matte.size != BLEED_CANVAS:
        matte = matte.resize(BLEED_CANVAS, Image.Resampling.LANCZOS)
    return matte


background = Image.open(ROOT / 'public/art/scene/lacquer.png').convert('RGB').resize((W, H), Image.Resampling.LANCZOS)
roster = json.loads((ROOT / 'public/data/roster.json').read_text(encoding='utf-8-sig'))
if len(roster) != len(set(roster)):
    raise RuntimeError('Declared roster contains duplicate ids')
parser = argparse.ArgumentParser()
parser.add_argument('--ids', nargs='+', help='Prepare selected declared cards for visual iteration')
args = parser.parse_args()
selected = args.ids or roster
if not set(selected).issubset(roster):
    raise RuntimeError('Selected id is not in the declared roster')
publish(ROOT)
print('layout contract published:', json.dumps({'subjectCanvas': BLEED_CANVAS, 'bleed': BLEED,
                                                 'frameOpacity': FRAME_OPACITY}))
for character_id in selected:
    file = ROOT / 'public/data/characters' / (character_id + '.json')
    character = json.loads(file.read_text(encoding='utf-8-sig'))
    project = ROOT / 'cards' / character['id']
    assets = project / 'assets'
    assets.mkdir(parents=True, exist_ok=True)
    original = Image.open(source_of(character)).convert('RGBA')
    matte = load_matte(project, character['id'])
    # 落位默认 = 旧管线，产出与改动前逐字节一致。工作台导出 placement.json 才覆盖。
    place = load_placement(project)
    subject = prepare_subject(original, matte, place)
    subject.save(assets / 'subject.png')
    # The oversized twin. Same placement, nothing clipped: the runtime draws the
    # margin past the card edge, which is the "break the frame" effect.
    prepare_bleed(original, matte, place).save(assets / 'subject-bleed.png')
    background.save(assets / 'background.png')
    # The exact same raster creates the contour mask; no independently generated pose.
    gray = subject.convert('RGB').convert('L')
    edges = gray.filter(ImageFilter.FIND_EDGES)
    mask = subject.getchannel('A').point(lambda x: 255 if x > 32 else 0)
    contour = ImageOps.invert(edges).point(lambda x: 0 if x < 215 else 255)
    line = Image.new('L', (W, H), 255)
    line.paste(contour, mask=mask)
    line.convert('RGB').save(assets / 'lineart.png')
    # 边框源图要先打开：落位矩形要写进 card-config，帧本身后面再合成。
    # 36 张卡的边框素材有两个尺寸（32 张 941x1672、4 张 1024x1536），
    # contain 吃哪条边取决于源图和卡面谁更「长」，所以矩形得逐卡算。
    # 缩放/偏移来自 placement.json 的 frame 段（工作台导出）；没导出就是 FRAME_SCALE。
    frame_source = Image.open(artwork(character['name'], '边框'))
    furniture = prepare_frame(frame_source, scale=place.frame.scale,
                              offset_x=place.frame.offset_x, offset_y=place.frame.offset_y)
    furniture.save(assets / 'frame.png')
    config = {
        'title': character['name'], 'subtitle': character['title'],
        'technique': character['skill']['name'], 'tagline': character['rarity'] + ' · ' + character['role'],
        'edition': f"No.{character['number']:03d} / 108", 'collection': 'Celestial Heroes',
        'description': character['lore'], 'font': 'C:/Windows/Fonts/simkai.ttf',
        'assets': {name: './assets/' + name + '.png' for name in BUILT},
        'parameters': {'subjectScale': 1.0, 'subjectDepth': 0.4, 'backgroundDepth': -0.25,
                       'frameDepth': FRAME_DEPTH, 'backgroundDof': BACKGROUND_DOF,
                       # 不变量 4：0.62 是"画仍可读"的上限，不是"效果越大越好"的旋钮。
                       # 再往上加就会开始吃掉五官和织物褶皱——赛璐璐只有两三档明暗，
                       # 被自发光盖过之后没有层次可以退回。调高之前先看装配卡面。
                       'foil': 0 if character['card']['holo'] == 'none' else 0.62},
        'safeArea': {'scale': 1, 'offset': [0, 0]},
        'subjectLayout': {'fit': 'proportional-width', 'width': SUBJECT_WIDTH, 'top': SUBJECT_TOP,
                          'sourceSize': list(original.size), 'topFeather': 64,
                          'bleed': list(BLEED), 'canvas': list(BLEED_CANVAS),
                          'placement': place.to_json()},
        'frameLayout': {'ornamentScale': place.frame.scale, 'ornamentOpacity': FRAME_OPACITY,
                        'canvasFit': 'contain-then-scale', 'anchor': 'card-center',
                        'depth': FRAME_DEPTH, 'layer': 'under-subject',
                        'sourceSize': list(frame_source.size),
                        'placement': list(frame_placement(frame_source.size, CARD, place.frame.scale,
                                                          place.frame.offset_x,
                                                          place.frame.offset_y))},
    }
    (project / 'card-config.json').write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding='utf8')
    typography.create(project)
    # 边框是独立图层，排在角色**下面**（中间层），70% 不透明。
    lettering = Image.open(assets / 'text.png').convert('RGBA')
    readable_typography(config, lettering).save(assets / 'text.png')
    validate(project)
    public = ROOT / 'public/art/layers' / character['id']
    public.mkdir(parents=True, exist_ok=True)
    for name in SHIPPED:
        shutil.copy2(assets / (name + '.png'), public / (name + '.png'))
    # 不发布的那几张必须真的从 public/ 里删掉。光是不复制不够——
    # 上一版留下的 subject.png 会一直躺在那儿，占着体积还让人以为它还在用。
    for name in BUILT:
        if name in SHIPPED:
            continue
        stale = public / (name + '.png')
        if stale.exists():
            stale.unlink()
    shutil.copy2(project / 'card-config.json', public / 'card-config.json')
    # ---------------------------------------------------------------- 2D 三档
    # 出征选将 / 抽卡撕包（art/cards）、图鉴 36 格（art/thumbs）、详情弹窗
    # （art/portraits）。这三档以前在 scripts/genportraits.py 里，输入写死是
    # 立绘/，所以工作台换了 source.png 它们纹丝不动——游戏里五个显示位置只有
    # 3D 大图会更新。现在一律从 source_of() 出，跟图层同源同一次生成。
    #
    # cards/ 与 thumbs/ 用同一张平面合成，只是尺寸不同：网格和大卡看到同一张构图，
    # 「高度不一样」才有的放矢。
    #
    # 关键：这张平面铺的是**出血画布**（BLEED_CANVAS），不是卡面矩形。
    # 背景和边框只占中间的卡面矩形，角色连同它的出血一起探出去——这就是
    # 「突破次元壁」在平面素材上的表达。之前我只合成了卡面矩形，出血层没参与，
    # 角色被卡面切掉两侧，看着就成了「包在卡面里」，整个平台的核心卖点消失。
    # BLEED_CANVAS 和 CARD 同比例（1280/1920 = 1024/1536），所以 CSS 那边不用改。
    bleed_layer = Image.open(assets / 'subject-bleed.png').convert('RGBA')
    plate = Image.new('RGBA', BLEED_CANVAS, (0, 0, 0, 0))
    plate.paste(background, BLEED)
    plate.alpha_composite(furniture, BLEED)
    plate.alpha_composite(bleed_layer)
    flat_card = ROOT / 'public/art/cards' / (character['id'] + '.webp')
    flat_card.parent.mkdir(parents=True, exist_ok=True)
    # 存 RGBA，不烤成 RGB：卡面矩形之外是透明的，烤掉 alpha 就会变成一块死黑，
    # 角色「探出卡面」这件事在平面图上就再也看不出来（而且没法自动验收）。
    # 透明区交给 CSS 的卡面底色，角色正好浮在上面。
    plate.resize((FLAT_CARD_W, FLAT_CARD_H), Image.Resampling.LANCZOS).save(
        flat_card, 'WEBP', quality=FLAT_QUALITY, method=5)

    flat_thumb = ROOT / 'public/art/thumbs' / (character['id'] + '.webp')
    flat_thumb.parent.mkdir(parents=True, exist_ok=True)
    plate.resize((THUMB_W, THUMB_H), Image.Resampling.LANCZOS).save(
        flat_thumb, 'WEBP', quality=THUMB_QUALITY, method=5)

    # 完整立绘**不裁**：36 张源图有 0.563 和 0.667 两种比例，裁了就等于详情页
    # 看不到整张画（styles.css 里那个框就是按完整立绘的比例留的）。
    flat_portrait = ROOT / 'public/art/portraits' / (character['id'] + '.webp')
    flat_portrait.parent.mkdir(parents=True, exist_ok=True)
    pw = max(1, round(PORTRAIT_H * original.size[0] / original.size[1]))
    # 存 RGBA，不 convert('RGB')：转 RGB 会把透明区烤成黑色，详情页就变成
    # 一张贴在黑底上的立绘，而不是让人物浮在卡面配色上。
    original.resize((pw, PORTRAIT_H), Image.Resampling.LANCZOS).save(
        flat_portrait, 'WEBP', quality=FLAT_QUALITY, method=5)

    print(character['id'], 'layers validated; frame under subject at',
          FRAME_OPACITY, 'alpha; bleed', BLEED_CANVAS,
          '; 2D', f'{FLAT_CARD_W}x{FLAT_CARD_H}/{THUMB_W}x{THUMB_H}/{pw}x{PORTRAIT_H}')
current_roster = json.loads((ROOT / 'public/data/roster.json').read_text(encoding='utf-8-sig'))
print('Prepared', len(selected), 'of', len(roster), 'declared cards')
if current_roster != roster:
    print('Roster changed during preparation; rerun to cover the new declaration')
