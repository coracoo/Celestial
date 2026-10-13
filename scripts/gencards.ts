/**
 * 把 `立绘/` 里的素材做成卡面与卡框两套贴图。
 *
 * 素材是同一次生成出来的三张同尺寸透明 PNG：
 *   <名>-UI-透明.png     名号题幅（标题 / 选人用）
 *   <名>-立绘-透明.png   人物半身像
 *   <名>-边框-透明.png   装饰卡框，中间镂空
 *
 * 产物：
 *   public/art/cards/<id>.webp   768×1280，底色 + **铺满全卡**的人物。卡面里没有卡框、没有文字。
 *
 * ⚠ 本脚本已停用两路产物（2026-10-04 清理）：
 *   public/art/frames/<id>.webp   —— 独立卡框图，src 零引用
 *   public/art/banners/<id>.webp  —— 标题题幅，src 零引用
 * 卡框改由 3D 卡的 GLB 层提供（public/art/layers/<id>/text.png，卡框烘在文字层里），
 * 运行时不再单独贴一圈框平面；2D 侧则统一用 CSS inset box-shadow 画运行时稀有度边框。
 * 两张表都删了，所以这里也不再 mkdir、不再产出——留着就会把孤儿重新生成出来。
 *
 * 另注：本脚本的源文件拼法是 `${名}-立绘-透明.png`，而 立绘/ 里的实际文件名带
 * 座次前缀（`01-宋江-立绘-透明.png`），所以它目前根本跑不起来（会在缺素材检查处退出）。
 * 立绘 → WebP 的实际管线是 scripts/genportraits.py（它按 `*-{name}-立绘-透明.png` glob）。
 *
 * 为什么卡面里不能有文字：姓名 / 称号 / 属性这些在 3D 卡下方的展示区里，
 * 压在立绘上会把人物的下半身糊掉一块。
 *
 * 画布固定 768×1280（0.6），必须和 CardFactory 的 CARD_ASPECT 一致。
 */

import sharp from 'sharp';
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, '立绘');
const OUT_CARDS = path.join(ROOT, 'public/art/cards');

/** 卡面画布。宽高比必须和 CardFactory 的 CARD_ASPECT 一致。 */
const W = 768;
const H = 1280;

/**
 * 中文文件名 → 项目里的角色 id，按梁山座次排。
 * 脚本只认这张表，缺素材会直接报错退出，绝不静默少出几张卡。
 */
const ROSTER = [
  { name: '宋江', id: 'songjiang', color: '#2f6fd0' },
  { name: '吴用', id: 'wuyong', color: '#7a4fd0' },
  { name: '林冲', id: 'linchong', color: '#3d8fd6' },
  { name: '秦明', id: 'qinming', color: '#e0562a' },
  { name: '呼延灼', id: 'huyanzhuo', color: '#b8925a' },
  { name: '花荣', id: 'huarong', color: '#c8452f' },
  { name: '柴进', id: 'chaijin', color: '#c9922a' },
  { name: '鲁智深', id: 'luzhishen', color: '#8a5ad0' },
  { name: '武松', id: 'wusong', color: '#d84a2a' },
  { name: '杨志', id: 'yangzhi', color: '#2f9a8c' },
  { name: '戴宗', id: 'daizong', color: '#c0392b' },
  { name: '李逵', id: 'likui', color: '#4a3a6a' },
];

/** 底色：角色主色压到很暗的竖向渐变 + 中心微亮的暗角。 */
function baseSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="v" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.55"/>
        <stop offset="38%" stop-color="${color}" stop-opacity="0.20"/>
        <stop offset="100%" stop-color="#07060a" stop-opacity="1"/>
      </linearGradient>
      <radialGradient id="vig" cx="50%" cy="38%" r="72%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.10"/>
        <stop offset="60%" stop-color="#000000" stop-opacity="0"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0.55"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="#07060a"/>
    <rect width="${W}" height="${H}" fill="url(#v)"/>
    <rect width="${W}" height="${H}" fill="url(#vig)"/>
  </svg>`;
}

/**
 * 立绘铺满整张卡面。
 *
 * cover 而不是 contain：人物要「平铺占满卡面」，留边会像贴了一张上去。
 * 两种画幅混着（9 张 941×1672 = 0.563、3 张 1024×1536 = 0.667），裁切方向不同：
 * 0.563 的裁上下，0.667 的裁左右。上下裁一律顶对齐——
 * 半身像最不能丢的是头顶，横裁到哪都无所谓。
 */
async function portraitFill(file: string): Promise<Buffer> {
  const meta = await sharp(file).metadata();
  const pw = meta.width ?? W;
  const ph = meta.height ?? H;
  const s = Math.max(W / pw, H / ph);
  const iw = Math.round(pw * s);
  const ih = Math.round(ph * s);
  const cw = Math.min(W, iw);
  const chh = Math.min(H, ih);
  return sharp(file)
    .resize(iw, ih, { fit: 'fill', kernel: 'lanczos3' })
    .extract({ left: Math.round((iw - cw) / 2), top: 0, width: cw, height: chh })
    .png()
    .toBuffer();
}

async function buildCard(r: (typeof ROSTER)[number]): Promise<void> {
  const out = path.join(OUT_CARDS, `${r.id}.webp`);
  const portrait = await portraitFill(path.join(SRC, `${r.name}-立绘-透明.png`));
  await sharp(Buffer.from(baseSvg(r.color)))
    .composite([{ input: portrait, left: 0, top: 0 }])
    .webp({ quality: 88, effort: 5 })
    .toFile(out);
  const kb = Math.round((await stat(out)).size / 1024);
  console.log(`  ${r.name.padEnd(4)} → cards/${r.id}.webp ${String(kb).padStart(4)} KB`);
}

async function main(): Promise<void> {
  await mkdir(OUT_CARDS, { recursive: true });

  const files = new Set(await readdir(SRC));
  const missing: string[] = [];
  for (const r of ROSTER) {
    const f = `${r.name}-立绘-透明.png`;
    if (!files.has(f)) missing.push(f);
  }
  if (missing.length) {
    console.error('缺少素材：\n  ' + missing.join('\n  '));
    process.exitCode = 1;
    return;
  }

  console.log(`合成 ${ROSTER.length} 张卡面（${W}×${H}）：`);
  for (const r of ROSTER) {
    await buildCard(r);
  }
  console.log('完成。');
}

await main();
