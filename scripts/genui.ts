/**
 * 卡面底板生成（本地 ComfyUI / ming-image 0.1 design）
 *
 * 立绘（`genart.ts`）、底板（本脚本）、文字与全息（`CardFactory` 运行时）
 * 三层分开产，运行时按 z 轴叠放：
 *
 *   z=0.00  底板 plate  ← 本脚本，按稀有度各出一张
 *   z=0.06  立绘 portrait ← genart.ts，抠透明背景
 *   z=0.10  名牌 / 稀有度 / 全息 / 边缘光 ← 运行时程序化绘制
 *
 * 按稀有度出板而不是按角色：3 个稀有度 3 张，而不是 108 张。
 *
 *   node --experimental-strip-types scripts/genui.ts --list
 *   node --experimental-strip-types scripts/genui.ts
 *   node --experimental-strip-types scripts/genui.ts --only SSR --force --seed 7
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const DATA_DIR = join(ROOT, 'public', 'data', 'characters');
const OUT_DIR = join(ROOT, 'public', 'art', 'plates');

type Args = { base: string; only: string[]; list: boolean; force: boolean; prompt: boolean; seed: number; steps: number; cfg: number; width: number; height: number };
const args: Args = {
  base: 'http://192.168.0.134:8188',
  only: [], list: false, force: false, prompt: false,
  seed: -1, steps: 28, cfg: 4.0, width: 896, height: 1280,
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  const next = () => argv[++i] ?? '';
  if (a === '--base') args.base = next().replace(/\/$/, '');
  else if (a === '--only') args.only.push(...next().split(',').map((s) => s.trim()).filter(Boolean));
  else if (a === '--list') args.list = true;
  else if (a === '--force') args.force = true;
  else if (a === '--prompt') args.prompt = true;
  else if (a === '--seed') args.seed = Number(next());
  else if (a === '--steps') args.steps = Number(next());
  else if (a === '--cfg') args.cfg = Number(next());
  else if (a === '--w') args.width = Number(next());
  else if (a === '--h') args.height = Number(next());
  else if (a === '--help' || a === '-h') {
    console.log('用法: node --experimental-strip-types scripts/genui.ts [--base URL] [--only SSR,SR] [--list] [--prompt] [--force] [--seed N] [--steps N] [--cfg F] [--w N --h N]');
    process.exit(0);
  }
}

/**
 * ming-image 0.1 系列的配对（实测 /prompt 校验通过）：
 *   UNet   ming_image_0.1_design_int8_convrot.safetensors
 *   CLIP   ming_image_0.1_ling_mini_2.0_int8_convrot.safetensors，type = longcat_image
 *   VAE    ming_image_vae_bf16.safetensors
 *   条件    TextEncodeMingImageEdit，txt2img 时 images 传空数组即可
 * 注意：CLIPLoader 的 type 枚举里没有 ming，ling 编码器走的是 longcat_image。
 */
const MODELS = {
  unet: 'ming_image_0.1_design_int8_convrot.safetensors',
  clip: 'ming_image_0.1_ling_mini_2.0_int8_convrot.safetensors',
  clipType: 'longcat_image',
  vae: 'ming_image_vae_bf16.safetensors',
};

/**
 * 稀有度 → 底板配色。和运行时 RARITY_STYLE 严格对齐：
 * R 蓝 · SR 紫 · SSR 银 · UR 彩虹。
 *
 * **底板只做内衬，绝不画框。** 卡的外框由运行时 `CardFactory` 的
 * `body` 露边（`RARITY_STYLE.frame`）和 foil 层程序化绘制，这是唯一来源。
 * 原因有两条，都是实机踩出来的：
 *   1. AI 画的静态框套在程序化框里面会变成「框套框」，实机看非常脏；
 *   2. 框色必须跟着稀有度走，UR 还要整圈彩虹——静态图根本表达不了，
 *      AI 内框会把 `rainbowFrameTexture()` 的彩虹效果废掉。
 * 所以底板只负责「衬底颜色 + 极简角饰 + 底部纹样带」。
 */
const PLATE: Record<string, { label: string; colors: string; mood: string }> = {
  SSR: {
    label: '传说',
    colors: '整片深冷灰蓝的暗底，缎面银灰调，靠近底边和四角略微透出一点银白的光',
    mood: '清冷、克制、高级感，靠极淡的层次而不是靠线条取胜',
  },
  SR: {
    label: '稀有',
    colors: '整片深紫的暗底，低饱和紫罗兰调，靠近底边和四角略微透出一点藕紫的光',
    mood: '幽雅、神秘、略带夜色',
  },
  R: {
    label: '普通',
    colors: '整片深藏青的暗底，低饱和钢蓝调，靠近底边和四角略微透出一点钢蓝的光',
    mood: '朴素、沉静、不抢戏',
  },
  UR: {
    label: '传说之上',
    colors: '接近纯黑的深底，只有极淡的彩虹色光晕从四角向内渗透——赤红、橙金、草绿、宝蓝、靛紫、洋红，中心仍然是深黑',
    mood: '炫目、庆典感，是全场唯一透光的底',
  },
};

/**
 * 踩过的坑：ming 是 design/UI 向的模型，非常爱往画面里塞「SSR」这类字母、
 * 塞个武将、塞文字。第一版 prompt 写了「卡牌底板 / 稀有度档位：SSR」，
 * 结果三样全中招——顶上一个大 SSR，底下画了「底板」二字，中间还站了个男人。
 *
 * 改成只描述「物件」不描述「用途」，并且反复强调内部空着：
 * 不出现稀有度代号，不出现「底板」这种词，不提题材（提了就会被武将填满）。
 *
 * 第二版改成细边框：第一版「框体厚重、有立体厚度、有金属高光」出来的是
 * 一个厚重的写实金框，和国风赛璐璐立绘放一起两套语言打架。于是改成细框——
 * 但实机一看是「框套框」：运行时 `body` 露边已经是一圈程序化边框（按稀有度
 * 着色，UR 还是整圈彩虹），AI 画的静态内圈框套在里面变成两层嵌套，非常脏；
 * 而且静态图永远做不出 UR 彩虹，会把 `rainbowFrameTexture()` 废掉。
 *
 * 第三版（当前）：**彻底不画框**。底板只做内衬，外框完全交给运行时。
 * ming 对否定指令天然弱，所以 NEGATIVE 正反两面都写死，正面再反复强调
 * 「四条边直接就是暗色底色过渡到画面外，浑然一体看不出接缝」。
 */
const PROMPT_HEAD = [
  '一张深色内衬底板的背景设计图。像装书画用的深色衬纸，或者一整片深色绒布。',
  '整张图几乎全部就是同一片非常深的暗色底，接近纯黑，就像深夜的天空一样暗，不要发白。',
  '底色上只有很轻很淡的装饰：四角各有一个极小的古典纹样点缀，画面底部有一道很淡的横向纹样带。',
  '其余部分保持干净、平整、几乎空无一物。',
  '整张图的四条边不要出现任何边框、任何线条、任何框体。',
  '边缘就是暗色底色自然过渡到画面之外，中间和四周浑然一体，看不出接缝。',
].join('');

const NEGATIVE = [
  '文字，汉字，英文字母，数字，字幕，书法，印章，水印，签名，logo，标题',
  '人物，脸孔，人体，手，身体，剪影，武将，士兵',
  'UI 控件，按钮，图标，排版，卡牌背面',
  '低分辨率，模糊，噪点，纯黑边框',
  // 底板绝不画框：外框由运行时按稀有度程序化画，AI 再画一层就成了「框套框」
  '边框，外框，框线，画框，相框，矩形线框，四边的装饰线，边缘的线条，描边',
  '厚重宽大的框，粗边框，大面积金属，强烈体积光，浮雕',
].join('、');

function buildPrompt(rarity: string): string {
  const p = PLATE[rarity] ?? PLATE.R!;
  return [
    PROMPT_HEAD,
    `材质与配色：${p.colors}。整体气质${p.mood}。`,
    '整张图保持空白、平整，只放得下那点极淡的角落装饰，不放任何别的内容；整体要是暗色，不要白色。',
    `不要出现：${NEGATIVE}。`,
  ].join('\n');
}

function workflow(prompt: string, seed: number, prefix: string): Record<string, unknown> {
  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: MODELS.unet, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: MODELS.clip, type: MODELS.clipType, device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: MODELS.vae } },
    4: { class_type: 'TextEncodeMingImageEdit', inputs: { clip: ['2', 0], prompt, images: [] } },
    5: { class_type: 'EmptySD3LatentImage', inputs: { width: args.width, height: args.height, batch_size: 1 } },
    6: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], seed, steps: args.steps, cfg: args.cfg,
        sampler_name: 'euler', scheduler: 'simple',
        positive: ['4', 0], negative: ['4', 0],
        latent_image: ['5', 0], denoise: 1,
      },
    },
    7: { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['3', 0] } },
    8: { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: prefix } },
  };
}

/** 稀有度清单直接从角色数据推导，新增稀有度不用改代码。 */
function rarities(): string[] {
  const set = new Set<string>();
  for (const f of readdirSync(DATA_DIR).filter((x) => x.endsWith('.json'))) {
    set.add((JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8')) as { rarity: string }).rarity);
  }
  return [...set].sort();
}

async function run(rarity: string): Promise<void> {
  const seed = args.seed >= 0 ? args.seed : Math.floor(Math.random() * 2 ** 31);
  const res = await fetch(`${args.base}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow(buildPrompt(rarity), seed, `plate_${rarity}`), client_id: 'celestial-genui' }),
  });
  if (!res.ok) {
    console.error(`  ✗ ${rarity} 提交失败 HTTP ${res.status}: ${(await res.text()).slice(0, 600)}`);
    process.exitCode = 1;
    return;
  }
  const { prompt_id: promptId } = (await res.json()) as { prompt_id: string };
  process.stdout.write(`  · ${rarity} 已提交 ${promptId.slice(0, 8)} …`);

  const t0 = Date.now();
  let out: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }> = {};
  while (Date.now() - t0 < 20 * 60_000) {
    await new Promise((r) => setTimeout(r, 3000));
    const h = await fetch(`${args.base}/history/${promptId}`);
    if (!h.ok) continue;
    const e = ((await h.json()) as Record<
      string,
      { outputs?: typeof out; status?: { status_str?: string; messages?: [string, Record<string, unknown>][] } }
    >)[promptId];
    if (!e) continue;
    if (e.status?.status_str === 'error') {
      const err = e.status.messages?.find((m) => m[0] === 'execution_error')?.[1] as
        | { node_type?: string; exception_message?: string } | undefined;
      console.error(`\r  ✗ ${rarity} 执行失败 @ ${err?.node_type ?? '?'}: ${(err?.exception_message ?? '?').trim().slice(0, 300)}`);
      process.exitCode = 1;
      return;
    }
    if (e.outputs) { out = e.outputs; break; }
  }
  if (!Object.keys(out).length) { console.error(`\r  ✗ ${rarity} 超时`); process.exitCode = 1; return; }

  const img = Object.values(out).flatMap((o) => o.images ?? [])[0];
  if (!img) { console.error(`\r  ✗ ${rarity} 无图片`); process.exitCode = 1; return; }

  const qs = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type });
  const bin = await fetch(`${args.base}/view?${qs}`);
  if (!bin.ok) { console.error(`\r  ✗ ${rarity} 下载失败`); process.exitCode = 1; return; }
  const buf = Buffer.from(await bin.arrayBuffer());
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${rarity}.png`), buf);
  console.log(`\r  ✓ ${rarity} → ${join(OUT_DIR, `${rarity}.png`).replace(ROOT, '.')}  ${(buf.length / 1024).toFixed(0)} KB  ${((Date.now() - t0) / 1000).toFixed(1)}s  seed=${seed}`);
}

const all = rarities();
const picked = args.only.length ? all.filter((r) => args.only.includes(r)) : all;

if (args.list) {
  console.log(`稀有度 ${all.length} 种，底板输出 ${OUT_DIR.replace(ROOT, '.')}`);
  for (const r of all) {
    console.log(`  ${existsSync(join(OUT_DIR, `${r}.png`)) ? '[有]' : '[缺]'} ${r}  ${PLATE[r]?.colors ?? '(无配色定义)'}`);
  }
  process.exit(0);
}

// --prompt：原样打印将要发给模型的 prompt，不连 ComfyUI、不烧 GPU、不改任何文件。
if (args.prompt) {
  for (const r of picked) {
    console.log(`${'='.repeat(78)}\n底板 ${r}（${PLATE[r]?.label ?? '?'}）\n${'='.repeat(78)}`);
    console.log(buildPrompt(r));
    console.log();
  }
  process.exit(0);
}

try {
  const p = await fetch(`${args.base}/system_stats`);
  if (!p.ok) throw new Error(`HTTP ${p.status}`);
} catch (e) {
  console.error(`连不上 ComfyUI: ${args.base}  (${(e as Error).message})`);
  process.exit(1);
}

const todo = args.force ? picked : picked.filter((r) => !existsSync(join(OUT_DIR, `${r}.png`)));
console.log(`ComfyUI ${args.base}｜ming-image 0.1 design｜${args.width}×${args.height}｜steps ${args.steps}`);
console.log(`待生成 ${todo.length} 张底板\n`);
for (const r of todo) await run(r);
console.log(todo.length ? '\n完成。' : '\n没有需要生成的底板。');
