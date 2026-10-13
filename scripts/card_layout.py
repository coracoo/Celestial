"""Layout contract for the RuiC card layer stack.

**Single source of truth.** Every number the runtime shader, the cutout studio
(`tools/cutout.html`) and the audit script need is defined here exactly once and
published to `public/art/layers/layout.json`. Nobody re-derives a canvas size
locally — that is how the studio and the renderer drift apart.

The stack, bottom to top:

    background (depth of field)  ->  frame (70% alpha)  ->  subject  ->  effects  ->  lettering

The frame is its own layer *under* the figure, not baked into `text.png` and not
veiling the character: in the reference card the ornament is hidden behind the
face and hair, and its outer rim lands on the card edge rather than being blown
past it and clipped. Its size is a per-card override (`placement.json` → `frame`)
exactly like the figure's, so the studio can resize it without the pipeline
re-deciding anyone's composition.

The subject is authored on a canvas **larger than the card** (`BLEED_CANVAS`).
Everything inside the card rect is byte-identical in placement to the old
1024x1536 layer; the margin around it is what the runtime draws past the card
edge — the figure breaking out of its frame.
"""
from pathlib import Path
import json
from PIL import Image, ImageChops, ImageOps

CARD = (1024, 1536)

# ---------------------------------------------------------------- 2D 输出档位
# 出征选将 / 抽卡撕包读的平面卡面。它就是卡面本身按比例缩下来，不裁——
# 裁了网格就和大 3D 卡对不上（那正是 genportraits.py 用 CARD_ASPECT=0.6
# 干的事，和卡面的 1024/1536=0.667 打架）。
FLAT_CARD_H = 1280
FLAT_CARD_W = round(FLAT_CARD_H * CARD[0] / CARD[1])
FLAT_QUALITY = 88

# 详情弹窗的完整立绘。36 张源图有 0.563 和 0.667 两种比例，所以这一档**不裁**，
# 只等比缩到定高——详情要看到的就是整张画。
PORTRAIT_H = 1280

# 图鉴 36 格的缩略图。网格每格实际只有 ~200 px 宽，给它单独一档，
# 一屏 36 张才不会拖垮首屏。
THUMB_H = 640
THUMB_W = round(THUMB_H * CARD[0] / CARD[1])
THUMB_QUALITY = 80

# Margin around the card rect, in pixels, that the subject layer may occupy.
# 12.5% of each card dimension: enough for a sleeve, a hand or a weapon tip to
# read as "outside the card" without eating a tenth of the screen.
BLEED = (128, 192)
BLEED_CANVAS = (CARD[0] + 2 * BLEED[0], CARD[1] + 2 * BLEED[1])

# 落位照抄旧管线：人物在卡面上的大小和位置**不动**。
# 之前这里被我改成 1180，等于替 36 张卡重新定了构图——那是工作台和人的事，
# 不是管线的事。素材原样复用，突破卡面的多少由工作台导出 placement.json 决定。
SUBJECT_WIDTH = 1060
SUBJECT_TOP = 120

# 每张卡可以在 cards/<id>/placement.json 里覆盖落位（工作台导出）。
# 没有这个文件 = 完全沿用旧管线，产出与改动前逐字节一致。
PLACEMENT_FILE = 'placement.json'

# 边框：最外缘贴住卡面外沿、70% 不透明、排到角色**下面**（中间层）。
#
# FRAME_SCALE 为什么是 1.0：源图 941x1672 比卡面 2:3 更「高」，
# contain 进卡面得到 864x1536（左右各内缩 80px，上下正好齐卡沿）。
# 之前是 1.08，放大到 934x1659 后上下各溢出 61px，被卡面裁掉一截——
# 花饰不完整，看上去就是「边框不对」。1.0 让最外缘正好落在卡沿上，
# 完整露出整套金饰，卡体倒角那道细亮线也从左右两侧露出来。
FRAME_SCALE = 1.0
FRAME_OPACITY = 0.7
FRAME_DEPTH = 0.0     # 固定 UV：与旧的「边框烘进 text.png」一致，不随视角位移

BACKGROUND_DOF = 0.85  # 0 disables the depth-of-field falloff on the backdrop


class FramePlacement:
    """UI 边框在卡面上的落位，由工作台导出。

    这是**逐卡覆盖**，默认值等于契约里的 FRAME_SCALE/0/0，也就是旧管线原样。
    边框素材和人物素材不一样：人物改构图是创作决定，边框改大小多半只是
    「这张卡的金饰在 70% 不透明下压脸/太素/太粗」，要一张一张试出来——
    所以这两件事共用同一张 placement.json，但各自一个独立维度。
    """

    __slots__ = ('scale', 'offset_x', 'offset_y')

    def __init__(self, scale: float = FRAME_SCALE, offset_x: float = 0.0, offset_y: float = 0.0):
        self.scale, self.offset_x, self.offset_y = scale, offset_x, offset_y

    def to_json(self) -> dict:
        return {'scale': round(self.scale, 4), 'offsetX': round(self.offset_x, 1),
                'offsetY': round(self.offset_y, 1)}


class Placement:
    """人物在出血画布上的落位 + 边框在卡面上的落位。

    scale 是相对 SUBJECT_WIDTH 的倍数；frame 是同一份文件里的第二个维度。
    """

    __slots__ = ('scale', 'offset_x', 'offset_y', 'frame')

    def __init__(self, scale: float = 1.0, offset_x: float = 0.0, offset_y: float = 0.0,
                 frame: FramePlacement | None = None):
        self.scale, self.offset_x, self.offset_y = scale, offset_x, offset_y
        self.frame = frame or FramePlacement()

    @property
    def width(self) -> float:
        return SUBJECT_WIDTH * self.scale

    def to_json(self) -> dict:
        return {'scale': round(self.scale, 4), 'offsetX': round(self.offset_x, 1),
                'offsetY': round(self.offset_y, 1), 'frame': self.frame.to_json()}


def load_placement(project: Path) -> Placement:
    """读 cards/<id>/placement.json。缺文件=默认值=旧管线行为。

    `frame` 是可选的：v1 文件（只有 scale/offsetX/offsetY）读出来就是
    默认边框落位，不是错误——36 张卡现有的 placement.json 都是 v1。
    """
    file = project / PLACEMENT_FILE
    if not file.exists():
        return Placement()
    try:
        data = json.loads(file.read_text(encoding='utf-8'))
    except (ValueError, OSError):
        return Placement()
    try:
        raw_frame = data.get('frame') or {}
        frame = FramePlacement(float(raw_frame.get('scale', FRAME_SCALE)),
                               float(raw_frame.get('offsetX', 0.0)),
                               float(raw_frame.get('offsetY', 0.0)))
        return Placement(float(data.get('scale', 1.0)), float(data.get('offsetX', 0.0)),
                         float(data.get('offsetY', 0.0)), frame)
    except (TypeError, ValueError):
        return Placement()


def subject_box(source_width: int, source_height: int,
                placement: 'Placement | None' = None) -> tuple[int, int, int, int]:
    """Where the figure lands, in bleed-canvas pixels. One definition, three callers.

    The same box positions the card-clipped `subject.png` and the oversized
    `subject-bleed.png`; they must agree exactly or the figure would jump at the
    card edge. `placement` is the per-card override the cutout studio exports —
    it is what decides how much of the figure breaks out.
    """
    place = placement or Placement()
    width = round(CARD[0] * place.width / 1024)
    height = round(source_height * width / source_width)
    return (BLEED[0] + (CARD[0] - width) // 2 + round(place.offset_x),
            BLEED[1] + round(CARD[1] * SUBJECT_TOP / 1536) + round(place.offset_y),
            width, height)


def _feather_top(portrait: Image.Image) -> Image.Image:
    """Blend a source-clipped weapon into the title zone instead of hard-cutting it."""
    mask = Image.new('L', portrait.size, 255)
    rows = Image.new('L', (1, 64))
    rows.putdata([round(255 * y / 63) for y in range(64)])
    mask.paste(rows.resize((portrait.width, 64)), (0, 0))
    portrait.putalpha(ImageChops.multiply(portrait.getchannel('A'), mask))
    return portrait


def _draw_figure(canvas: Image.Image, source: Image.Image, offset: tuple[int, int],
                 placement: Placement | None = None) -> None:
    x, y, width, height = subject_box(source.width, source.height, placement)
    scaled = _feather_top(source.convert('RGBA').resize((width, height), Image.Resampling.LANCZOS))
    canvas.alpha_composite(scaled, (x - offset[0], y - offset[1]))


def mask_channel(matte):
    """取蒙版的值。**统一读 alpha。**

    工作台的蒙版是一张 RGBA：RGB 全白、值存在 alpha 里（画布合成用
    `destination-in`，导出的 matte.png 也是 RGBA）。以前管线这边写的是
    `matte.convert('L')` —— PIL 的 RGBA->L **丢掉 alpha**，只按 RGB 算亮度，
    而 RGB 全白，于是每张导出的蒙版都变成一张纯白图，乘上去什么也不改变：
    工作台里擦掉的边界，管线一次都没吃到。

    L 图（自己画的测试图）照旧按亮度读。
    """
    return matte.getchannel('A') if matte.mode == 'RGBA' else matte.convert('L')


def prepare_subject(source, matte=None, placement=None) -> Image.Image:
    """The card-clipped figure: 1024x1536, identical placement to the old layer."""
    result = Image.new('RGBA', CARD)
    _draw_figure(result, source, BLEED, placement)
    if matte is not None:
        cropped = matte.crop((BLEED[0], BLEED[1], BLEED[0] + CARD[0], BLEED[1] + CARD[1]))
        if cropped.size != CARD:
            cropped = cropped.resize(CARD, Image.Resampling.LANCZOS)
        applied = result.copy()
        applied.putalpha(ImageChops.multiply(applied.getchannel('A'), mask_channel(cropped)))
        result = applied
    return result


def prepare_bleed(source, matte=None, placement=None) -> Image.Image:
    """The oversized figure: BLEED_CANVAS, same placement, nothing clipped.

    `matte` is the studio's alpha mask (opaque keeps, transparent cuts). It is
    applied in bleed-canvas space, so a stroke that crosses the card boundary
    keeps or removes both the on-card part and the part that pokes out.
    """
    result = Image.new('RGBA', BLEED_CANVAS)
    _draw_figure(result, source, (0, 0), placement)
    if matte is not None:
        applied = result.copy()
        applied.putalpha(ImageChops.multiply(applied.getchannel('A'), mask_channel(matte)))
        result = applied
    return result


def frame_placement(source_size: tuple[int, int],
                    canvas: tuple[int, int] = CARD,
                    scale: float = FRAME_SCALE,
                    offset_x: float = 0.0,
                    offset_y: float = 0.0) -> tuple[int, int, int, int]:
    """边框源图 contain 进卡面、按 `scale` 放大、居中之后落在卡面上的矩形。

    单独抽出来是因为「最外缘」这条是**几何约束**而不是观感：放大倍数一旦让
    落位矩形越出卡面上下边，prepare_frame 就会把花饰裁掉一截，出来的边框
    看着就不完整。审计和单测都拿这个矩形来判。

    `source_size` 是必填的、没有默认值——36 张卡的边框素材有两个尺寸
    （32 张 941x1672、4 张 1024x1536），写死一个就等于给其中 4 张判错方向：
    contain 吃哪条边取决于源图和卡面谁更「长」。

    `scale`/`offset_*` 是工作台导出的逐卡覆盖，默认值 = 契约默认 = 旧管线原样。
    落位矩形可以越出卡面（滑杆能放大到 150%），越出去的部分由卡沿裁掉——
    这是用户自己选的，不是不变量。
    """
    width, height = canvas
    ratio = min(width / source_size[0], height / source_size[1])
    target = (round(source_size[0] * ratio * scale), round(source_size[1] * ratio * scale))
    return ((width - target[0]) // 2 + round(offset_x),
            (height - target[1]) // 2 + round(offset_y), target[0], target[1])


def prepare_frame(source, canvas=CARD, scale=FRAME_SCALE, opacity=FRAME_OPACITY,
                  offset_x: float = 0.0, offset_y: float = 0.0) -> Image.Image:
    """Frame furniture, mapped to the card perimeter at its authored opacity.

    The mapping is **contain into the card, then scale up and centre** —
    `frame_placement` is the single place that geometry is derived, and the audit
    asserts the result still matches what the contract declares. Blowing the
    ornament past the card edge (the old 1.08) clipped its top and bottom bands,
    which is what made the border read as broken — so 1.0 is the contract default;
    going past it is now something only the studio's slider can ask for.

    越界落位交给 Pillow：alpha_composite 对负坐标和整张画布之外的 dest 都处理
    正确（实测越界到画布外会得到一张空层，不是错位）。
    """
    width, height = canvas
    box = frame_placement(source.size, canvas, scale, offset_x, offset_y)
    frame = ImageOps.contain(source.convert('RGBA'), (width, height), Image.Resampling.LANCZOS)
    frame = frame.resize((box[2], box[3]), Image.Resampling.LANCZOS)
    if opacity < 1:
        frame.putalpha(frame.getchannel('A').point(lambda value: round(value * opacity)))
    result = Image.new('RGBA', canvas)
    result.alpha_composite(frame, (box[0], box[1]))
    return result


def card_offset(uv: tuple[float, float]) -> tuple[float, float]:
    """Map a 0..1 card UV onto the same rectangle inside the oversized canvas."""
    return (BLEED[0] / BLEED_CANVAS[0] + uv[0] * CARD[0] / BLEED_CANVAS[0],
            BLEED[1] / BLEED_CANVAS[1] + uv[1] * CARD[1] / BLEED_CANVAS[1])


def contract() -> dict:
    return {
        'card': list(CARD),
        'subjectCanvas': list(BLEED_CANVAS),
        'bleed': list(BLEED),
        'subjectWidth': SUBJECT_WIDTH,
        'subjectTop': SUBJECT_TOP,
        'defaultPlacement': Placement().to_json(),
        'defaultFramePlacement': FramePlacement().to_json(),
        'frameOpacity': FRAME_OPACITY,
        'frameDepth': FRAME_DEPTH,
        'frameScale': FRAME_SCALE,
        # 边框在角色**下面**（中间层）。顺序只在这里定义一次，着色器、2D 预览和
        # 探针都按它说话，免得三处各写一遍、各改一遍。
        'frameLayer': 'under-subject',
        # 落位矩形逐卡不同（源图有两个尺寸），所以契约只发布**规则**，
        # 具体矩形写进各卡的 card-config.json 的 frameLayout.placement。
        # 规则只说映射方式（contain 进卡面 → 绕卡心缩放），**不说**结果一定
        # 落在卡内——放大超过 1.0 时工作台是故意让它出卡沿的。
        'frameFit': 'contain-then-scale',
        'backgroundDof': BACKGROUND_DOF,
        'cardUvOffset': [BLEED[0] / BLEED_CANVAS[0], BLEED[1] / BLEED_CANVAS[1]],
        'cardUvScale': [CARD[0] / BLEED_CANVAS[0], CARD[1] / BLEED_CANVAS[1]],
        # 2D 三档输出。之前它们由 scripts/genportraits.py 单独定义，于是
        # art/cards/ 被两条管线抢同一个路径，而 portraits/ thumbs/ 压根没人跟着
        # source.png 更新——换张立绘，游戏里五个显示位置只有一个会变。
        # 全部收进契约，并且一律从 source_of() 出图。
        'flat': {
            # 平面卡面：出征选将 / 抽卡撕包用。比例=卡面比例，不裁，
            # 所以缩略图和 3D 大卡看到的是同一张构图。
            'card': {'width': FLAT_CARD_W, 'height': FLAT_CARD_H, 'quality': FLAT_QUALITY},
            # 完整立绘：详情弹窗用。**不裁**，等比缩到定高——详情要看到整张画。
            'portrait': {'height': PORTRAIT_H, 'quality': FLAT_QUALITY},
            # 网格缩略图：图鉴 36 格。压到网格实际尺寸的余量，一屏 36 张才不至于
            # 拖垮首屏。
            'thumb': {'width': THUMB_W, 'height': THUMB_H, 'quality': THUMB_QUALITY},
        },
    }


def publish(root: Path) -> Path:
    target = root / 'public/art/layers/layout.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(contract(), ensure_ascii=False, indent=2), encoding='utf8')
    return target
