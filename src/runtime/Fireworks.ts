import * as THREE from 'three';

/**
 * 切卡时的登场演出。
 *
 * 参考的是炉石那种「抽卡」观感——**能量从卡面四边涌出来**，符文碎片在卡前
 * 转着飞出去，整张卡被一圈过曝的光框包住。关键不在粒子多，在**粒子贴着卡
 * 长出来**：把一堆点扔在卡旁边的空处，无论多少颗都还是「几个粗糙的粒子」。
 *
 * 三个系统，一共 4 次 draw call：
 *
 *   - **shell**  升空段：一颗弹头甩出一路火星（带阻尼的小弹道，拖尾散成锥形）
 *   - **burst**  火花：`aura` 沿卡面矩形四边往外喷，`sphere/ring/菊/柳` 从一点炸开。
 *                 每颗再画两颗更早时刻的拖影，于是是「亮头 + 丝」而不是孤立的点
 *   - **chips**  符文碎片：自转的圆角方片，比火星大、慢、亮得多——**尺寸对比**
 *                 才是「立体」的来源，全是同样大小的东西就只是一团噪点
 *   - **halo**   卡面能量环：一张加色方片，按圆角矩形 SDF 画一条向外扩张的亮边
 *
 * 「好看」的几条具体配方（查过 gmiv/fireworks 的 12 型、a-small-firework 的公式、
 * three.js 粒子烟花那套 shader 之后补的）：
 *   1. **亮过再淡**。社区写的是 `lifeRatio < fadeStart ? lifeRatio/fadeStart : 1`
 *      ——前 30~50% 寿命保持满亮度才收尾。从 0 就按 (1-u)^k 掉的话，炸开那一瞬
 *      整朵花已经在变暗，颜色尺寸怎么调都是灰的。
 *   2. **过曝白核**。真烟花每颗火星都烧白，只有彩色柔光斑就只是雾。
 *   3. **拖影**。用 `aStart` 往后推时刻就是天然的影，同一颗共用一份速度/位置。
 *   4. **半径 ease-out 展开**。几百颗同一帧出现在一个点是**一坨**过曝白斑。
 *
 * 每颗粒子的轨迹都在顶点着色器里**解析求值**（带线性阻尼的弹道有闭式解）：
 *     v(t) = G + (v0-G)e^(-kt)          G = g/k
 *     p(t) = G·t + (v0-G)(1-e^(-kt))/k
 * CPU 每帧只推进一个 `uT`，2000+ 颗仍然一次 draw call、零分配。
 */

const SHELL_SPARKS = 112;
/** 每颗火星额外画两颗更早时刻的拖影 */
const BURST_ECHOES = 2;
const ECHO_DT = 0.016;
const MAIN_COUNT = 900;
const SUB_EACH = 30;
const BURST_MAX = (MAIN_COUNT + 9 * SUB_EACH) * (BURST_ECHOES + 1);
const CHIP_MAX = 48;
/** 能量环那张方片是卡面的多少倍（要留出往外扩张的余量） */
const HALO_PAD = 1.95;
const SHOW_POOL = 3;
/** 亮过再淡：前这么多比例的寿命保持满亮度 */
const FADE_START = 0.34;
/** 爆炸半径在这么长的时间里 ease-out 推出去 */
const EXPAND_S = 0.07;

export type FireworkShape =
  | 'aura'            // 沿卡面矩形四边往外涌（切卡默认）
  | 'sphere' | 'ring' | 'chrysanthemum' | 'willow';

export interface FireworkOptions {
  x?: number;
  y?: number;
  z?: number;
  color: number;
  /** 爆点比发射点高多少（世界单位） */
  rise?: number;
  shape?: FireworkShape;
  /** 整体尺寸，1 = 标准 */
  scale?: number;
  /**
   * 粒子框。给了就沿这条矩形的**四边**往外喷（aura），给的就是卡面尺寸。
   * 没给就是从单点炸开。中心在 root 的局部 (0,0,0)。
   */
  frame?: { w: number; h: number };
  /** 卡面尺寸，给能量环用；不给就不放环 */
  card?: { w: number; h: number };
}

/* ---------------------------------------------------------------- 着色器 */

const shellVertex = /* glsl */ `
attribute vec3 aVel;      // 这一颗火星自己的出膛速度（含一点向下/侧向抖动）
attribute float aDelay;   // 点火时刻（相对发射）；负数表示「它就是弹头」
attribute float aSize;
attribute float aSeed;
attribute float aLife;
uniform float uT, uDrag, uG, uScale, uSG, uSK;
varying float vA;
varying vec3 vCol;
void main() {
  float k = uDrag;
  vec3 G = vec3(0.0, -uG / k, 0.0);
  vec3 B = aVel - G;
  float te = aDelay < 0.0 ? uT : aDelay;
  float age = uT - te;
  if (aDelay >= 0.0 && (age < 0.0 || age > aLife)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; return;
  }
  vec3 emit = G * te + B * ((1.0 - exp(-k * te)) / k);
  vec3 p = emit;
  float a = 1.0;
  if (aDelay >= 0.0) {
    // 火星：从点火那一刻起自己再走一段带阻尼的小弹道，于是拖尾散成锥形。
    float ks = uSK;
    vec3 Gs = vec3(0.0, -uSG / ks, 0.0);
    vec3 Bs = aVel - Gs + vec3(0.0, -0.55 - aSeed * 1.5, 0.0);
    p = emit + Gs * age + Bs * ((1.0 - exp(-ks * age)) / ks);
    float u = clamp(age / aLife, 0.0, 1.0);
    float fade = 1.0 - (u - 0.18) / 0.82;
    a = pow(clamp(fade, 0.0, 1.0), 1.4) * smoothstep(0.0, 0.03, u);
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  // vCol 必须在这里写：片元着色器共用 sparkFragment，它要读 vCol。
  // 升空段之前没写这个 varying，WebGL 给的是未定义值——画出来是一块硬边白斑。
  vCol = vec3(1.0, 0.86, 0.58);
  vA = a;
  gl_PointSize = aSize * uScale / max(-mv.z, 0.05);
}
`;

const burstVertex = /* glsl */ `
attribute vec3 aVel;
attribute vec3 aColor;
attribute vec3 aOrigin;   // 从哪炸（aura 是矩形边上的某点，主爆是原点）
attribute float aSize;
attribute float aSeed;
attribute float aLife;
attribute float aStart;   // 相对本发起爆的延迟：二次爆炸错开、拖影也用它
attribute float aEcho;    // 0 = 火星本体；1/2 = 同一颗在更早时刻的拖影
uniform float uT, uDrag, uG, uScale;
varying vec3 vCol;
varying float vA;
void main() {
  float t = uT - aStart;
  if (t < 0.0 || t > aLife) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; return; }
  float k = uDrag;
  vec3 G = vec3(0.0, -uG / k, 0.0);
  vec3 B = aVel - G;
  vec3 p = G * t + B * ((1.0 - exp(-k * t)) / k);
  // 几百颗同一帧出现在一个点是**一坨**过曝白斑，不是花。先把半径 ease-out 推出去。
  float ex = 1.0 - pow(1.0 - clamp(t / ${EXPAND_S.toFixed(3)}, 0.0, 1.0), 3.0);
  p *= ex;
  vec4 mv = modelViewMatrix * vec4(p + aOrigin, 1.0);
  gl_Position = projectionMatrix * mv;

  float echo = aEcho;
  float u = t / aLife;
  // 亮过再淡：前 FADE_START 保持满亮度，之后才收。
  float fade = u < ${FADE_START.toFixed(3)}
    ? 1.0
    : 1.0 - (u - ${FADE_START.toFixed(3)}) / ${(1 - FADE_START).toFixed(3)};
  fade = pow(clamp(fade, 0.0, 1.0), 1.25);
  // 出生的那一瞬烧白。拖影取的是更早的时刻，它的「出生闪光」早就过了，不能跟着亮。
  float flash = exp(-u * 16.0) * (1.0 - echo);
  // 末段高频闪烁，做出纸屑的「炸响」感
  float twinkle = u > 0.55 ? (0.5 + 0.5 * sin(uT * 30.0 + aSeed * 6.2831)) : 1.0;
  vCol = aColor * fade + vec3(flash * 0.95);
  // 拖影淡得更快，于是「一颗火星带一条尾巴」是**连续**读出来的。
  vA = fade * twinkle * 0.62 * (1.0 - echo * 0.42);
  gl_PointSize = aSize * uScale * (0.34 + 0.66 * fade)
               * (1.0 + flash * 0.8) * (1.0 - echo * 0.33)
               / max(-mv.z, 0.05);
}
`;

const chipVertex = /* glsl */ `
attribute vec3 aVel;
attribute vec3 aColor;
attribute vec3 aOrigin;
attribute float aSize;
attribute float aSeed;
attribute float aLife;
attribute float aStart;
uniform float uT, uDrag, uG, uScale;
varying vec3 vCol;
varying float vA;
varying float vRot;
varying vec2 vHalf;
void main() {
  float t = uT - aStart;
  if (t < 0.0 || t > aLife) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; return; }
  float k = uDrag;
  vec3 G = vec3(0.0, -uG / k, 0.0);
  vec3 B = aVel - G;
  vec3 p = G * t + B * ((1.0 - exp(-k * t)) / k);
  vec4 mv = modelViewMatrix * vec4(p + aOrigin, 1.0);
  gl_Position = projectionMatrix * mv;
  float u = t / aLife;
  float fade = pow(clamp(1.0 - u, 0.0, 1.0), 1.5);
  float flash = exp(-u * 7.0);
  // 自转。符文碎片必须在转，转起来才读得出是**片**不是点。
  vRot = u * (1.6 + aSeed * 4.4) * 6.2831 * (aSeed > 0.5 ? 1.0 : -1.0);
  // 碎片长宽要混着来：全是一个比例的长条，五十片一起飞就是一把碎纸。
  vHalf = mix(vec2(0.085, 0.44), vec2(0.21, 0.28), fract(aSeed * 7.31));
  // 白热只加 0.45：加 0.8 时出生头 0.2s 内整片就白了，金色/稀有度色全看不见。
  vCol = aColor + vec3(flash * 0.45);
  vA = (fade * 0.9 + flash * 0.5) * 0.95;
  gl_PointSize = aSize * uScale * (0.55 + 0.45 * fade) * (1.0 + flash * 0.6)
               / max(-mv.z, 0.05);
}
`;

const sparkFragment = /* glsl */ `
varying vec3 vCol;
varying float vA;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  if (r > 1.0) discard;
  // 外圈是本色的柔光，中心再压一层**过曝白核**——真烟花每颗火星都是烧白的，
  // 缺了这层核，再多粒子也只是一堆彩色柔光斑。
  float halo = pow(1.0 - r, 2.4);
  float core = pow(1.0 - r, 9.0);
  // AdditiveBlending 是 (SrcAlpha, One)：衰减全交给 alpha，rgb 保持纯色，
  // 否则每颗都自带一层灰，叠成一片雾。
  gl_FragColor = vec4(mix(vCol, vec3(1.0), core * 0.85), (halo + core) * vA);
}
`;

const chipFragment = /* glsl */ `
varying vec3 vCol;
varying float vA;
varying float vRot;
varying vec2 vHalf;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float c = cos(vRot), s = sin(vRot);
  vec2 r = vec2(d.x * c - d.y * s, d.x * s + d.y * c);
  // 圆角矩形 SDF：符文是**片**，不是点。
  vec2 q = abs(r) - vHalf;
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.05;
  // 片外那一圈辉光。缺了它，碎片就是一张贴在画面上的白纸片，不发光。
  float glow = exp(-max(sd, 0.0) * 10.0);
  float body = 1.0 - smoothstep(-0.02, 0.02, sd);
  if (body < 0.01 && glow < 0.02) discard;
  // 亮边必须**细**：片宽才 0.2~0.4，边带一旦超过 0.1，整片都被判成边，
  // mix(...,white,rim) 下去符文立刻退化成纸屑，颜色一点不剩。
  float rim = smoothstep(0.032, 0.0, abs(sd));
  // 片身沿长轴有明暗，转起来才看得出是块有厚度的薄片，不是贴纸。
  float shade = 0.60 + 0.40 * (0.5 + 0.5 * r.y);
  vec3 col = mix(vCol * shade, vec3(1.0), rim * 0.9);
  // AdditiveBlending 是 (SrcAlpha, One)：衰减全交给 alpha，rgb 保持纯色。
  float a = (body * 0.52 + rim * 0.8) * vA + glow * vA * 0.42;
  gl_FragColor = vec4(col, a);
}
`;

const haloVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const haloFragment = /* glsl */ `
varying vec2 vUv;
uniform float uEdge, uW, uA, uFlash;
uniform vec3 uColor;
void main() {
  vec2 p = abs(vUv - 0.5) * 2.0;
  float edge = max(p.x, p.y);                       // 方形边框距离
  float band = exp(-pow((edge - uEdge) / uW, 2.0)); // 那条往外扩张的亮边
  float wash = smoothstep(uEdge + 0.06, uEdge - 0.60, edge) * 0.09;
  float a = (band + wash) * uA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(uColor, vec3(1.0), min(1.0, band * uFlash)), a);
}
`;

/* ---------------------------------------------------------------- 几何 */

/** Fibonacci 球面：比随机撒点均匀得多，不会鼓出一块一块。 */
function sphereDirection(i: number, n: number, out: THREE.Vector3): THREE.Vector3 {
  const y = 1 - (i / Math.max(1, n - 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = i * 2.39996323; // 黄金角
  return out.set(Math.cos(theta) * r, y, Math.sin(theta) * r);
}

/**
 * 矩形周长上的第 t 个点（t ∈ [0,1)），以及那里朝外的法线。
 *
 * 「粒子贴着卡长出来」全靠这个：粒子不是从一个点炸开，而是从**整条卡框**炸开。
 */
const _n = new THREE.Vector3();
function perimeterPoint(t: number, w: number, h: number,
                         out: THREE.Vector3, normal: THREE.Vector3): void {
  const L = 2 * (w + h);
  let s = ((t % 1) + 1) % 1 * L;
  if (s < w) { out.set(-w / 2 + s, h / 2, 0); normal.set(0, 1, 0); return; }
  s -= w;
  if (s < h) { out.set(w / 2, h / 2 - s, 0); normal.set(1, 0, 0); return; }
  s -= h;
  if (s < w) { out.set(w / 2 - s, -h / 2, 0); normal.set(0, -1, 0); return; }
  s -= w;
  out.set(-w / 2, -h / 2 + s, 0); normal.set(-1, 0, 0);
}

/**
 * 反解升空初速：给定想要的顶点高度 rise，求 v0。
 *
 * 令 G = g/k、u = v0/G - 1，则顶点高度 = (g/k²)·(ln u + u - 1)，
 * 单调递增，二分十次就够（每次发射算一次，代价可以忽略）。
 */
function solveRise(rise: number, g: number, k: number): { v0: number; apexT: number } {
  const G = g / k;
  const target = Math.max(1e-3, rise) * k * k / g;   // = ln u + u - 1
  let lo = 1e-3, hi = 40;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (Math.log(mid) + mid - 1 < target) lo = mid; else hi = mid;
  }
  const u = (lo + hi) / 2;
  return { v0: G * (1 + u), apexT: Math.log(u) / k };
}

/** 每种花型的物性。量级照 gmiv/fireworks 的 FIREWORK_TYPES 那一套。 */
const PHYSICS: Record<FireworkShape, { speed: number; drag: number; life: number; subs: number }> = {
  // aura 只是往外喷，所以速度小、阻力大（走不远，像从框里渗出来）
  aura: { speed: 3.1, drag: 2.2, life: 1.6, subs: 0 },
  sphere: { speed: 7.4, drag: 1.5, life: 1.5, subs: 7 },
  ring: { speed: 7.8, drag: 1.7, life: 1.35, subs: 6 },
  chrysanthemum: { speed: 6.9, drag: 1.35, life: 1.9, subs: 9 },
  // 柳条拖得久、阻力小，不串二次爆炸（那会让柳条糊成一团）
  willow: { speed: 5.6, drag: 0.9, life: 2.5, subs: 0 },
};

const _v = new THREE.Vector3();
const _c2 = new THREE.Color();

/* ---------------------------------------------------------------- 主体 */

interface Show {
  root: THREE.Group;
  shellGeo: THREE.BufferGeometry;
  shellMat: THREE.ShaderMaterial;
  shell: THREE.Points;
  burstGeo: THREE.BufferGeometry;
  burstMat: THREE.ShaderMaterial;
  burst: THREE.Points;
  chipGeo: THREE.BufferGeometry;
  chipMat: THREE.ShaderMaterial;
  chips: THREE.Points;
  haloGeo: THREE.BufferGeometry;
  haloMat: THREE.ShaderMaterial;
  halo: THREE.Mesh;
  shellVel: Float32Array;
  shellDelay: Float32Array;
  shellSize: Float32Array;
  shellSeed: Float32Array;
  shellLife: Float32Array;
  burstVel: Float32Array;
  burstColor: Float32Array;
  burstOrigin: Float32Array;
  burstSize: Float32Array;
  burstSeed: Float32Array;
  burstLifeArr: Float32Array;
  burstStart: Float32Array;
  burstEcho: Float32Array;
  chipVel: Float32Array;
  chipColor: Float32Array;
  chipOrigin: Float32Array;
  chipSize: Float32Array;
  chipSeed: Float32Array;
  chipLife: Float32Array;
  chipStart: Float32Array;
  hasHalo: boolean;
  apexT: number;
  /** 爆炸段整发的时长，用来判回收 */
  burstSpan: number;
  t: number;
  phase: 'rise' | 'burst' | 'done';
}

export class Fireworks {
  readonly group = new THREE.Group();
  private readonly shows: Show[] = [];
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly owned: { dispose(): void }[] = [];
  private px = 1;

  constructor() {
    this.group.name = 'card-reveal-fx';
    for (let i = 0; i < SHOW_POOL; i++) this.shows.push(this.makeShow());
  }

  private makeShow(): Show {
    const F3 = (n: number) => new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    const add = (mat: THREE.ShaderMaterial | null) => {
      if (mat) this.owned.push(mat);
    };

    /* ---- 升空段 ---- */
    const shellGeo = new THREE.BufferGeometry();
    const shellVel = new Float32Array(SHELL_SPARKS * 3);
    const shellDelay = new Float32Array(SHELL_SPARKS);
    const shellSize = new Float32Array(SHELL_SPARKS);
    const shellSeed = new Float32Array(SHELL_SPARKS);
    const shellLife = new Float32Array(SHELL_SPARKS);
    shellGeo.setAttribute('position', F3(SHELL_SPARKS));
    shellGeo.setAttribute('aVel', new THREE.BufferAttribute(shellVel, 3));
    shellGeo.setAttribute('aDelay', new THREE.BufferAttribute(shellDelay, 1));
    shellGeo.setAttribute('aSize', new THREE.BufferAttribute(shellSize, 1));
    shellGeo.setAttribute('aSeed', new THREE.BufferAttribute(shellSeed, 1));
    shellGeo.setAttribute('aLife', new THREE.BufferAttribute(shellLife, 1));
    const shellMat = new THREE.ShaderMaterial({
      uniforms: {
        uT: { value: 0 }, uDrag: { value: 1.35 }, uG: { value: 3.2 }, uScale: { value: 110 },
        // 火星自己的弹道：比弹头重得多，所以重力大、阻尼大，落得又快又短。
        uSG: { value: 5.2 }, uSK: { value: 2.6 },
      },
      vertexShader: shellVertex, fragmentShader: sparkFragment,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    });
    const shell = new THREE.Points(shellGeo, shellMat);
    shell.frustumCulled = false;
    shell.visible = false;
    shell.renderOrder = 20;
    this.owned.push(shellGeo);
    add(shellMat);

    /* ---- 火花 ---- */
    const burstGeo = new THREE.BufferGeometry();
    const burstVel = new Float32Array(BURST_MAX * 3);
    const burstColor = new Float32Array(BURST_MAX * 3);
    const burstOrigin = new Float32Array(BURST_MAX * 3);
    const burstSize = new Float32Array(BURST_MAX);
    const burstSeed = new Float32Array(BURST_MAX);
    const burstLifeArr = new Float32Array(BURST_MAX);
    const burstStart = new Float32Array(BURST_MAX);
    const burstEcho = new Float32Array(BURST_MAX);
    burstGeo.setAttribute('position', F3(BURST_MAX));
    burstGeo.setAttribute('aVel', new THREE.BufferAttribute(burstVel, 3));
    burstGeo.setAttribute('aColor', new THREE.BufferAttribute(burstColor, 3));
    burstGeo.setAttribute('aOrigin', new THREE.BufferAttribute(burstOrigin, 3));
    burstGeo.setAttribute('aSize', new THREE.BufferAttribute(burstSize, 1));
    burstGeo.setAttribute('aSeed', new THREE.BufferAttribute(burstSeed, 1));
    burstGeo.setAttribute('aLife', new THREE.BufferAttribute(burstLifeArr, 1));
    burstGeo.setAttribute('aStart', new THREE.BufferAttribute(burstStart, 1));
    burstGeo.setAttribute('aEcho', new THREE.BufferAttribute(burstEcho, 1));
    const burstMat = new THREE.ShaderMaterial({
      uniforms: {
        uT: { value: -1 }, uDrag: { value: 1.5 }, uG: { value: 4.6 }, uScale: { value: 180 },
      },
      vertexShader: burstVertex, fragmentShader: sparkFragment,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    });
    const burst = new THREE.Points(burstGeo, burstMat);
    burst.frustumCulled = false;
    burst.visible = false;
    burst.renderOrder = 21;
    this.owned.push(burstGeo);
    add(burstMat);

    /* ---- 符文碎片 ---- */
    const chipGeo = new THREE.BufferGeometry();
    const chipVel = new Float32Array(CHIP_MAX * 3);
    const chipColor = new Float32Array(CHIP_MAX * 3);
    const chipOrigin = new Float32Array(CHIP_MAX * 3);
    const chipSize = new Float32Array(CHIP_MAX);
    const chipSeed = new Float32Array(CHIP_MAX);
    const chipLife = new Float32Array(CHIP_MAX);
    const chipStart = new Float32Array(CHIP_MAX);
    chipGeo.setAttribute('position', F3(CHIP_MAX));
    chipGeo.setAttribute('aVel', new THREE.BufferAttribute(chipVel, 3));
    chipGeo.setAttribute('aColor', new THREE.BufferAttribute(chipColor, 3));
    chipGeo.setAttribute('aOrigin', new THREE.BufferAttribute(chipOrigin, 3));
    chipGeo.setAttribute('aSize', new THREE.BufferAttribute(chipSize, 1));
    chipGeo.setAttribute('aSeed', new THREE.BufferAttribute(chipSeed, 1));
    chipGeo.setAttribute('aLife', new THREE.BufferAttribute(chipLife, 1));
    chipGeo.setAttribute('aStart', new THREE.BufferAttribute(chipStart, 1));
    const chipMat = new THREE.ShaderMaterial({
      uniforms: {
        uT: { value: -1 }, uDrag: { value: 1.9 }, uG: { value: 2.4 }, uScale: { value: 180 },
      },
      vertexShader: chipVertex, fragmentShader: chipFragment,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    });
    const chips = new THREE.Points(chipGeo, chipMat);
    chips.frustumCulled = false;
    chips.visible = false;
    chips.renderOrder = 22;
    this.owned.push(chipGeo);
    add(chipMat);

    /* ---- 卡面能量环 ---- */
    const haloGeo = new THREE.PlaneGeometry(1, 1);
    const haloMat = new THREE.ShaderMaterial({
      uniforms: {
        uT: { value: -1 }, uEdge: { value: 0.5 }, uW: { value: 0.05 },
        uA: { value: 0 }, uFlash: { value: 0 }, uColor: { value: new THREE.Color(1, 0.8, 0.45) },
      },
      vertexShader: haloVertex, fragmentShader: haloFragment,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.frustumCulled = false;
    halo.visible = false;
    halo.renderOrder = 19;
    this.owned.push(haloGeo);
    add(haloMat);

    const root = new THREE.Group();
    root.add(halo, shell, burst, chips);
    root.visible = false;
    this.group.add(root);

    return {
      root, shellGeo, shellMat, shell, burstGeo, burstMat, burst,
      chipGeo, chipMat, chips, haloGeo, haloMat, halo,
      shellVel, shellDelay, shellSize, shellSeed, shellLife,
      burstVel, burstColor, burstOrigin, burstSize, burstSeed, burstLifeArr,
      burstStart, burstEcho,
      chipVel, chipColor, chipOrigin, chipSize, chipSeed, chipLife, chipStart,
      hasHalo: false, apexT: 1, burstSpan: 1, t: 0, phase: 'done',
    };
  }

  /**
   * 点尺寸随画布高度缩放，否则高分屏上特效会小一圈。
   *
   * 系数是按「相机到卡面约 6.5 个单位」反算的：基础颗粒 aSize≈0.8，
   * 要在 900px 高的画布上落到 11px 左右，uScale 得是 180。取小了整朵花
   * 看着像浮在镜头前的灰。
   */
  setViewportHeight(h: number): void {
    this.px = Math.max(1, h / 900);
    for (const s of this.shows) {
      s.shellMat.uniforms.uScale.value = 110 * this.px;
      s.burstMat.uniforms.uScale.value = 180 * this.px;
      s.chipMat.uniforms.uScale.value = 150 * this.px;
    }
  }

  launch(opts: FireworkOptions): void {
    const s = this.free();
    if (!s) return;
    // 尊重「减少动态效果」：只给一小簇，不放碎片和能量环
    const calm = this.reduced.matches;
    const base = opts.scale ?? 1;
    const scale = base * (calm ? 0.45 : 1);
    const shape: FireworkShape = calm ? 'aura' : (opts.shape ?? 'aura');
    const phy = PHYSICS[shape];
    const fromFrame = shape === 'aura' && !!opts.frame;
    const fw = opts.frame?.w ?? 0;
    const fh = opts.frame?.h ?? 0;

    s.root.position.set(opts.x ?? 0, opts.y ?? 0, opts.z ?? 0);
    s.root.visible = true;
    s.t = 0;
    // aura 是「卡已经在那儿了，光从框里涌出来」，没有升空段；
    // 其余花型仍是两段式。
    s.phase = fromFrame || calm ? 'burst' : 'rise';

    const color = new THREE.Color(opts.color);
    const hsl = { h: 0, s: 0, l: 0 };
    color.getHSL(hsl);
    const speed = phy.speed * scale;
    s.burstMat.uniforms.uDrag.value = phy.drag * (calm ? 2.2 : 1);
    s.burstMat.uniforms.uG.value = (shape === 'willow' ? 3.7 : 4.6) * (fromFrame ? 0.75 : 1);
    s.burstSpan = phy.life * 1.3;

    /* ---------------------------------------------------------- 升空段 */
    if (s.phase === 'rise') {
      const g = s.shellMat.uniforms.uG.value as number;
      const k = s.shellMat.uniforms.uDrag.value as number;
      const rise = (opts.rise ?? 2.0) * scale;
      const { v0, apexT } = solveRise(rise, g, k);
      s.apexT = apexT;
      const vx = (Math.random() - 0.5) * 0.3;
      const vz = (Math.random() - 0.5) * 0.2;
      // index 0 是弹头（aDelay = -1，着色器里每帧都取当前时刻，永远在最前面）
      s.shellDelay[0] = -1;
      s.shellVel[0] = vx; s.shellVel[1] = v0; s.shellVel[2] = vz;
      s.shellSize[0] = 2.8 * scale;
      s.shellSeed[0] = 0.5;
      s.shellLife[0] = 1;
      // 其余是火星：点火时刻均匀铺满整段升空
      const sparkDt = apexT / (SHELL_SPARKS - 1);
      for (let i = 1; i < SHELL_SPARKS; i++) {
        s.shellDelay[i] = i * sparkDt;
        s.shellVel[i * 3] = vx + (Math.random() - 0.5) * 0.9;
        s.shellVel[i * 3 + 1] = v0 - 0.5 - Math.random() * 1.4;
        s.shellVel[i * 3 + 2] = vz + (Math.random() - 0.5) * 0.9;
        s.shellSize[i] = (0.30 + Math.random() * 0.34) * scale;
        s.shellSeed[i] = Math.random();
        s.shellLife[i] = 0.34 + Math.random() * 0.22;
      }
      for (const name of ['aVel', 'aDelay', 'aSize', 'aSeed', 'aLife']) {
        s.shellGeo.getAttribute(name).needsUpdate = true;
      }
      s.shellMat.uniforms.uT.value = 0;
      s.shell.visible = true;
      s.burst.position.set(0, rise, 0);
    } else {
      s.shell.visible = false;
      s.burst.position.set(0, 0, 0);
    }

    /* ---------------------------------------------------------- 能量环 */
    const card = opts.card;
    if (card && !calm) {
      s.hasHalo = true;
      s.halo.visible = true;
      s.halo.scale.set(card.w * HALO_PAD, card.h * HALO_PAD, 1);
      (s.haloMat.uniforms.uColor.value as THREE.Color).copy(color);
      s.haloMat.uniforms.uT.value = 0;
    } else {
      s.hasHalo = false;
      s.halo.visible = false;
    }

    /* ---------------------------------------------------------- 火花 */
    let n = 0;
    const count = Math.round((calm ? 90 : MAIN_COUNT) * base);
    const fan = BURST_ECHOES + 1;
    const bias = shape === 'willow' ? -0.5 : 0;
    const warm = shape === 'willow' ? 0.05 : 0;
    /**
     * 写出一颗火星（连同它的两颗拖影）。
     * `fibTotal` 是这一簇的粒子总数，决定 Fibonacci 球面按多少个点采样。
     */
    const emit = (i: number, fibTotal: number, speedJ: number, lifeJ: number, start: number,
                  ox: number, oy: number, oz: number, alt: boolean) => {
      if (fromFrame) {
        // 沿卡框往外喷。外法线给方向，加一点向前（+z）的速度做纵深——
        // 全在卡平面里的话再密也只是一张贴纸。
        perimeterPoint((i + Math.random() * 0.6) / fibTotal, fw, fh, _v, _n);
        ox = _v.x; oy = _v.y; oz = _v.z;
        const push = speed * speedJ * (0.55 + Math.random() * 0.9);
        _n.multiplyScalar(push);
        _n.x += (Math.random() - 0.5) * push * 0.55;
        _n.y += (Math.random() - 0.5) * push * 0.55;
        _n.z += 0.5 + Math.random() * 2.2;   // 朝观众飞，给立体
      } else if (shape === 'ring' && start === 0) {
        const a = (i / Math.max(1, count)) * Math.PI * 2;
        // 环面朝观众倾一点，不然正对镜头就是一个静止的圆盘贴片
        const tilt = 0.45;
        _v.set(Math.cos(a), Math.sin(a) * Math.cos(tilt), Math.sin(a) * Math.sin(tilt));
      } else {
        sphereDirection(i, fibTotal, _v);
        _v.y += bias;
        _v.normalize();
      }
      const jitter = 0.7 + Math.random() * 0.55;   // 速度离散才有层次
      const vx = _v.x * speed * speedJ * jitter + (fromFrame ? _n.x : 0);
      const vy = _v.y * speed * speedJ * jitter + (fromFrame ? _n.y : 0);
      const vz = _v.z * speed * speedJ * jitter + (fromFrame ? _n.z : 0);
      // 菊是双色交替（社区里 chrysanthemum 的固定配方）；aura 则是金 + 稀有度色
      // 混着来——全是一个色就读不出「能量」，两种颜色互相打才亮。
      const pick = fromFrame ? (i % 5 === 0 ? 0.0 : 1.0) : (alt ? 0.5 : 0.0);
      const hh = (hsl.h + pick * (fromFrame ? 0.0 : 0.5) + (Math.random() - 0.5) * 0.07 + 1) % 1;
      if (fromFrame && pick === 0.0) _c2.setHSL(0.11, 0.85, 0.68);   // 金
      else _c2.setHSL(hh, Math.min(1, hsl.s * 1.05 + 0.14),
                      Math.min(0.94, hsl.l + warm + 0.16));
      const size = (fromFrame ? 0.30 + Math.random() * 0.46 : 0.45 + Math.random() * 0.7) * scale;
      const seed = Math.random();
      const life = phy.life * lifeJ;
      // 本体 + 两颗更早时刻的拖影。三颗共用同一份 aVel / aOrigin / aLife，
      // 只差 aStart 和 aEcho —— 于是「一颗火星带一条尾巴」不用多一次 draw call。
      for (let e = 0; e < fan && n + e < BURST_MAX; e++) {
        const j = (n + e) * 3;
        s.burstVel[j] = vx; s.burstVel[j + 1] = vy; s.burstVel[j + 2] = vz;
        s.burstColor[j] = _c2.r; s.burstColor[j + 1] = _c2.g; s.burstColor[j + 2] = _c2.b;
        s.burstOrigin[j] = ox; s.burstOrigin[j + 1] = oy; s.burstOrigin[j + 2] = oz;
        s.burstSize[n + e] = size;
        s.burstSeed[n + e] = seed;
        s.burstLifeArr[n + e] = life;
        // aStart 越大 = 取越早的时刻 = 落在越靠后的位置。着色器那边
        // `t = uT - aStart` 于是天然把拖影排在本体后面。
        s.burstStart[n + e] = start + e * ECHO_DT;
        s.burstEcho[n + e] = e;
      }
      n = Math.min(BURST_MAX, n + fan);
    };

    for (let i = 0; i < count && n + fan <= BURST_MAX; i++) {
      emit(i, count, 1, fromFrame ? 0.85 + Math.random() * 0.5 : 0.6 + Math.random() * 0.65,
           0, 0, 0, 0, shape === 'chrysanthemum' && i % 2 === 0);
    }

    // 二次爆炸：主爆外圈再串一小圈小爆。没有这一步球心是空的，
    // 看着像一层壳而不是一朵花（社区里 peony/chrysanthemum 都这么做）。
    const subs = calm || fromFrame ? 0 : phy.subs;
    const subDelay = 0.26;
    const subLife = phy.life * 0.55;
    for (let j = 0; j < subs && n + SUB_EACH * fan <= BURST_MAX; j++) {
      const a = (j / subs) * Math.PI * 2 + Math.random() * 0.4;
      const dist = speed * 0.22;
      const ox = Math.cos(a) * dist, oy = Math.sin(a) * dist * 0.72, oz = Math.sin(a) * dist;
      const start = subDelay + Math.random() * 0.09;
      for (let i = 0; i < SUB_EACH; i++) {
        emit(i, SUB_EACH, 0.34, (subLife / phy.life) * (0.85 + Math.random() * 0.3),
             start, ox, oy, oz, false);
      }
    }

    for (const name of ['aVel', 'aColor', 'aOrigin', 'aSize', 'aSeed', 'aLife', 'aStart', 'aEcho']) {
      s.burstGeo.getAttribute(name).needsUpdate = true;
    }
    if (subs) s.burstSpan = subDelay + 0.09 + phy.life * 1.3;
    s.burst.visible = true;
    s.burstMat.uniforms.uT.value = 0;

    /* ---------------------------------------------------------- 符文碎片 */
    const chips = calm || !fromFrame ? 0 : Math.round(CHIP_MAX * 0.8);
    s.chips.visible = chips > 0;
    if (chips > 0) {
      for (let i = 0; i < chips; i++) {
        const o = i * 3;
        // 碎片也从卡框上起飞，但落点比火星远、飞得更慢。
        perimeterPoint((i + Math.random() * 0.4) / chips, fw * 1.02, fh * 1.02, _v, _n);
        s.chipOrigin[o] = _v.x; s.chipOrigin[o + 1] = _v.y; s.chipOrigin[o + 2] = _v.z;
        const push = speed * (0.7 + Math.random() * 0.9);
        s.chipVel[o] = _n.x * push + (Math.random() - 0.5) * push * 0.7;
        s.chipVel[o + 1] = _n.y * push + (Math.random() - 0.5) * push * 0.7 + 0.6;
        s.chipVel[o + 2] = _n.z * push + 1.1 + Math.random() * 2.6;
        if (i % 3 === 0) _c2.setHSL(0.11, 0.95, 0.60);
        else _c2.setHSL(hsl.h, Math.min(1, hsl.s + 0.25), Math.min(0.76, hsl.l + 0.06));
        s.chipColor[o] = _c2.r; s.chipColor[o + 1] = _c2.g; s.chipColor[o + 2] = _c2.b;
        s.chipSize[i] = (0.55 + Math.random() * 0.85) * scale;
        s.chipSeed[i] = Math.random();
        s.chipLife[i] = phy.life * (1.0 + Math.random() * 0.55);
        s.chipStart[i] = Math.random() * 0.22;
      }
      for (const name of ['aVel', 'aColor', 'aOrigin', 'aSize', 'aSeed', 'aLife', 'aStart']) {
        s.chipGeo.getAttribute(name).needsUpdate = true;
      }
      s.chipMat.uniforms.uDrag.value = 1.5;
      s.chipMat.uniforms.uG.value = 2.0;
      s.chipMat.uniforms.uT.value = 0;
    }
  }

  private free(): Show | null {
    return this.shows.find((s) => s.phase === 'done') ?? this.shows[0]!;
  }

  update(dt: number): void {
    for (const s of this.shows) {
      if (s.phase === 'done') continue;
      s.t += dt;
      if (s.phase === 'rise') {
        s.shellMat.uniforms.uT.value = s.t;
        if (s.t >= s.apexT) {
          s.phase = 'burst';
          s.t = 0;
          s.burstMat.uniforms.uT.value = 0;
          s.chipMat.uniforms.uT.value = 0;
          s.chips.visible = true;
          // 弹头已经变成一朵花了，再留一个亮点会像多挂了一颗
          s.shell.visible = false;
        }
        continue;
      }
      s.burstMat.uniforms.uT.value = s.t;
      if (s.chips.visible) s.chipMat.uniforms.uT.value = s.t;
      // 能量环：从卡沿出发往外推 0.42s，同时白热一下再收。
      if (s.hasHalo) {
        const u = s.t / 0.42;
        const cardEdge = 1 / HALO_PAD;         // 卡沿在方片归一坐标里的位置
        s.haloMat.uniforms.uEdge.value = cardEdge + Math.min(1, u) * 0.44;
        s.haloMat.uniforms.uW.value = 0.035 + Math.min(1, u) * 0.13;
        s.haloMat.uniforms.uA.value = Math.max(0, (1 - u) * (1 - u * 0.35)) * 1.35;
        s.haloMat.uniforms.uFlash.value = Math.exp(-s.t * 9);
        s.haloMat.uniforms.uT.value = s.t;
        if (s.t > 0.9) s.hasHalo = false, (s.halo.visible = false);
      }
      if (s.t > s.burstSpan) {
        s.phase = 'done';
        s.root.visible = false;
        s.shell.visible = false;
        s.burst.visible = false;
        s.chips.visible = false;
        s.halo.visible = false;
      }
    }
  }

  /** 切屏时把上一场收干净，别让旧特效飘到新卡上。 */
  clear(): void {
    for (const s of this.shows) {
      s.phase = 'done';
      s.hasHalo = false;
      s.root.visible = false;
      s.shell.visible = false;
      s.burst.visible = false;
      s.chips.visible = false;
      s.halo.visible = false;
    }
  }

  get liveCount(): number {
    return this.shows.filter((s) => s.phase !== 'done').length;
  }

  dispose(): void {
    for (const o of this.owned) o.dispose();
    this.group.clear();
  }
}