/**
 * 角色立绘生成管线（Qwen-Image 2.1 / ComfyUI）
 *
 * 数据驱动：prompt 全部由 public/data/characters/*.json 推导，
 * 不在代码里硬编码任何单个角色。扩到第 108 个角色只需要加 JSON。
 *
 *   node --experimental-strip-types scripts/genart.ts --base http://192.168.0.134:8188
 *   node --experimental-strip-types scripts/genart.ts --only wusong
 *   node --experimental-strip-types scripts/genart.ts --list
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

// import.meta.url 的 pathname 是百分号编码的，工程路径含中文，必须先解码
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const CHAR_DIR = join(ROOT, 'public', 'data', 'characters');
/** 卡面立绘目录。`--raw` / `--out-dir` 会把它改道，别让一张插画顶掉卡面资产。 */
let OUT_DIR = join(ROOT, 'public', 'art', 'characters');
/** ComfyUI 下载下来的原始整图。抠图前先存这儿，重抠不用重新烧 GPU。 */
const RAW_DIR = join(ROOT, '.artcache', 'characters');

/* ------------------------------------------------------------------ 参数 */

type Args = { base: string; only: string[]; list: boolean; force: boolean; cutout: boolean; recutout: boolean; prompt: boolean; raw: string; out: string; outDir: string; seed: number; steps: number; cfg: number; width: number; height: number };
const args: Args = {
  base: 'http://192.168.0.134:8188',
  only: [],
  list: false,
  force: false,
  cutout: true,
  recutout: false,
  prompt: false,
  raw: '',
  out: '',
  outDir: '',
  seed: -1,
  // 采样档位。实机放大后最大的问题不是画风而是「糙」：断线、糊指、死黑头发、
  // 褶皱缺失。这些靠 steps 收敛度和 cfg 的指令遵循度直接换，
  // 896×1280/steps 24/cfg 4.0 那个档位留不住细节。
  //
  // 三档实测（同一张武松、同一套 prompt）：
  //   896×1280  steps 24  cfg 4.0 →  170s  糙：手指糊、头发死黑、衣服没褶皱
  //   1024×1440 steps 32  cfg 5.0 → ~500s  折中档，当前默认
  //   1152×1600 steps 40  cfg 5.0 → 1133s  细节最好，但 108 张要 34 小时
  //
  // 关键发现：**cfg 4.0 → 5.0 是主要功劳**，提上去之后 prompt 里逐项点名的
  // 那些细节（「指缝的缝隙看得见」「柄与掌肉之间的压痕」）模型才真会去画。
  // 所以折中档保 cfg 5.0，砍的是分辨率和 steps——分辨率对「指缝可见」这类
  // 细节的影响远小于 steps。108 张全量按折中档约 15 小时。
  steps: 32,
  cfg: 5.0,
  width: 1024,
  height: 1440,
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  const next = () => argv[++i] ?? '';
  if (a === '--base') args.base = next().replace(/\/$/, '');
  else if (a === '--only') args.only.push(...next().split(',').map((s) => s.trim()).filter(Boolean));
  else if (a === '--list') args.list = true;
  else if (a === '--force') args.force = true;
  else if (a === '--recutout') args.recutout = true;
  else if (a === '--cutout') args.cutout = true;
  else if (a === '--no-cutout') args.cutout = false;
  else if (a === '--prompt') args.prompt = true;
  else if (a === '--raw') args.raw = next();
  else if (a === '--out') args.out = next();
  else if (a === '--out-dir') args.outDir = next();
  else if (a === '--seed') args.seed = Number(next());
  else if (a === '--steps') args.steps = Number(next());
  else if (a === '--cfg') args.cfg = Number(next());
  else if (a === '--w') args.width = Number(next());
  else if (a === '--h') args.height = Number(next());
  else if (a === '--help' || a === '-h') {
    console.log(`用法: node --experimental-strip-types scripts/genart.ts [选项]

  --base URL      ComfyUI 地址（默认 http://192.168.0.134:8188）
  --only id,id    只处理指定角色
  --list          列出角色与立绘状态
  --force         已存在的也重画
  --cutout        抠透明背景（默认开）
  --no-cutout     不抠，直接用原图
  --recutout      不连 ComfyUI，拿 .artcache 里的原图重新抠
  --seed N        固定随机种子
  --steps N / --cfg F / --w N / --h N   采样参数`);
    process.exit(0);
  }
}

const MODELS = {
  unet: 'qwen_image_2.1_int8_convrot.safetensors',
  /**
   * 必须是 Qwen3 系编码器（hidden=4096）。Qwen-Image 2.1 不再配 Qwen2.5-VL-7B：
   * 那个是 3584 维，KSampler 会直接报
   * "normalized_shape=[4096] ... got input of size [1, 214, 3584]"。
   * 同样是 int8_convrot 量化，和 UNet 配套。
   */
  clip: 'qwen3vl_8b_int8_convrot.safetensors',
  clipType: 'qwen_image',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',
  shift: 3.15,
};

/* ------------------------------------------------------------- 角色数据 */

/** 与 src/data/schema.ts 的 ArtBrief 保持一致；只取生图用得到的子集 */
interface ArtBrief {
  archetype: string;
  face: string;
  body: string;
  hair: string;
  costume: string;
  silhouette: string;
  pose: string;
  avoid?: string;
}

interface CharacterDef {
  id: string; number: number; name: string; title: string;
  rarity: string; element: string; role: string;
  color: string; accent: string; tagline: string; lore: string;
  art?: ArtBrief;
  /** --raw 模式注入：原文 prompt 优先于 buildPrompt，负向同理 */
  rawPrompt?: string;
  rawNegative?: string;
}

const ELEMENT_CN: Record<string, string> = {
  force: '力', spear: '枪', earth: '土', wind: '风', water: '水',
  fire: '火', thunder: '雷', shadow: '影', holy: '圣',
};

function loadChars(): CharacterDef[] {
  if (!existsSync(CHAR_DIR)) throw new Error(`找不到角色目录: ${CHAR_DIR}`);
  const files = readdirSync(CHAR_DIR).filter((f) => f.endsWith('.json'));
  const out: CharacterDef[] = [];
  for (const f of files) {
    const c = JSON.parse(readFileSync(join(CHAR_DIR, f), 'utf8')) as CharacterDef;
    out.push(c);
  }
  return out.sort((a, b) => a.number - b.number);
}

/* ------------------------------------------------------------- prompt */

/**
 * 只放「所有角色都该成立」的东西：画风、构图、背景、安全边界。
 *
 * 刻意不写具体服装。早期版本在这里写了「贴身战袍 + 皮革束带 + 托举式交叉束带 +
 * 开合领口」一整套，结果每个角色都收敛成同一张脸、同一个丸子头、同一件束带紧身衣，
 * 只换颜色——108 张会是同一个人。服装、体型、发型、道具全部下沉到角色 JSON 的 `art` 块，
 * 逐个写死。
 *
 * 画风走**国风赛璐璐动画**（二维平涂 + 干净线稿 + 厚腮红 + 古风发饰），
 * 不是三维半写实游戏立绘。性感靠剪裁与织物张力表达，不用皮革束带那套。
 */
const STYLE = [
  '国风赛璐璐动画风格的角色立绘，二维手绘赛璐璐上色：干净的深色线稿勾边，色块平涂、只有两到三个明暗层次。',
  '国产古风动画的精致审美：柔和淡雅的配色，肤色白里透粉，脸颊与鼻尖有浓厚的腮红。',
  '古风动画的五官画法：细长弯眉、上挑的丹凤眼、小巧鼻梁、一点朱红的小嘴。',
  '水墨晕染的淡雅质感与细腻笔触，绢本质感的衣料。',
  // —— 精修层：实机放大后最糙的就是这几处，逐项点名 ——
  '精修到经得起放大的完成度：线稿锐利干净、一根线条就是一根不要有断口和重线。',
  '手指逐根画清楚：五指分明、关节结构正确、指缝的缝隙看得见、指甲有形状和反光，指腹有力度。',
  '握持处有实感：手掌把柄攥紧，指节因为用力微微发白，柄与掌肉之间有明确的受力和压痕。',
  '衣料有真实的物理褶皱：布料被身体起伏撑开后形成放射状的应力褶，褶皱深浅不一、走向符合重力，'
    + '不是画上去的花纹；织物表面有细密的纤维纹和柔和的丝光。',
  '头发不要画成一整块死黑：一缕一缕的发丝走向清楚，用两三档明暗分出高光和暗部，发梢渐细、边缘飞散。',
  // —— 视觉重心：用户反馈「性感写成这样，脸和气质就被挤掉了」——
  '脸的完成度是这张图的第一优先级：五官清晰、眼神有光、瞳孔里有光点，脸占画面上部的中央位置，是全图的视觉焦点。',
  // —— 反模板：一定要挡住三维半写实游戏立绘那个默认解 ——
  '不要三维渲染质感，不要体积光与高光，不要写实厚涂，不要欧美面孔，不要皮质束带紧身衣，不要现代机能风。',
  // 背景必须纯净到「抠图零风险」。踩过的坑：原先写「柔和的抽象光雾与飘散的花瓣 /
  // 抽象的祥云与飞溅的灵光」，出来是接近白色的水彩淡云，和浅肤色人物对比太弱，
  // @imgly 把大片云当成前景抠了下来，贴到卡面上就是一片横条脏斑。
  // 反正抠完背景也不留，不如直接要一整片纯净深色渐变：抠图稳、主体更突出、
  // 也从根上杜绝了「人物身后画出门框窗棂」这类装饰结构。
  '背景只是一整片纯净的深蓝黑到墨青色的柔和垂直渐变，除了这层渐变本身之外画面里不要再有任何东西。',
  '明亮的打光，打亮人物主体，背景保持深沉不抢戏。',
  // 卡面下半部分留给运行时绘制的名牌与数值，所以人物必须是半身而不是全身
  '构图为半身像：取头部到腰部以上，头部与上半身占满画面主体，下半身在腰胯处截断。',
  '人物不要居中留白，头部和上半身要顶到画面上部、四周只留很窄的边距。',
  '重点刻画面部表情、眼神、手部动作与手里的道具——要一眼看出这个角色此刻是什么状态、在干什么。',
  '高细节，锐利线条，官方卡牌原画级完成度。',  // 卡框、名牌、稀有度徽章都由 CardFactory 在运行时绘制，烘进图里会重复打架
  '画面中不要出现任何文字、汉字、标题、名牌、徽章、牌框、边框或 UI 元素，只保留人物插画本身。',
].join('');

const NEGATIVE = [
  '低分辨率，模糊，噪点，压缩瑕疵',
  // —— 反糙：实机放大后最刺眼的几种「没画完」感，逐项点名 ——
  '粗糙的线，断线，重线，糊成一团的色块，塑料感，油腻高光',
  '手指粘连，手指数不对，指节含糊，没有关节的手，看不清的指甲',
  '衣服上没有褶皱，衣物像贴纸，褶皱方向错误，整块死平的布料',
  '死黑的头发，没有层次的头发，整块黑色色块',
  '塑料感的武器，武器与手分离，刀柄穿过手掌',
  '畸形，多余手指，缺失手指，额外肢体，肢体错位',
  // —— 反三维：这一组词是拉住画风的关键，不能删 ——
  '三维渲染，体积光，写实摄影，厚涂油画，欧美漫画，欧美面孔，次世代游戏 CG',
  '皮质束带紧身衣，皮革胸衣，现代机能风，铆钉',
  // —— 防儿童化。这组和「性感」无关，是年龄下限的硬边界：它防的是
  //    「巨乳 + 幼态体型」这个组合，而不是限制性感程度，所以不能删。
  '未成年，幼态，儿童比例，Q版，童颜',
  '文字，汉字，英文，字幕，书法，印章，水印，签名，logo，UI元素',
  '卡牌边框，牌框，装饰边框，元勋卡设计，UI 排版',
  // 人物身后的装饰结构抠图时会留下来，在卡面上看成第二层框；
  // 淡色背景云同理，会被当成前景抠下来变成横条脏斑
  '拱门，门框，屏风，亭子，窗棂，旗帜，牌匾，建筑构件，圆形光环',
  '祥云，水彩云，花瓣，光斑，萤火，背景装饰，噪点纹理',
  // —— 禁烘焙全息：画里自带彩虹扫光和闪粉，运行时 foil 就没有活可干了，
  //    而赛璐璐平涂只有两三档明暗，正是最容易被自发光吃掉的那种底子，
  //    结果是视差平面糊成一锅汤、线发光顺着色块爬。foil 属于材质，不属于画。
  '彩虹扫光，彩虹反光，棱镜光，虹彩，闪粉，箔片反光，虹彩渐变',
  '徽章，评级标识，价格标签',
  '现代服饰，现代建筑，汽车，电线',
  '剪影，低饱和灰调，画面脏',
  '重复，拼接，分屏',
].join('，');

/** art 块缺省时的兜底：宁可弱一点，也不要所有人长得一样 */
const FALLBACK_ART = {
  archetype: '按称号与背景推定的性转武侠形象',
  face: '成熟妩媚的女性面容，眼神锐利有神',
  body: '高挑匀称，曲线分明，丰满的胸型与腰臀比',
  hair: '有明确个人特征的古典发式',
  costume: '贴合身形的武侠劲装，性感靠剪裁与织物张力表达',
  silhouette: '一件能一眼认出身份的随身兵器或信物',
  pose: '略带侧身的四分之三角度，动态自然',
};

function buildPrompt(c: CharacterDef): string {
  const el = ELEMENT_CN[c.element] ?? c.element;
  const hex = c.color.replace('#', '');
  const a = { ...FALLBACK_ART, ...(c.art ?? {}) };
  return [
    '【角色设定 · 仅供理解，请务必不要把其中任何文字画进画面】',
    `姓名：${c.name}；称号：${c.title}；定位：${c.role}型，${el}属性；稀有度：${c.rarity}`,
    `气质：${c.tagline}`,
    `背景：${c.lore}`,
    '',
    '【本角色的外形设定 · 逐条严格执行，这就是她的辨识度】',
    `原型转性：${a.archetype}`,
    `脸：${a.face}`,
    `体型：${a.body}`,
    `发型：${a.hair}`,
    `服装：${a.costume}`,
    `剪影标识：${a.silhouette}`,
    `姿势与镜头：${a.pose}`,
    ...(a.avoid ? [`本角色额外禁止：${a.avoid}`] : []),
    '',
    '【画面要求】',
    `主色调 ${hex}，点缀色调 ${c.accent.replace('#', '')}。`,
    STYLE,
  ].join('\n');
}

/* --------------------------------------------------------- ComfyUI API */

function workflow(prompt: string, seed: number, negative: string = NEGATIVE): Record<string, unknown> {
  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: MODELS.unet, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: MODELS.clip, type: MODELS.clipType, device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: MODELS.vae } },
    4: {
      class_type: 'TextEncodeQwenImage21',
      inputs: { clip: ['2', 0], prompt, negative_prompt: negative, resolution: Math.max(args.width, args.height), images: [], vae: ['3', 0] },
    },
    5: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: MODELS.shift } },
    6: { class_type: 'EmptySD3LatentImage', inputs: { width: args.width, height: args.height, batch_size: 1 } },
    7: {
      class_type: 'KSampler',
      inputs: {
        model: ['5', 0],
        seed,
        steps: args.steps,
        cfg: args.cfg,
        sampler_name: 'euler',
        scheduler: 'simple',
        positive: ['4', 0],
        negative: ['4', 1],
        latent_image: ['6', 0],
        denoise: 1,
      },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'celestial' } },
  };
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(`${args.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

async function generate(c: CharacterDef): Promise<void> {
  const seed = args.seed >= 0 ? args.seed : Math.floor(Math.random() * 2 ** 31);
  // raw 模式：prompt 与 negative 都来自外部原文，不套 STYLE/NEGATIVE 拼接。
  const prompt = c.rawPrompt ?? buildPrompt(c);
  const negative = c.rawNegative ?? NEGATIVE;

  const sub = await post('/prompt', { prompt: workflow(prompt, seed, negative), client_id: 'niangshan-genart' });
  if (!sub.ok) {
    console.error(`  ✗ ${c.id} 提交失败 HTTP ${sub.status}`);
    console.error(`    ${sub.text.slice(0, 900)}`);
    process.exitCode = 1;
    return;
  }
  const { prompt_id: promptId } = JSON.parse(sub.text) as { prompt_id: string };
  process.stdout.write(`  · ${c.id} 已提交 ${promptId.slice(0, 8)} …`);

  const t0 = Date.now();
  let done: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }> = {};
  while (Date.now() - t0 < 45 * 60_000) {
    await new Promise((r) => setTimeout(r, 3000));
    const h = await fetch(`${args.base}/history/${promptId}`);
    if (!h.ok) continue;
    const hist = (await h.json()) as Record<
      string,
      {
        outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }>;
        status?: { status_str?: string; messages?: [string, Record<string, unknown>][] };
      }
    >;
    const entry = hist[promptId];
    if (!entry) continue;
    // 执行失败要立刻报出来，否则只能干等到超时
    if (entry.status?.status_str === 'error') {
      const err = entry.status.messages?.find((m) => m[0] === 'execution_error')?.[1] as
        | { node_type?: string; exception_message?: string }
        | undefined;
      console.error(
        `\r  ✗ ${c.id} 执行失败 @ ${err?.node_type ?? '?'}: ${(err?.exception_message ?? '未知错误').trim().slice(0, 300)}`,
      );
      process.exitCode = 1;
      return;
    }
    if (entry.outputs) { done = entry.outputs; break; }
  }
  if (!Object.keys(done).length) {
    console.error(`\r  ✗ ${c.id} 超时未返回`);
    process.exitCode = 1;
    return;
  }

  const img = Object.values(done).flatMap((o) => o.images ?? [])[0];
  if (!img) { console.error(`\r  ✗ ${c.id} 返回里没有图片`); process.exitCode = 1; return; }

  const qs = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type });
  const bin = await fetch(`${args.base}/view?${qs}`);
  if (!bin.ok) { console.error(`\r  ✗ ${c.id} 下载图片失败`); process.exitCode = 1; return; }
  const buf = Buffer.from(await bin.arrayBuffer());

  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(join(RAW_DIR, `${c.id}.png`), buf);

  const [out, ext] = await cutout(buf, (note) => process.stdout.write(`\r    ${note}`));
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${c.id}.${ext}`);
  dropStale(c.id, ext);
  writeFileSync(file, out);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\r  ✓ ${c.id} → ${file.replace(ROOT, '.')}  ${(out.length / 1024).toFixed(0)} KB  ${secs}s  seed=${seed}` +
      `  ${ext === 'webp' ? '抠透明' : '未抠'}`,
  );
}

/**
 * 抠透明背景，产出带 alpha 的 PNG —— 这样运行时才能把人物层叠在底板层上。
 *
 * 为什么不走 ComfyUI 侧的 `easy imageRemBg`：那台机器连不上 HuggingFace
 * （`huggingface_hub.errors.LocalEntryNotFoundError`），RMBG 权重下不下来。
 * 本机有 npm registry，所以抠图在 Node 侧用 @imgly/background-removal-node 做。
 * 依赖缺失或抠图失败时退回原图，不让整条管线断掉。
 *
 * 要 `image/x-rgba8` 原始像素而不是它默认的 `image/png`：
 * 它内部会把结果量化成 256 色调色板 PNG，插画上会出明显色带。自己编码真 RGBA。
 */
let removerP: Promise<(b: Blob, o?: object) => Promise<Blob>> | null = null;
function getRemover() {
  if (!removerP) {
    removerP = import('@imgly/background-removal-node')
      .then((m) => (m as unknown as { removeBackground: (b: Blob, o?: object) => Promise<Blob> }).removeBackground)
      .catch((e: Error) => {
        console.warn(`\r    ⚠ 抠图依赖不可用（${e.message.slice(0, 80)}），改用原图；` +
          '装一下：npm i -D @imgly/background-removal-node');
        return () => Promise.reject(new Error('remover unavailable'));
      });
  }
  return removerP;
}

/** 返回 [数据, 扩展名]。抠图成功出 webp，失败或 `--no-cutout` 出原 png。 */
async function cutout(raw: Buffer, note: (s: string) => void): Promise<[Buffer, 'webp' | 'png']> {
  if (!args.cutout) return [raw, 'png'];
  try {
    const removeBackground = await getRemover();
    note('抠图中 …');
    const t0 = Date.now();
    const blob = await removeBackground(new Blob([new Uint8Array(raw)], { type: 'image/png' }), {
      // 只能用 medium：1.4.5 的 zod 枚举虽然写着 small|medium|large，
      // 但 dist/resources.json 里只打包了 /models/small 和 /models/medium，
      // 传 large 会直接抛 `Resource /models/large not found` 然后退回未抠的原图。
      model: 'medium',
      output: { format: 'image/webp', quality: 0.92 },
    });
    const out = Buffer.from(await blob.arrayBuffer());    const { width, height } = readPngSize(raw);
    note(`抠图 ${((Date.now() - t0) / 1000).toFixed(1)}s  ${width}×${height}  ${(out.length / 1024).toFixed(0)} KB`);
    return [out, 'webp'];
  } catch (e) {
    note(`⚠ 抠图失败退回原图（${(e as Error).message.slice(0, 60)}）`);
    return [raw, 'png'];
  }
}

/**
 * 同一个角色可能先后留下不同扩展名的产物（抠图前是 .png，抠图后是 .webp）。
 * 留着旧的那份，运行时按 webp → png 找图虽不会出错，但白白多几 MB 发到线上。
 * 删不掉不算致命（有些环境有删除保护），只提示。
 */
function dropStale(id: string, keepExt: string): void {
  for (const ext of ['webp', 'png']) {
    if (ext === keepExt) continue;
    const p = join(OUT_DIR, `${id}.${ext}`);
    if (!existsSync(p)) continue;
    try {
      rmSync(p);
      if (existsSync(p)) console.warn(`\n    ⚠ 删不掉旧文件（可能有删除保护）：${p.replace(ROOT, '.')}`);
    } catch (e) {
      console.warn(`\n    ⚠ 删不掉旧文件 ${p.replace(ROOT, '.')}：${(e as Error).message}`);
    }
  }
}

function readPngSize(png: Buffer): { width: number; height: number } {
  if (png.subarray(12, 16).toString('ascii') !== 'IHDR') throw new Error('不是 PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/* ---------------------------------------------------------------- main */

const chars = loadChars();
// --raw 走完全独立的一条路：自己的 prompt、自己的负向、自己的输出目录。
if (args.raw) {
  OUT_DIR = args.outDir ? resolve(ROOT, args.outDir) : join(ROOT, 'public', 'art', 'standalone');
  // 外部原文可能带完整场景，不是抠图素材，默认不抠。
  if (args.cutout && !args.force) args.cutout = false;
}
const picked = args.raw ? loadRaw() : args.only.length ? chars.filter((c) => args.only.includes(c.id)) : chars;

if (args.only.length && !args.raw && picked.length !== args.only.length) {
  const missing = args.only.filter((id) => !chars.some((c) => c.id === id));
  if (missing.length) console.error(`找不到角色: ${missing.join(', ')}`);
}

/** 运行时按 webp → png 的顺序找，所以两个扩展名都认。 */
function findArt(id: string): string | null {
  for (const ext of ['webp', 'png']) {
    const p = join(OUT_DIR, `${id}.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

/* ------------------------------------------------------- raw 外部提示词 */

/**
 * `--raw <file>`：完全绕开 buildPrompt / STYLE / NEGATIVE，把外部写的提示词
 * 原文直接送进模型。用来出「不遵守卡面规范」的独立插画——比如带场景、带题字、
 * 坐姿全身、厚涂风，这些和卡面立绘的 STYLE 是互斥的，混在一起两边都出不好。
 *
 * 文件里用「负面：」一行切分正向与负向。
 * 输出默认落在 public/art/standalone/，**不碰 public/art/characters/**，
 * 避免一张插画把卡面立绘顶掉。
 */
function loadRaw(): CharacterDef[] {
  const text = readFileSync(resolve(ROOT, args.raw), 'utf8');
  const cut = text.search(/^\s*(负面|negative)\s*[:：]/im);
  const positive = (cut >= 0 ? text.slice(0, cut) : text).trim();
  const negative = cut >= 0 ? text.slice(cut).replace(/^\s*(负面|negative)\s*[:：]/im, '').trim() : '';
  const id = args.out || basename(args.raw).replace(/\.[^.]+$/, '');
  return [{
    id, number: 0, name: id, title: '(raw)',
    rarity: '—', element: '—', role: '—',
    color: '#ffffff', accent: '#ffffff', tagline: '', lore: '',
    rawPrompt: positive,
    rawNegative: negative,
  }];
}

if (args.list) {
  console.log(`角色 ${chars.length} 个，立绘输出目录 ${OUT_DIR.replace(ROOT, '.')}`);
  for (const c of chars) {
    const f = findArt(c.id);
    const raw = existsSync(join(RAW_DIR, `${c.id}.png`));
    console.log(
      `  ${f ? '[有]' : '[缺]'} #${String(c.number).padStart(3, ' ')} ${c.id.padEnd(12)} ${c.name} · ${c.title}` +
        `${f ? `  ${f!.slice(f!.lastIndexOf('.') + 1)}` : ''}${raw ? '  (有原图缓存)' : ''}`,
    );
  }
  process.exit(0);
}

// --prompt：原样打印将要发给模型的 prompt，不连 ComfyUI、不烧 GPU、不改任何文件。
// 调提示词时用它看真实送进模型的文本，比对着源码手抄靠谱。
if (args.prompt) {
  for (const c of picked) {
    console.log(`${'='.repeat(78)}\n${c.name}（${c.id}）  seed 已定则用 seed，否则每次随机\n${'='.repeat(78)}`);
    console.log(buildPrompt(c));
    console.log(`\n${'-'.repeat(78)}\n负向词（并入正向 prompt，ming 侧无负向口）\n${'-'.repeat(78)}`);
    console.log(NEGATIVE);
    console.log();
  }
  process.exit(0);
}

// --recutout：拿 .artcache 里的原图重新抠，不连 ComfyUI、不烧 GPU
if (args.recutout) {
  const cached = existsSync(RAW_DIR)
    ? readdirSync(RAW_DIR).filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, ''))
    : [];
  const todo = args.only.length ? cached.filter((id) => args.only.includes(id)) : cached;
  if (!todo.length) {
    console.error(`原图缓存里没有可抠的图（${RAW_DIR.replace(ROOT, '.')}），先跑一次正常生成`);
    process.exit(1);
  }
  console.log(`从原图缓存重抠 ${todo.length} 张\n`);
  mkdirSync(OUT_DIR, { recursive: true });
  for (const id of todo) {
    const raw = readFileSync(join(RAW_DIR, `${id}.png`));
    const [out, ext] = await cutout(raw, (n) => process.stdout.write(`\r  · ${id} ${n}          `));
    dropStale(id, ext);
    writeFileSync(join(OUT_DIR, `${id}.${ext}`), out);
    console.log(`\r  ✓ ${id} → ${join(OUT_DIR, `${id}.${ext}`).replace(ROOT, '.')}  ${(out.length / 1024).toFixed(0)} KB          `);
  }
  console.log('\n完成。');
  process.exit(process.exitCode ?? 0);
}

try {
  const probe = await fetch(`${args.base}/system_stats`);
  if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
} catch (e) {
  console.error(`连不上 ComfyUI: ${args.base}  (${(e as Error).message})`);
  console.error('用 --base 指定地址，例如 --base http://192.168.0.134:8188');
  process.exit(1);
}

const todo = args.force ? picked : picked.filter((c) => !findArt(c.id));
const skipped = picked.length - todo.length;
console.log(`ComfyUI ${args.base}｜${args.width}×${args.height}｜steps ${args.steps} cfg ${args.cfg} shift ${MODELS.shift}`);
console.log(`待生成 ${todo.length} 张${skipped > 0 ? `，跳过已有 ${skipped} 张（--force 可覆盖）` : ''}\n`);

for (const c of todo) {
  try {
    await generate(c);
  } catch (e) {
    console.error(`  ✗ ${c.id} 异常: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
console.log(todo.length ? '\n完成。' : '\n没有需要生成的立绘。');
