"""Regression for the card layer contract: placement, frame alpha, bleed twin."""
import json
import tempfile
import unittest
from pathlib import Path
from PIL import Image, ImageDraw
from card_layout import (CARD, BLEED, BLEED_CANVAS, FRAME_SCALE, FRAME_OPACITY, prepare_frame,
                         prepare_subject, prepare_bleed, subject_box, mask_channel, frame_placement,
                         contract, load_placement, PLACEMENT_FILE, Placement, SUBJECT_TOP)
from balance_breakout import solve_from


class CardLayoutTest(unittest.TestCase):
    def test_portrait_source_boundaries_are_not_exposed_inside_the_card(self):
        for source in [(941, 1672), (1024, 1536)]:
            result = prepare_subject(Image.new('RGBA', source, (90, 120, 150, 255)))
            self.assertEqual(result.size, CARD)
            mid = CARD[1] // 2
            self.assertEqual(result.getpixel((0, mid)), (90, 120, 150, 255))
            self.assertEqual(result.getpixel((CARD[0] - 1, mid)), (90, 120, 150, 255))
            # 顶部羽化带落在立绘自己的前 64 行，换算回卡面坐标再断言，
            # 免得 SUBJECT_TOP 一改这个测试就变成检查另一个位置。
            _, top, _, _ = subject_box(*source)
            local = CARD[1] // 2
            self.assertEqual(result.getpixel((local, top - BLEED[1] - 1))[3], 0)
            self.assertEqual(result.getpixel((local, top - BLEED[1] + 80))[3], 255)

    def test_frame_fits_inside_the_card_and_reaches_the_vertical_rim(self):
        """「最外缘」：contain 进卡面后**不放大**，落位矩形完整落在卡面内。

        36 张卡的边框素材有两个尺寸：32 张 941x1672（比卡面高，contain 吃高度，
        上下齐卡沿、左右留白），4 张 1024x1536（正合卡面，四边齐）。旧的 ×1.08
        会把前者放大到 933x1659、上下各溢出 61px，prepare_frame 只能把花饰裁掉
        一截——边框看着就不完整；后者更惨，放大到 1106x1659。
        像素断言全部走 frame_placement()，不写死坐标，改缩放倍数也不会失效。
        """
        for source_size, expect in [((941, 1672), (80, 0, 864, 1536)),
                                    ((1024, 1536), (0, 0, 1024, 1536))]:
            with self.subTest(source=source_size):
                x, y, w, h = frame_placement(source_size)
                self.assertEqual((x, y, w, h), expect)
                self.assertGreaterEqual(x, 0)
                self.assertGreaterEqual(y, 0)
                self.assertLessEqual(x + w, CARD[0], '左右不该溢出卡面')
                self.assertLessEqual(y + h, CARD[1], '上下不该溢出卡面（溢出就会被裁掉花饰）')
                self.assertTrue(w == CARD[0] or h == CARD[1], '至少一条边要顶住卡沿')

                source = Image.new('RGBA', source_size)
                ImageDraw.Draw(source).rectangle(
                    (0, 0, source_size[0] - 1, source_size[1] - 1), fill='white')
                result = prepare_frame(source)
                self.assertEqual(result.size, CARD)
                mid = CARD[1] // 2
                if x > 0:
                    self.assertEqual(result.getpixel((x - 8, mid))[3], 0, '留白侧应露出卡沿')
                    self.assertEqual(result.getpixel((x + w + 7, mid))[3], 0)
                self.assertGreater(result.getpixel((x + 8, mid))[3], 0)
                self.assertGreater(result.getpixel((x + w - 9, mid))[3], 0)
                if y == 0:
                    self.assertGreater(result.getpixel((512, 0))[3], 0, '上下应齐卡沿')
                    self.assertGreater(result.getpixel((512, CARD[1] - 1))[3], 0)

                # 空心源图（只有一圈边）时卡心必须仍然是空的——证明这个变换没有把
                # 边框填实，也没有把两端裁掉。
                ring = Image.new('RGBA', source_size)
                ImageDraw.Draw(ring).rectangle(
                    (0, 0, source_size[0] - 1, source_size[1] - 1), outline='white', width=60)
                hollow = prepare_frame(ring)
                self.assertEqual(hollow.getpixel((512, mid))[3], 0, '卡心应当镂空')
                self.assertGreater(hollow.getpixel((x + 8, mid))[3], 0)
                self.assertGreater(hollow.getpixel((x + w - 9, mid))[3], 0)

    def test_frame_is_declared_under_the_subject(self):
        """叠放顺序只定义一次：契约里写死 under-subject，着色器和 2D 预览都按它排。"""
        self.assertEqual(contract()['frameLayer'], 'under-subject')
        self.assertEqual(contract()['frameOpacity'], FRAME_OPACITY)
        # 映射规则的名字只描述**怎么放**，不承诺「一定落在卡内」——工作台放大
        # 到 150% 时就是有意让它出卡沿的。
        self.assertEqual(contract()['frameFit'], 'contain-then-scale')

    def test_frame_scale_scales_the_1x_rect_about_the_card_centre(self):
        """工作台的边框预览靠这条恒等式才不用搬源图。

        管线出的 frame.png 就是「contain 进卡面、绕卡心缩放、居中」，默认 1.0。
        工作台把**已经烘好的**那张再绕卡心缩 s 倍，等价于管线拿同一个 s 重跑，
        当且仅当 s 倍的落位矩形左上角落在 (W - w·s)/2：

            s·(W-w)/2 + W(1-s)/2 = (W - w·s)/2

        谁把居中方式改成别的（改成左上对齐、或先缩后居中两次），这条立刻失败。
        """
        for source_size in [(941, 1672), (1024, 1536)]:
            with self.subTest(source=source_size):
                bx, by, bw, bh = frame_placement(source_size)
                for scale in [0.5, 0.7, 1.3, 1.5]:
                    x, y, w, h = frame_placement(source_size, CARD, scale)
                    # 尺寸容差 1px：管线算的是 round(源宽·ratio·s)，工作台算的是
                    # 把已经 round 过的 s=1 矩形再缩一次，两次取整可以差 1。
                    # 居中是恒等式要的那一半，必须精确。
                    self.assertAlmostEqual(w, bw * scale, delta=1)
                    self.assertAlmostEqual(h, bh * scale, delta=1)
                    self.assertEqual(x, (CARD[0] - w) // 2)
                    self.assertEqual(y, (CARD[1] - h) // 2)

    def test_frame_offset_moves_the_rect_and_survives_out_of_bounds(self):
        """落位矩形可以出卡面——那是用户显式选择，由卡沿裁掉。
        越界不该让 Pillow 崩，也不该让它把花饰挪到别处去。"""
        source = Image.new('RGBA', (941, 1672), (200, 150, 60, 255))
        base = prepare_frame(source)
        self.assertEqual(base.getpixel((512, 768))[3], round(255 * FRAME_OPACITY))
        x, y, w, h = frame_placement((941, 1672), CARD, FRAME_SCALE, 40, -30)
        self.assertEqual((x, y), (80 + 40, -30))
        # 整体上移 30px（落位矩形本来就正好齐卡沿）：**底下**那 30 行露白，
        # 同一列往下 30 行才还是花饰。顶上是够不着底的——矩形往上还溢出 30。
        moved = prepare_frame(source, offset_x=40, offset_y=-30)
        self.assertEqual(moved.getpixel((512, 798))[3], round(255 * FRAME_OPACITY))
        self.assertEqual(moved.getpixel((512, CARD[1] - 6))[3], 0, '上移后底部应该露白')
        self.assertEqual(base.getpixel((512, CARD[1] - 6))[3], round(255 * FRAME_OPACITY))
        # 整张挪出卡面之外：得到一张空层，而不是错位的内容。
        self.assertEqual(prepare_frame(source, offset_y=4000).getchannel('A').getextrema(), (0, 0))
        self.assertEqual(prepare_frame(source, offset_x=-4000).getchannel('A').getextrema(), (0, 0))

    def test_frame_scale_actually_moves_pixels(self):
        """scale=1.0 必须是旧管线的原样；改了就一定改到像素。"""
        source = Image.new('RGBA', (941, 1672), (0, 0, 0, 0))
        ImageDraw.Draw(source).rectangle((0, 0, 940, 1671), outline='white', width=60)
        default = prepare_frame(source)
        smaller = prepare_frame(source, scale=0.6)
        box_d, box_s = default.getchannel('A').getbbox(), smaller.getchannel('A').getbbox()
        self.assertIsNotNone(box_s)
        # 均匀缩小 → 包围盒每边都按比例收
        self.assertAlmostEqual(box_s[2] - box_s[0], (box_d[2] - box_d[0]) * 0.6, delta=3)
        self.assertAlmostEqual(box_s[3] - box_s[1], (box_d[3] - box_d[1]) * 0.6, delta=3)
        bigger = prepare_frame(source, scale=1.25)
        box_b = bigger.getchannel('A').getbbox()
        # 放大超出卡面时，被卡沿裁掉 —— 上下必然顶满卡沿。
        self.assertEqual(box_b[1], 0)
        self.assertEqual(box_b[3], CARD[1])

    def test_default_frame_is_byte_identical_to_the_pre_override_pipeline(self):
        """没导出 frame 段时，产出必须和加这个功能之前逐字节一致。

        「一个数字只能有一处定义」的代价是所有默认值都不能被顺手改到。
        这条用契约默认值和一张写死内容的图做对照，不依赖任何一张真卡。
        """
        source = Image.new('RGBA', (941, 1672))
        draw = ImageDraw.Draw(source)
        draw.rectangle((40, 40, 900, 1631), outline=(255, 210, 120, 255), width=8)
        via_defaults = prepare_frame(source)
        via_explicit = prepare_frame(source, scale=FRAME_SCALE, opacity=FRAME_OPACITY,
                                     offset_x=0, offset_y=0)
        self.assertEqual(via_defaults.tobytes(), via_explicit.tobytes())

    def test_placement_v1_files_still_load_and_gain_a_default_frame(self):
        """36 张卡磁盘上的 placement.json 都是 v1（只有人物三项）。
        加 frame 段不能把它们变成「读不出来就退回默认人物落位」——那等于静默重置。"""
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            (project / PLACEMENT_FILE).write_text(
                json.dumps({'scale': 0.93, 'offsetX': 0, 'offsetY': -219}), encoding='utf-8')
            place = load_placement(project)
            self.assertEqual((place.scale, place.offset_x, place.offset_y), (0.93, 0.0, -219.0))
            self.assertEqual(place.frame.to_json(), {'scale': 1.0, 'offsetX': 0.0, 'offsetY': 0.0})
            # v2：frame 段独立于人物，两边互不干扰。
            (project / PLACEMENT_FILE).write_text(json.dumps(
                {'scale': 1.0, 'offsetX': 0, 'offsetY': 0,
                 'frame': {'scale': 1.25, 'offsetX': -18, 'offsetY': 6}}), encoding='utf-8')
            place = load_placement(project)
            self.assertEqual((place.scale, place.offset_x, place.offset_y), (1.0, 0.0, 0.0))
            self.assertEqual(place.frame.to_json(), {'scale': 1.25, 'offsetX': -18.0, 'offsetY': 6.0})
            self.assertEqual(place.to_json()['frame'], {'scale': 1.25, 'offsetX': -18.0, 'offsetY': 6.0})
            # 坏数据退回默认，而不是崩掉整条管线。
            (project / PLACEMENT_FILE).write_text('{ not json', encoding='utf-8')
            self.assertEqual(load_placement(project).scale, 1.0)

    def test_only_decoration_alpha_is_reduced(self):
        source = Image.new('RGBA', (941, 1672), (170, 100, 30, 255))
        result = prepare_frame(source)
        self.assertEqual(result.getpixel((512, 768)), (170, 100, 30, round(255 * FRAME_OPACITY)))
        self.assertEqual(source.getpixel((0, 0))[3], 255, 'source artwork stays intact')
        lettering = Image.new('RGBA', result.size)
        ImageDraw.Draw(lettering).rectangle((70, 80, 100, 100), fill=(255, 241, 206, 255))
        result.alpha_composite(lettering)
        self.assertEqual(result.getpixel((85, 90)), (255, 241, 206, 255))

    def test_bleed_twin_is_the_same_picture_as_the_card_layer(self):
        """两层放的不是同一张图，角色就会在卡缘上错位跳一下。"""
        source = Image.new('RGBA', (941, 1672), (90, 120, 150, 255))
        card, bleed = prepare_subject(source), prepare_bleed(source)
        self.assertEqual(bleed.size, BLEED_CANVAS)
        for px, py in [(0, 400), (512, 400), (CARD[0] - 1, 400), (512, 900)]:
            self.assertEqual(bleed.getpixel((px + BLEED[0], py + BLEED[1])), card.getpixel((px, py)),
                             (px, py))

    def test_figure_actually_reaches_past_the_card_edge(self):
        """没有溢出，「突破次元壁」就是一句空话。"""
        bleed = prepare_bleed(Image.new('RGBA', (941, 1672), (90, 120, 150, 255)))
        box = bleed.getbbox()
        self.assertIsNotNone(box)
        self.assertLess(box[0], BLEED[0], 'figure does not reach the left bleed margin')
        self.assertGreater(box[2], BLEED[0] + CARD[0], 'figure does not reach the right bleed margin')

    def test_rgba_matte_is_read_from_alpha_not_luminance(self):
        """回归：导出的 matte.png 是 RGBA，遮罩值在 **alpha** 上。

        工作台的合成用 destination-in（读 alpha），导出的 PNG 也是 RGBA。
        管线以前写的是 `matte.convert('L')` —— PIL 的 RGBA->L **丢掉 alpha、
        只按 RGB 算亮度**，而 RGB 全白，于是每张蒙版都变成一张纯白图，
        乘上去什么也不改变：工作台里擦掉的边界，管线一次都没吃到。

        这里用一张 RGB 全白、alpha 带洞的蒙版跑真实管线。谁再改回 convert('L')，
        洞就补不回来，这条立刻失败。
        """
        source = Image.new('RGBA', (941, 1672), (90, 120, 150, 255))
        matte = Image.new('RGBA', BLEED_CANVAS, (255, 255, 255, 255))   # 白 + 全不透明
        split = BLEED_CANVAS[0] // 2
        ImageDraw.Draw(matte).rectangle((0, 0, split, BLEED_CANVAS[1]), fill=(255, 255, 255, 0))
        left, right = BLEED[0] + 40, BLEED[0] + CARD[0] - 40
        self.assertLess(left, split, 'left sample must sit in the cut half')
        self.assertGreater(right, split, 'right sample must sit in the kept half')

        # 这就是旧代码（convert('L')）会看到的：一张纯白图，什么也切不掉。
        self.assertEqual(matte.convert('L').getpixel((left, 900)), 255,
                         'convert(L) sees a solid white image — that is exactly the old bug')
        self.assertEqual(mask_channel(matte).getpixel((left, 900)), 0)

        bleed = prepare_bleed(source, matte)
        self.assertEqual(bleed.getpixel((left, 900))[3], 0, 'RGBA matte must actually cut')
        self.assertEqual(bleed.getpixel((right, 900))[3], 255, 'and must keep the other half')

    def test_l_mode_matte_still_works(self):
        """自制的 L 图按亮度读，别把这条路也堵死。"""
        source = Image.new('RGBA', (941, 1672), (90, 120, 150, 255))
        matte = Image.new('L', BLEED_CANVAS, 255)
        split = BLEED_CANVAS[0] // 2
        ImageDraw.Draw(matte).rectangle((0, 0, split, BLEED_CANVAS[1]), fill=0)
        bleed = prepare_bleed(source, matte)
        self.assertEqual(bleed.getpixel((BLEED[0] + 40, 900))[3], 0)
        self.assertEqual(bleed.getpixel((BLEED[0] + CARD[0] - 40, 900))[3], 255)
        source = Image.new('RGBA', (941, 1672), (90, 120, 150, 255))
        matte = Image.new('L', BLEED_CANVAS, 255)
        split = BLEED_CANVAS[0] // 2
        ImageDraw.Draw(matte).rectangle((0, 0, split, BLEED_CANVAS[1]), fill=0)
        # 采样点必须落在立绘覆盖范围内，否则断言的是「本来就透明」而不是蒙版
        left, right = BLEED[0] + 40, BLEED[0] + CARD[0] - 40
        self.assertLess(left, split, 'left sample must sit in the cut half')
        self.assertGreater(right, split, 'right sample must sit in the kept half')
        bleed = prepare_bleed(source, matte)
        self.assertEqual(bleed.getpixel((left, 900))[3], 0)
        self.assertEqual(bleed.getpixel((right, 900))[3], 255)
        card = prepare_subject(source, matte)
        self.assertEqual(card.getpixel((0, 768))[3], 0)
        self.assertEqual(card.getpixel((CARD[0] - 1, 768))[3], 255)


class BreakoutBalanceTest(unittest.TestCase):
    """突破量平衡的闭式解。

    规则只有一条：**图框高 = 卡面高 + 2×target**，剩下的位置由 offsetY 解出来。
    高瘦源图因此是「缩小」、矮胖源图是「放大」，不需要分情况——
    早先按「当前可分配总量」去缩放，结果高瘦源图（941×1672 在 scale 1 时图框高
    1883、下沿落到 y=2195 而画布只有 1920）解出来的 scale 偏大，底部还是顶在
    出血上限 192，脚被裁掉。
    """

    def _sides(self, bleed):
        box = bleed.getchannel('A').getbbox()
        return BLEED[1] - box[1], box[3] - (BLEED[1] + CARD[1])

    def _run(self, source_size, target=120):
        source = Image.new('RGBA', source_size, (200, 120, 90, 255))
        r = solve_from((0, 0, *source_size), source_size, target)
        self.assertTrue(r['ok'], r)
        moved = prepare_bleed(source, None,
                              Placement(scale=r['scale'], offset_y=r['offsetY']))
        return r, self._sides(moved)

    def test_both_ends_land_on_target(self):
        for source_size in [(1024, 1536), (941, 1672)]:
            r, (top, bottom) = self._run(source_size)
            self.assertAlmostEqual(top, 120, delta=3, msg=f'顶部 {source_size}')
            self.assertAlmostEqual(bottom, 120, delta=3, msg=f'底部 {source_size}')

    def test_nothing_is_clipped_by_the_bleed_canvas(self):
        """上下都必须**小于**出血上限。贴到 192 就是脚/头被画布裁掉了。"""
        for source_size in [(1024, 1536), (941, 1672)]:
            _, (top, bottom) = self._run(source_size)
            self.assertLess(top, BLEED[1], f'顶部被裁 {source_size}')
            self.assertLess(bottom, BLEED[1], f'底部被裁 {source_size}')

    def test_tall_source_shrinks_instead_of_growing(self):
        """941×1672 这种高瘦源图在 scale 1 时已经溢出画布几百像素，必须**缩小**。

        这条是反直觉的，所以钉住：早先那版按「当前可分配总量」缩放，对高瘦源图
        算出的 scale > 1，底部照样顶在上限。
        """
        r, _ = self._run((941, 1672))
        self.assertLess(r['scale'], 1.0, '高瘦源图应当缩小')
        r2, _ = self._run((1024, 1536))
        self.assertGreater(r2['scale'], 1.0, '矮胖源图应当放大')

    def test_offset_y_alone_cannot_do_it(self):
        """只搬 offsetY 一定不够——把这条钉住，免得又有人想靠平移解决。"""
        source = Image.new('RGBA', (1024, 1536), (200, 120, 90, 255))
        box = prepare_bleed(source).getchannel('A').getbbox()
        top, bottom = BLEED[1] - box[1], box[3] - (BLEED[1] + CARD[1])
        budget = top + bottom
        self.assertLess(budget, 240, '默认预算本来就该不够 2×120')
        _, fy, _, fh = subject_box(1024, 1536, Placement())
        alpha_top, alpha_bot = (box[1] - fy) / fh, (box[3] - fy) / fh
        oy = round(-SUBJECT_TOP - budget / 2 - alpha_top * fh)
        a = self._sides(prepare_bleed(source, None, Placement(offset_y=oy)))
        self.assertAlmostEqual(a[0], a[1], delta=3, msg='平分后上下应当相等')
        self.assertLess(a[0], 60, '平分后每边都不该到 60px')


if __name__ == '__main__':
    unittest.main()
