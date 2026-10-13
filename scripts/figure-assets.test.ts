/**
 * 角色立绘这张图必须**真的在磁盘上**。
 *
 * 这条测试是被一次静默故障逼出来的：76e873f 把管线里角色层的文件名从
 * `subject.png` 改成 `subject-bleed.png`，卡面渲染器跟着改了，但剧情立绘、
 * 技能面板头像、技能释放演出这三处还指着旧名字。三处全部 404，
 * 而 `<img>` 加载失败的处理是「把自己 hidden 掉，别显示碎图标」——
 * 于是屏幕上只剩名牌，**没有任何报错**，冒烟、单测、构建全都绿。
 *
 * 光靠「文件名从常量取」还不够：常量本身也可能被改成另一个不存在的名字。
 * 所以这里逐个断言名册里每个角色的这张图真的在磁盘上。
 */
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { FIGURE_LAYER, FIGURE_BLEED_SCALE, figureUrl } from '../src/core/figureLayer.ts';

const ROOT = join(import.meta.dirname, '..', 'public');
const roster: string[] = JSON.parse(await readFile(join(ROOT, 'data', 'roster.json'), 'utf8'));

test('名册里每个角色的角色层立绘都在磁盘上', () => {
  const missing = roster.filter((id) => !existsSync(join(ROOT, figureUrl(id))));
  assert.deepEqual(missing, [],
    `这 ${missing.length} 个角色缺 ${FIGURE_LAYER}.png：${missing.join(' ')}\n` +
    `场景里是 <img> 加载失败就隐藏自己，所以缺图的表现是「静默地什么都不显示」。`);
});

test('角色层是出血画布，倍数与 CSS 里裁切用的 125% 一致', async () => {
  /*
   * 三个 2D 场景靠 `125%` / `-12.5%` 把出血裁掉，构图才和当年那张
   * 1024×1536 的卡面图一致。这个倍数是从画布尺寸推出来的：
   * 出血画布比卡面每边大 128×192，所以 1280/1024 = 1920/1536 = 1.25。
   * 管线哪天改了画布尺寸，这三个数就得跟着改——所以在这里钉住。
   */
  const CARD = [1024, 1536];
  for (const id of roster) {
    const cfgPath = join(ROOT, 'art', 'layers', id, 'card-config.json');
    if (!existsSync(cfgPath)) continue;
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as {
      subjectLayout?: { canvas?: number[]; bleed?: number[] };
    };
    const canvas = cfg.subjectLayout?.canvas;
    const bleed = cfg.subjectLayout?.bleed;
    if (!canvas || !bleed) continue;
    // bleed 是**每边**的量，所以卡面 = 画布 − 2×出血，倍率 = 画布 ÷ 卡面。
    // 1280/(1280−256) = 1920/(1920−384) = 1.25。
    const face = [canvas[0]! - bleed[0]! * 2, canvas[1]! - bleed[1]! * 2];
    assert.deepEqual(face, CARD, `${id} 的卡面尺寸是 ${face}，约定是 ${CARD}`);
    const sx = canvas[0]! / face[0]!;
    const sy = canvas[1]! / face[1]!;
    assert.ok(Math.abs(sx - sy) < 1e-9,
      `${id} 的出血不是等比的（横向 ${sx.toFixed(4)} / 纵向 ${sy.toFixed(4)}），` +
      `CSS 里那个单一的 125% 就不能同时裁掉两边了`);
    assert.ok(Math.abs(sx - FIGURE_BLEED_SCALE) < 1e-6,
      `${id} 的出血倍率是 ${sx.toFixed(4)}，CSS 与 figureLayer.ts 里写的是 ${FIGURE_BLEED_SCALE}`);
  }
});

test('角色层立绘不是空文件', () => {
  const tiny = roster
    .map((id) => ({ id, size: statSync(join(ROOT, figureUrl(id))).size }))
    .filter((f) => f.size < 20_000);
  assert.deepEqual(tiny, [], `这些角色的立绘小得可疑：${JSON.stringify(tiny)}`);
});

test('场景代码里不再有写死的角色层文件名', async () => {
  /*
   * 反向对照：这条测试要能抓住「有人又写死了一遍」。
   * 只查 `'subject.png'` 这个旧名字——它就是这次事故的元凶。
   */
  const files = [
    'src/story/StoryMode.ts',
    'src/ui/ui.ts',
    'src/runtime/SkillPresentation.ts',
    'src/runtime/CardFactory.ts',
  ];
  const offenders: string[] = [];
  for (const rel of files) {
    const text = await readFile(join(import.meta.dirname, '..', rel), 'utf8');
    // 去掉注释再查，免得把「为什么不能再写死」的说明当成违规
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    if (/subject\.png/.test(code) || /subject-bleed\.png/.test(code)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    `这些文件里又出现了写死的角色层文件名，必须走 core/figureLayer.ts：${offenders.join(' ')}`);
});
