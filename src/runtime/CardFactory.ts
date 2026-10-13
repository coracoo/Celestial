import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CARD_BACK_ALLY, CARD_BACK_ENEMY } from '../data/cardBacks.ts';
import { type CharacterDef, type HoloMode } from '../data/schema.ts';
import { bindOpponentView, createOpponentMaterial } from './OpponentMaterial.ts';
import { FIGURE_LAYER, figureUrl } from '../core/figureLayer.ts';

export const CARD_H = 3.6;
export const CARD_ASPECT = 2 / 3;
export const CARD_W = CARD_H * CARD_ASPECT;

export interface CardVisual {
  group: THREE.Group;
  readonly holoMode: HoloMode;
  setTilt(nx: number, ny: number): void;
  setFlip(t: number): void;
  setReveal(t: number): void;
  setGlow(v: number): void;
  setShimmer(v: number): void;
  setBase(pose: { x: number; y: number; z: number; scale?: number; rotY?: number }): void;
  update(dt: number, time: number): void;
  dispose(): void;
}

/** Official RuiC GLSL, rebuilt from its Blender material graph.
 * glTF carries the real beveled mesh and material roles, not the shader graph.
 * Text/frame has fixed UVs; subject and background have signed view parallax.
 *
 * 图层顺序，自下而上，分成**两片** mesh：
 *
 *   卡面（web_front，local z = 0）只画「卡本身」：
 *     background(景深背景) → frame(原生花饰边框) → 烫金 → effects → 箔面 → 全息压边
 *
 *   最前面那张 quad（local z = max.z + 0.02）画「卡之上」的一切：
 *     角色(subject-bleed) → 线稿高光 → 文字(text)
 *
 * 为什么必须分两片、而且角色那一片必须在最前：
 * 卡体不止一片 mesh，除了主平面还有两个浮在它前面 0.025 的装饰圈
 * （内圈_古金细边、外圈_全息压边）。外圈拿的是**同一份** frontFragment，
 * 于是角色只要还画在卡面上，外圈就会把连人带烫金边的那份再画一遍顶到最前——
 * 表现就是人脸上横着一道白亮杠。角色挪到独立的最前 quad 之后，卡上
 * 没有任何东西能压到人物脸上，文字又压在角色之上。
 *
 * 代价是角色在卡内卡外由同一段代码、同一套落位换算产出，卡缘上不再有接缝。
 *
 * 镭射箔面**不是图层**：它是 frontFragment / bleedFragment 里的 uFoil / uFinish
 * uniform，必须随视角实时变化。做成纹理反而是错的——纹理是死的，转不动。
 * 角色那份颜色自己再跑一遍同样的箔面项，否则等于给角色单独去掉全息质感。
 *
 * 角色画在一张比卡面大的画布上，卡面矩形之外的部分自然就探出了卡框，
 * 袖口、手、兵器尖是继续延伸的，而不是齐刷刷切在边上。
 */
const vertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = vec2(uv.x, 1.0 - uv.y);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const common = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uTime, uFoil, uScale, uDepth, uBgDepth, uFinish, uHasLine, uRelief, uSafeScale, uFxDepth, uHasFx;
uniform vec2 uFit, uSafeOffset;
uniform vec3 uView;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float inside(vec2 p) { return step(0.,p.x)*step(0.,p.y)*step(p.x,1.)*step(p.y,1.); }
vec2 parallax(vec2 uv, float depth) {
  return uv + uView.xy / max(abs(uView.z), .35) * depth * .14;
}
vec2 viewShift(float depth) { return uView.xy / max(abs(uView.z), .35) * depth * .14; }
vec3 spectrum(float phase) {
  return .66 + .25 * cos(6.28318 * (phase + vec3(0., .33, .67)));
}
// Only "original" (uFinish ~ 2) disables the foil; pearl/silver/gold all use it.
float strength() { return abs(uFinish - 2.0) < 0.05 ? 0. : uFoil; }
vec3 film(vec2 uv) {
  float phase = uv.x * .85 + uv.y * .55 + uView.x * 1.5 - uView.y * .9;
  if (uFinish > 2.5) {
    // 烫金 (gold foil): warm gold laminate that shifts with the viewing angle.
    float hi = 0.5 + 0.5 * sin(phase * 6.28318);
    float glint = 0.5 + 0.5 * cos((phase + 0.25) * 6.28318);
    vec3 deep = vec3(.72, .50, .20);
    vec3 bright = vec3(1.00, .90, .60);
    return mix(deep, bright, hi * .7 + glint * .3);
  }
  vec3 color = spectrum(phase);
  return mix(color, vec3(dot(color,vec3(.2126,.7152,.0722))), step(.5,uFinish));
}
float sweep(vec2 uv) {
  return pow(.5+.5*sin((uv.x*.72+uv.y*.45+uView.x*1.2+uView.y*.6)*6.283),10.);
}
`;

const frontFragment = common + /* glsl */ `
uniform sampler2D tBackground, tEffects, tFrame;
uniform float uDof, uFrameDepth;

/* 景深背景：越靠卡缘越虚、越褪色、越暗，整层压到最下面当衬底。
   径向取样而不是全屏高斯，是因为卡面只有 5 个纵向色阶的位置，
   5 抽头足够糊掉漆面的高光又不会把美术本身磨平。 */
vec3 backdrop(vec2 uv) {
  float r = length((uv - .5) * vec2(.58, 1.));
  float k = smoothstep(.10, .95, r) * uDof;
  vec3 acc = vec3(0.);
  float wsum = 0.;
  for (int i = 0; i < 5; i++) {
    float t = (float(i) - 2.) * .5;
    float w = 1. - abs(t) * .55;
    acc += texture2D(tBackground, clamp(uv - t * k * vec2(.010, .017), 0., 1.)).rgb * w;
    wsum += w;
  }
  vec3 col = acc / wsum;
  col = mix(col, vec3(dot(col, vec3(.299, .587, .114))), k * .40);
  return col * (1. - k * .22);
}

void main() {
  vec2 uv = vUv;
  vec3 col = backdrop(parallax(uv, uBgDepth));
  /* 边框：压在景深背景上面。不透明度不在这层再乘一遍：70% 已经由
     scripts/card_layout.py 的 FRAME_OPACITY 烘进 frame.png 的 alpha，
     这里再乘就是同一个数字两处定义。 */
  vec2 fu = uv + viewShift(uFrameDepth);
  vec4 frame = texture2D(tFrame, clamp(fu, 0., 1.));
  col = mix(col, frame.rgb, frame.a * inside(fu));
  /* 提前取箔面强度：下面几处都要用它（烫金基色 / 箔面高光），而 strength()
     只依赖 uFinish/uFoil、不读 col，挪上来不影响任何结果。 */
  float amount = strength();
  /* 烫金基色。以前这一行是无条件乘的，等于给每张 gold 卡蒙一层永久的黄纱——
     摆正了看卡也洗不掉，而同一批里 auto 卡是干净的，看起来就像两套颜色。
     现在乘 amount，和箔面同一个开关：正对时 amount->0，卡面回到贴图本来的颜色；
     斜看才泛起暖金。goldBoost 只放大高光，不抬底色。 */
  float goldTint = uFinish > 2.5 ? amount : 0.;
  col = col * (1. - goldTint * .07) + goldTint * vec3(.030, .014, .0);
  vec2 eu = parallax(uv,uFxDepth);
  vec4 fx = texture2D(tEffects,clamp(eu,0.,1.));
  col = mix(col,fx.rgb,fx.a*(1.-uRelief)*uHasFx);
  vec3 foil = film(uv);
  float luminance = dot(col,vec3(.2126,.7152,.0722));
  float band = sweep(uv);
  // Laminate changes with the card-local viewing direction; black print stays readable.
  float goldBoost = uFinish > 2.5 ? 1.7 : 1.0;
  col *= 1. - amount * .21 * (1.-foil) * (.2 + band*.8);
  col += foil * amount * band * goldBoost * (.065 + .11*(1.-luminance));
  float edge = 1.-smoothstep(.015,.06,min(min(uv.x,1.-uv.x),min(uv.y,1.-uv.y)));
  col = mix(col,foil*.75+.21,edge*amount*(uFinish > 2.5 ? .42 : .3));
  vec2 cell = floor(uv*vec2(480.,720.));
  float flake = step(.994,hash(cell))*pow(.5+.5*sin(hash(cell+8.)*30.+uView.x*20.+uTime*.6),10.);
  col += foil*flake*amount*.13;

  /* 角色、线稿、文字都**不在**这里画——它们全在最前面那张 quad 上（bleedFragment）。
     卡面只负责「卡本身」：景深背景、花饰边框、烫金、箔面、全息压边。
     以前角色是画在这里的，于是卡体那两个装饰圈（内圈古金细边 / 外圈全息压边，
     都浮在卡面前面 0.025）会盖在人物上：外圈拿到的是同一份 frontFragment，
     把整张卡面连人带烫金边又画了一遍，于是人脸上横着一道白亮杠。 */
  gl_FragColor = vec4(pow(clamp(col,0.,1.),vec3(2.2)),1.);
  #include <colorspace_fragment>
}
`;

/** 最外层：角色、线稿高光、文字。
 *
 * 这一片挂在**卡面前面 0.02**，卡体、烫金内圈、全息压边外圈全在它后面。
 * 角色和文字都画在这里，所以卡上再没有任何东西能压到人物脸上。
 *
 * 关键约束是**落位必须是同一个连续场**。卡内卡外共用一条换算链，
 * 只改 vUv 的取法（卡面片给整卡 uv，这张给放大的出血画布 uv），
 * 角色才不会在卡缘上横向错开一道缝。
 *
 * 自下而上的次序就是「突破次元壁」的全部定义：
 *   角色 → 线稿高光 → 文字（最外面，名字压在人身上也看得见）
 */
const bleedFragment = common + /* glsl */ `
uniform sampler2D tBleed, tText, tLine;
uniform vec2 uCardOffset, uCardScale;
uniform float uShadow, uReveal;

vec2 toCard(vec2 uv)  { return (uv - uCardOffset) / uCardScale; }
vec2 toBleed(vec2 c)  { return c * uCardScale + uCardOffset; }
/* 注意 inside() 必须判**整张出血画布**的 [0,1]，不能判卡面空间。
   卡外那一圈的卡面 uv 本来就落在 [0,1] 之外——判错地方等于把要突破的部分
   全部 discard，出血层会静悄悄地什么都不画。 */
float bleedAlpha(vec2 s) {
  vec2 t = toBleed(s);
  return texture2D(tBleed, clamp(t, 0., 1.)).a * inside(t);
}

void main() {
  /* c 是卡面 uv：卡内落在 [0,1]，卡外落到外面——这正是「同一张画布、两种取法」
     要的那条边界。文字用它判 inCard，角色直接拿去当落位输入。 */
  vec2 c = toCard(vUv);
  float inCard = inside(c);

  /* 落位。和卡面那条路径逐项对齐，只把 uv 的来源从「整卡」换成「这张 quad」。
     视差用 uDepth，不再单开一份 uBleedDepth：applyConfig 只从 card-config.json
     更新 uDepth，两份深度迟早会漂。 */
  vec2 s = (c - .5) * uScale / uFit + .5;
  s += viewShift(uDepth);
  /* 安全区必须和卡面那条路径走同一套换算，否则角色在卡缘横向撕开一道缝。 */
  s = s * uSafeScale + uSafeOffset;
  vec2 t = toBleed(s);

  /* 箔面各项：贴图切到角色这份颜色上，参数和卡面那份一模一样。
     抽到最后层就蹭不到卡面的箔面了，不自己跑一遍等于给角色单独去掉全息质感。 */
  float amount = strength();
  vec3 foil = film(c);
  float band = sweep(c);
  float goldBoost = uFinish > 2.5 ? 1.7 : 1.0;
  vec2 cell = floor(c * vec2(480., 720.));
  float flake = step(.994, hash(cell)) * pow(.5+.5*sin(hash(cell+8.)*30.+uView.x*20.+uTime*.6), 10.);

  /* 角色 */
  vec4 subject = texture2D(tBleed, clamp(t, 0., 1.));
  float sa = subject.a * uReveal * (1. - uRelief);
  float goldTint = uFinish > 2.5 ? amount : 0.;
  vec3 sc = subject.rgb * (1. - goldTint * .07) + goldTint * vec3(.030, .014, 0.);
  float sl = dot(sc, vec3(.2126,.7152,.0722));
  sc *= 1. - amount * .21 * (1.-foil) * (.2 + band*.8);
  sc += foil * amount * band * goldBoost * (.065 + .11*(1.-sl));
  sc += foil*flake*amount*.13;
  /* 线稿高光跟着角色走，所以也在这片上；inside(s) 把它留在卡面范围内。 */
  float line = (1. - smoothstep(.06, .25, texture2D(tLine, clamp(t, 0., 1.)).r)) * uHasLine;
  sc += line * inside(s) * sa * band * amount * .055;

  /* 出了卡面背后就没有衬底了，补一层柔光暗影把角色从场景里托出来。
     三抽头错开采样当作廉价模糊，够软即可。卡内不叠——背后本来就是卡面。 */
  float shade = (bleedAlpha(s + vec2(-.004, .012))
               + bleedAlpha(s + vec2( .004, .012))
               + bleedAlpha(s + vec2( 0.,   .016))) / 3.;
  shade *= uShadow * uReveal * (1. - uRelief) * (1. - inCard);
  float ra = sa + shade * (1. - sa);
  vec3 rc = sc * sa / max(ra, .0001);

  /* 文字：**最外面**。名字压在人物之上、技能名压在裙摆之上，「突破次元壁」才成立。
     它是卡面尺寸的贴图，所以用 inCard 裁在卡面矩形内。 */
  vec4 text = texture2D(tText, clamp(c, 0., 1.));
  float ta = text.a * inCard * (1. - uRelief);
  vec3 tc = text.rgb;
  tc *= 1. - amount * .21 * (1.-foil) * (.2 + band*.8);
  tc += foil * amount * band * goldBoost * (.065 + .11*(1.-dot(tc,vec3(.2126,.7152,.0722))));

  /* 非预乘 over：角色（含卡外暗影）在下，文字在上。 */
  float na = ta + ra * (1. - ta);
  if (na < .003) discard;
  vec3 col = (tc * ta + rc * ra * (1. - ta)) / max(na, .0001);
  gl_FragColor = vec4(pow(clamp(col, 0., 1.), vec3(2.2)), na);
  #include <colorspace_fragment>
}
`;

const edgeFragment = common + /* glsl */ `
void main() {
  vec3 col = mix(vec3(.66,.69,.67),film(vUv)*.6+.35,strength()*.7);
  gl_FragColor=vec4(pow(col,vec3(2.2)),1.);
  #include <colorspace_fragment>
}
`;

const backFragment = common + /* glsl */ `
uniform sampler2D tBack;
void main() {
  // GLB 的 web_back 网格 UV 已经是「绕 Y 翻过去看」的那一侧，直接采样得到
  // 的是水平镜像的图。程序化 canvas 时代看不出来（画的是对称的「娘」字）；
  // 换成实拍的虎头 + 右上的月亮之后一眼就是反的，所以这里必须翻回来。
  vec2 uv = vec2(1.-vUv.x, vUv.y);
  vec4 art = texture2D(tBack, uv);
  // Unprinted silver stock shows through wherever the plate has no alpha yet,
  // which is also the state before the back artwork finishes loading.
  vec3 col = mix(vec3(.956,.961,.946),art.rgb,art.a);
  // The laminate rides ON TOP of the printed plate. Compositing it underneath,
  // as a translucent print would allow, makes it vanish once art.a reaches 1.
  float amount = strength();
  float luminance = dot(col,vec3(.2126,.7152,.0722));
  float band = sweep(uv);
  vec3 foil = film(uv);
  col *= 1. - amount * .21 * (1.-foil) * (.2 + band*.8);
  col += foil * amount * band * (.065 + .11*(1.-luminance));
  float edge = 1.-smoothstep(.015,.06,min(min(uv.x,1.-uv.x),min(uv.y,1.-uv.y)));
  col = mix(col,foil*.75+.21,edge*amount*.3);
  gl_FragColor=vec4(pow(clamp(col,0.,1.),vec3(2.2)),1.);
  #include <colorspace_fragment>
}
`;

export interface CardConfig {
  parameters?: { foil?: number; subjectScale?: number; subjectDepth?: number; backgroundDepth?: number;
                 effectsDepth?: number; frameDepth?: number; backgroundDof?: number; bleedShadow?: number };
  safeArea?: { scale?: number; offset?: [number, number] };
  subjectLayout?: { bleed?: [number, number]; canvas?: [number, number] };
}

const textureLoader = new THREE.TextureLoader();
const textures = new Map<string, Promise<THREE.Texture>>();
const configs = new Map<string, Promise<CardConfig>>();
let model: Promise<THREE.Group> | undefined;
const MODEL_URL = '/art/layers/card.glb';
function loadTexture(url: string): Promise<THREE.Texture> {
  let pending = textures.get(url);
  if (!pending) {
    pending = textureLoader.loadAsync(url).then((texture) => {
      // Official shader handles sRGB conversion explicitly.
      texture.colorSpace = THREE.NoColorSpace;
      texture.anisotropy = 4;
      return texture;
    });
    textures.set(url, pending);
  }
  return pending;
}
function loadConfig(id: string): Promise<CardConfig> {
  let pending = configs.get(id);
  if (!pending) {
    pending = fetch(`/art/layers/${id}/card-config.json`).then((response) => {
      if (!response.ok) throw new Error(`Card configuration ${id}: HTTP ${response.status}`);
      return response.json() as Promise<CardConfig>;
    });
    configs.set(id, pending);
  }
  return pending;
}
/** Shared mesh cache. Await this before building a card with geometry. */
export function loadCardModel(): Promise<THREE.Group> {
  model ??= new GLTFLoader().loadAsync(MODEL_URL).then((gltf) => gltf.scene);
  return model;
}
function solidTexture(r: number, g: number, b: number, a: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array([r,g,b,a]),1,1);
  texture.needsUpdate = true;
  return texture;
}

/** Layer names, in stack order. Only the figure layer carries the character:
 *  the card-face mesh and the quad behind it both sample that one texture,
 *  the former through toBleed(). frame and the figure are optional at
 *  runtime: a card prepared before the split still renders, just without the
 *  ornament underneath or the figure breaking out.
 *
 *  角色层的名字取自 `core/figureLayer`：剧情立绘、技能头像、技能演出用的是同一张图，
 *  文件名必须只有一处定义（76e873f 那次改名就是因为这里改了、另外三处没改，
 *  三处静默失败到剧情页只剩名牌）。 */
const LAYERS = ['background', 'frame', 'lineart', 'text', FIGURE_LAYER] as const;
export type CardLayerName = typeof LAYERS[number] | 'back';
export type FigureLayerName = typeof FIGURE_LAYER;

export interface CardLayers {
  background?: THREE.Texture | null;
  frame?: THREE.Texture | null;
  lineart?: THREE.Texture | null;
  text?: THREE.Texture | null;
  [FIGURE_LAYER]?: THREE.Texture | null;
  back?: THREE.Texture | null;
}

export interface CardBuildOptions {
  id?: string;
  holo?: HoloMode;
  foil?: number;
  subjectScale?: number;
  subjectDepth?: number;
  backgroundDepth?: number;
  frameDepth?: number;
  backgroundDof?: number;
  bleedShadow?: number;
  effectsDepth?: number;
  safeScale?: number;
  safeOffset?: [number, number];
  /** 出血画布尺寸与其四周出血量，发布自 scripts/card_layout.py */
  bleedCanvas?: [number, number];
  bleedMargin?: [number, number];
}

interface CardCore {
  visual: CardVisual;
  uniforms: Record<string, { value: unknown }>;
  setLayer(name: CardLayerName, texture: THREE.Texture | null): void;
  setFoil(value: number): void;
  /** True once `dispose()` ran; the async loader must not attach into a dead card. */
  readonly disposed: boolean;
  /** Adds the exported mesh plus the bleed quad. Async in game, awaited in the studio. */
  attach(template: THREE.Group): void;
  /**
   * 敌方大图用的入口：**不带 GLB、不带出血 quad**，
   * 换成一个贴着 CARD_H×CARD_W 的正面 + 一张卡背。
   * 运动、翻面、倾斜缓动、发光、闪卡全部还是 core 自己那一份 `visual`——
   * 敌方不另写一套动画，之前另写过，结果鼠标方向反了、还不发光。
   */
  attachFlat(face: THREE.Mesh, back: THREE.Mesh, foil: { value: number }): void;
}

/**
 * Group, uniforms and materials are built synchronously; only the mesh is
 * deferred. That split is what lets the cutout studio hand over live
 * CanvasTextures and have a brush stroke land on the *real* card immediately,
 * while the game still gets an empty card to pose while its PNGs stream in.
 */
function createCardCore(id: string, holo: HoloMode, options: CardBuildOptions = {}): CardCore {
  const group = new THREE.Group();
  group.name = `RuiC card${id ? ` · ${id}` : ''}`;
  group.userData.card = { id, ready: false, model: MODEL_URL, error: null };
  const empty = solidTexture(0,0,0,0);
  const white = solidTexture(255,255,255,255);
  const uniforms = {
    tBackground: { value: white as THREE.Texture },
    tText: { value: empty as THREE.Texture }, tLine: { value: white as THREE.Texture },
    tEffects: { value: empty as THREE.Texture }, tBack: { value: empty as THREE.Texture },
    tFrame: { value: empty as THREE.Texture },
    uTime: { value: 0 }, uView: { value: new THREE.Vector3(0,0,1) },
    uFit: { value: new THREE.Vector2(1,1) }, uFoil: { value: 0 },
    // 卡面矩形在出血画布里的位置。两条着色器路径共用这一份（出血那套靠对象展开继承），
    // 各自持有一份的话，两边迟早会被改成不一样的值，而画面只会在卡缘裂开。
    uCardOffset: { value: new THREE.Vector2(.1, .1) },
    uCardScale: { value: new THREE.Vector2(.8, .8) },
    uScale: { value: options.subjectScale ?? 1 }, uDepth: { value: options.subjectDepth ?? .4 },
    uBgDepth: { value: options.backgroundDepth ?? -.25 },
    uSafeScale: { value: options.safeScale ?? 1 }, uSafeOffset: { value: new THREE.Vector2() },
    uFxDepth: { value: options.effectsDepth ?? .5 }, uHasFx: { value: 0 }, uHasLine: { value: 1 },
    uFinish: { value: holo === 'none' ? 2 : holo === 'gold' ? 3 : 0 },
    uRelief: { value: 0 },
    uDof: { value: options.backgroundDof ?? 0 }, uFrameDepth: { value: options.frameDepth ?? 0 },
  };
  const safeOffset = options.safeOffset ?? [0, 0];
  uniforms.uSafeOffset.value.set(safeOffset[0], 1 - uniforms.uSafeScale.value - safeOffset[1]);

  const shader = (fragmentShader: string) => new THREE.ShaderMaterial({
    uniforms, vertexShader: vertex, fragmentShader, side: THREE.FrontSide, toneMapped: false,
  });
  const materials: Record<string, THREE.Material> = {
    web_front: shader(frontFragment), web_edge: shader(edgeFragment), web_back: shader(backFragment),
    web_gold: new THREE.MeshBasicMaterial({ color: '#c9a24a', toneMapped: false }),
  };

  // The bleed quad shares every view-dependent uniform with the card face so the
  // two cannot drift; only its own sampler and its canvas mapping are its own.
  // uCardOffset/uCardScale 是**继承**来的同一个对象，不是拷贝——两条路径必须指着
  // 同一份卡面/出血换算，否则角色在卡缘会横向错开。角色的视差深度也直接用
  // uDepth，不再单开 uBleedDepth：applyConfig 只从 card-config.json 更新 uDepth，
  // 两份深度迟早会漂，而漂了只会在卡缘横向错开一道缝。
  const bleedUniforms = {
    ...uniforms,
    tBleed: { value: empty as THREE.Texture },
    uShadow: { value: options.bleedShadow ?? .35 }, uReveal: { value: 1 },
  };
  const bleedMaterial = new THREE.ShaderMaterial({
    uniforms: bleedUniforms, vertexShader: vertex, fragmentShader: bleedFragment,
    side: THREE.FrontSide, toneMapped: false, transparent: true, depthWrite: false,
  });
  // Card rect inside the oversized subject canvas. Published by
  // scripts/card_layout.py; the fallback keeps pre-split assets renderable.
  const [bw, bh] = options.bleedMargin ?? [128, 192];
  const [cw, ch] = options.bleedCanvas ?? [1280, 1920];
  uniforms.uCardOffset.value.set(bw / cw, bh / ch);
  uniforms.uCardScale.value.set(1024 / cw, 1536 / ch);

  // 敌方走 attachFlat 时带进来的网格和贴图归这里管，别让它们在 dispose 里漏掉。
  const ownedGeometries = new Set<THREE.BufferGeometry>();
  const ownedMaterials = new Set<THREE.Material>();
  const ownedTextures = new Set<THREE.Texture>();

  const inverse = new THREE.Matrix4();
  let bleedQuad: THREE.PlaneGeometry | undefined;
  let disposed = false, targetX = 0, targetY = 0, tiltX = 0, tiltY = 0;
  let reveal = 1, flip = 0, glow = 0, shimmer = 0;
  let foil = options.foil ?? .62;
  let baseY = 0, baseScale = 1, baseRotY = 0;
  let extraFoil: { value: number } | null = null;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const bindView = (object: THREE.Object3D): void => {
    // Export's mesh local frame has X=90 degrees. Derive view in the card's
    // canonical root frame, so local Y remains vertical after glTF Y-up export.
    object.onBeforeRender = (_renderer, _scene, camera) => {
      camera.getWorldPosition(uniforms.uView.value);
      uniforms.uView.value.applyMatrix4(inverse.copy(group.matrixWorld).invert()).normalize();
    };
  };
  // 角色不走这张表：它只被最前面那张 quad 采一次（tBleed）。
  // tText / tLine 虽然列在这儿，但它们的 uniform 对象被 bleedUniforms 展开继承了，
  // 所以同一处赋值，文字和线稿也一并到了那张 quad 上。
  const SAMPLE: Record<Exclude<CardLayerName, FigureLayerName>, { value: THREE.Texture }> = {
    background: uniforms.tBackground, frame: uniforms.tFrame,
    lineart: uniforms.tLine, text: uniforms.tText, back: uniforms.tBack,
  };
  group.userData.card.uniforms = uniforms;

  const visual: CardVisual = {
    group, holoMode: holo,
    setTilt(nx,ny) { targetX = THREE.MathUtils.clamp(nx,-1,1); targetY = THREE.MathUtils.clamp(ny,-1,1); },
    setFlip(t) { flip = THREE.MathUtils.clamp(t,0,1); },
    setReveal(t) { reveal = THREE.MathUtils.clamp(t,0,1); },
    setGlow(v) { glow = THREE.MathUtils.clamp(v,0,1); },
    setShimmer(v) { shimmer = THREE.MathUtils.clamp(v,0,1); },
    setBase(pose) {
      group.position.set(pose.x,pose.y,pose.z);
      baseY = pose.y; baseScale = pose.scale ?? 1; baseRotY = pose.rotY ?? 0;
      group.scale.setScalar(baseScale); group.rotation.y = baseRotY;
    },
    update(dt,time) {
      const ease = reduced.matches ? 1 : 1-Math.exp(-dt*9);
      tiltX += (targetX-tiltX)*ease; tiltY += (targetY-tiltY)*ease;
      const e = 1-Math.pow(1-reveal,3);
      group.rotation.x = tiltY*.29 + (1-e)*.35;
      group.rotation.y = baseRotY+tiltX*.45+(1-e)*-Math.PI*.85+flip*Math.PI;
      group.position.y = baseY+(1-e)*-1.4;
      group.scale.setScalar(baseScale*(.55+e*.45+glow*.035));
      // Spectrum/sweep phase comes only from uView. Time is used exclusively
      // for sparse microflakes, respecting the reduced-motion preference.
      uniforms.uTime.value = reduced.matches ? 0 : time;
      const foilValue = holo === 'none' ? 0 : foil*(.85+.15*shimmer+.12*glow)*e;
      uniforms.uFoil.value = foilValue;
      // 敌方卡的材质不是这套着色器，但闪卡强度必须是**同一个公式**——
      // 两边各算一遍的话，改了一边另一边就悄悄不一样了。
      if (extraFoil) extraFoil.value = foilValue;
      bleedUniforms.uReveal.value = e;
    },
    dispose() {
      disposed = true;
      for (const material of Object.values(materials)) material.dispose();
      bleedMaterial.dispose();
      // Only the quad is ours; the exported GLB clone shares BufferGeometry with
      // the module-level model cache, so disposing those would break every other card.
      bleedQuad?.dispose();
      for (const g of ownedGeometries) g.dispose();
      for (const m of ownedMaterials) m.dispose();
      for (const t of ownedTextures) t.dispose();
      ownedGeometries.clear();
      ownedMaterials.clear();
      ownedTextures.clear();
      empty.dispose(); white.dispose(); group.clear();
      // Model geometry, loaded layer textures and the back plate are immutable shared caches.
    },
  };

  return {
    visual,
    uniforms,
    setFoil(value) { foil = value; },
    setLayer(name, texture) {
      if (name === FIGURE_LAYER) {
        // 角色只有这一张纹理，只有最前面那张 quad 在采它。卡面不再画角色——
        // 它要是也画一份，卡体那两个装饰圈就会把压在人物上的那份顶到最前。
        bleedUniforms.tBleed.value = texture ?? empty;
        return;
      }
      SAMPLE[name].value = texture ?? (name === 'background' || name === 'lineart' ? white : empty);
    },
    attachFlat(face, back, foil) {
      extraFoil = foil;
      ownedGeometries.add(face.geometry);
      ownedMaterials.add(face.material as THREE.Material);
      ownedGeometries.add(back.geometry);
      ownedMaterials.add(back.material as THREE.Material);
      group.add(face, back);
    },
    attach(template) {
      const geometry = (template as THREE.Group).clone(true);
      let faces = 0;
      geometry.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const from = object.material as THREE.Material;
        if (from.name === 'web_front') faces++;
        object.material = materials[from.name] ?? materials.web_edge!;
        bindView(object);
      });
      if (!faces) throw new Error('Official GLB is missing web_front geometry');
      const bounds = new THREE.Box3().setFromObject(geometry);
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      const scale = CARD_H / size.y;
      geometry.scale.setScalar(scale);
      geometry.position.copy(center).multiplyScalar(-scale);
      group.add(geometry);
      /* Bleed quad, measured in the card's **local** space.
       *
       * `setFromObject(geometry)` looks like the obvious way to do this and is
       * wrong: by the time the assets resolve, `group` is already in the
       * showcase and mid-reveal, so `setFromObject` folds the card's world scale
       * AND its entry rotation into the numbers — and those get re-applied when
       * the quad is parented to the same group. Measure the template bounds and
       * apply the exact transform the card just got instead. */
      const local = new THREE.Matrix4().compose(
        center.clone().multiplyScalar(-scale), new THREE.Quaternion(),
        new THREE.Vector3(scale, scale, scale));
      const placed = bounds.clone().applyMatrix4(local);
      // The subject canvas carries a bleed margin on every side, so the quad is
      // that much bigger than the card it sits behind.
      bleedQuad = new THREE.PlaneGeometry(
        (placed.max.x - placed.min.x) / bleedUniforms.uCardScale.value.x,
        (placed.max.y - placed.min.y) / bleedUniforms.uCardScale.value.y);
      /* 把 quad 的 uv 翻过来，让它和 web_front 用同一套约定。
       *
       * web_front 是 Blender 导出的，uv.y = 0 在【顶】；PlaneGeometry 是
       * uv.y = 0 在【底】——两者正好相反。顶点着色器统一做 vUv = 1-uv.y，
       * 所以不改这张 quad 的话，出血层会相对卡面整个上下颠倒（剑尖跑到
       * 卡面上方），而且 toCard() 的卡面空间映射也跟着错位。
       * 翻过来之后两边约定一致，quad 顶部的 vUv.y 也是 1。 */
      const bleedUv = bleedQuad.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < bleedUv.count; i++) bleedUv.setY(i, 1 - bleedUv.getY(i));
      bleedUv.needsUpdate = true;
      const quadMesh = new THREE.Mesh(bleedQuad, bleedMaterial);
      /* z 必须在卡面**前面**，而且要比那两个装饰圈（内圈 0.026 / 外圈 0.025）都前。
       *
       * 放卡背时这片只显示卡外那一圈，是靠不透明的 web_front 把它挡住——
       * 代价是人物被卡体夹住，「人从卡里探出来」看着就成了「卡把人夹住」。
       * 放前面之后角色、线稿、文字全在这一片上（卡面不再画它们），
       * 卡内卡外同源，卡缘上没有接缝，也没有任何一片能盖到人物脸上。 */
      quadMesh.position.set((placed.min.x + placed.max.x) / 2, (placed.min.y + placed.max.y) / 2,
                            placed.max.z + 0.02);
      quadMesh.renderOrder = -1;
      quadMesh.name = 'RuiC bleed';
      bindView(quadMesh);
      group.add(quadMesh);
      // Card footprint in the card's own local space. Exposed so the acceptance
      // probe can check the bleed against it without re-deriving the transform.
      group.userData.card.localBox = placed;
      group.userData.card.bleed = quadMesh;
      group.userData.card.ready = true;
    },
    get disposed() { return disposed; },
  };
}

/**
 * A complete card from textures you already hold. The game loads PNGs by URL;
 * the cutout studio hands over live CanvasTextures so a brush stroke shows on
 * the real card in the same frame. Same shaders, same mesh, same uniforms —
 * the studio preview is the renderer, not an imitation of it.
 */
export function createCardFromTextures(layers: CardLayers, options: CardBuildOptions = {},
                                       template?: THREE.Group): CardVisual {
  const core = createCardCore(options.id ?? '', options.holo ?? 'auto', options);
  for (const [name, texture] of Object.entries(layers) as [CardLayerName, THREE.Texture | null | undefined][]) {
    core.setLayer(name, texture ?? null);
  }
  if (template) core.attach(template);
  return core.visual;
}

export function createCard(def: CharacterDef): CardVisual {
  const core = createCardCore(def.id, def.card.holo);
  // The back plate is decoration, not card data: it settles on its own so a
  // missing or slow asset degrades to unprinted silver stock instead of
  // taking the whole card down with the Promise.all below.
  const back = loadTexture(CARD_BACK_ALLY).catch((error: unknown) => {
    console.warn(`Card back plate ${CARD_BACK_ALLY} unavailable, using silver stock`, error);
    return null;
  });
  Promise.all([
    loadCardModel(), loadConfig(def.id), back,
    ...LAYERS.map((name) => loadTexture(`/art/layers/${def.id}/${name}.png`)
      .catch((error: unknown) => {
        console.warn(`Card layer ${def.id}/${name} unavailable`, error);
        return null;
      })),
  ]).then(([template, config, backPlate, background, frame, lineart, text, bleed]) => {
    if (core.disposed) return;                   // showcase dropped the card mid-load
    const cfg = config as CardConfig;
    // Config lands after the core exists, so the depth/foil values are pushed in here.
    applyConfig(core, cfg);
    core.setLayer('background', background);
    core.setLayer('frame', frame);
    core.setLayer('lineart', lineart);
    core.setLayer('text', text);
    // 角色只有这一张。它同时喂给卡面 mesh 和出血 quad。
    core.setLayer(FIGURE_LAYER, bleed);
    core.setLayer('back', backPlate);
    core.attach(template);
  }).catch((error: unknown) => {
    core.visual.group.userData.card.error = String(error);
    console.error(`RuiC card ${def.id} failed to load`, error);
  });
  return core.visual;
}

/**
 * 敌方大图。**尺寸就是 CARD_H × CARD_W**，和我方武将卡同一个盒子，
 * 所以展示台不用为它开第二套取景/灯位/底座。
 *
 * 贴图走敌方本来的分层素材（subject / background / frame），
 * 材质是战斗里已经在用的 `createOpponentMaterial`，不是另写一份着色器。
 * 敌方卡没有稀有度牌面，`holoMode` 固定 'none'——闪卡只在展台里给武将用。
 */
export function createOpponentCard(def: { id: string; name: string; layers: { subject: string; background: string; frame: string } },
                                   accentHex: number): CardVisual {
  /*
   * 和武将卡**同一个 createCardCore**，所以倾斜方向、缓动曲线、翻面、
   * 登场、发光、闪卡全部是同一份实现——这里只决定「网格长什么样、
   * 贴图从哪来」。之前给敌方另写过一整套动画，结果鼠标方向是反的、
   * setGlow 是空的、切卡没有粒子，玩家在同一个展台上感受到两套手感。
   */
  const core = createCardCore(def.id, 'auto');
  const { visual } = core;
  visual.group.name = def.name;

  const blank = new THREE.Texture();
  blank.colorSpace = THREE.NoColorSpace;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H),
    createOpponentMaterial({ subject: blank, background: blank, frame: blank }));
  face.position.z = 0.02;
  bindOpponentView(face);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H),
    new THREE.MeshBasicMaterial({ map: blank, toneMapped: false }));
  back.position.z = -0.02;
  back.rotation.y = Math.PI;
  // 卡背常驻可见即可：group 翻 180 度时它自然转到镜头前，
  // 没翻的时候它在卡面背后又背着观众，本来就看不见。翻面逻辑归 core 管。
  core.attachFlat(face, back, face.material.uniforms.uFoil as unknown as { value: number });

  const uniforms = face.material.uniforms;
  (uniforms.uTint as { value: THREE.Color }).value.setHex(accentHex);
  const bind = (uniform: string, url: string): void => {
    loadTexture(url).then((texture) => {
      if (core.disposed) return;
      (uniforms[uniform] as { value: THREE.Texture | null }).value = texture;
    }).catch(() => { /* 缺层就空着，底下是卡槽内衬，不会黑屏 */ });
  };
  bind('tSubject', def.layers.subject);
  bind('tBackground', def.layers.background);
  bind('tFrame', def.layers.frame);
  loadTexture(CARD_BACK_ENEMY).then((texture) => {
    if (core.disposed) return;
    (back.material as THREE.MeshBasicMaterial).map = texture;
  }).catch(() => { /* 卡背取不到就一直是素面，不影响看正面 */ });

  return visual;
}

/** Config values that are uniforms rather than textures, applied once the card
 *  config resolves. Split out so the studio can pass them up front instead. */
function applyConfig(core: CardCore, cfg: CardConfig): void {
  const p = cfg.parameters || {};
  const safe = cfg.safeArea;
  const u = core.uniforms;
  const set = (name: string, value: unknown): void => {
    if (value !== undefined && u[name]) u[name].value = value;
  };
  set('uScale', p.subjectScale);
  set('uDepth', p.subjectDepth);
  set('uBgDepth', p.backgroundDepth);
  set('uDof', p.backgroundDof);
  set('uFrameDepth', p.frameDepth);
  set('uFxDepth', p.effectsDepth);
  set('uSafeScale', safe?.scale);
  if (p.foil !== undefined) core.setFoil(p.foil);
  if (safe) {
    const offset = safe.offset ?? [0, 0];
    const scale = safe.scale ?? 1;
    set('uSafeScale', scale);
    (u.uSafeOffset.value as THREE.Vector2).set(offset[0], 1 - scale - offset[1]);
  }
}

export function cardDescriptor(def: CharacterDef): Record<string,unknown> {
  return {
    id: def.id, number: def.number, name: def.name, rarity: def.rarity, holo: def.card.holo,
    model: MODEL_URL, source: 'RuiC-card-skill / Blender exported geometry',
    config: `/art/layers/${def.id}/card-config.json`,
    layers: [
      // 卡面：只有「卡本身」。角色/线稿/文字不在这一片上——它们在最前面那张 quad。
      { name: 'background', mesh: 'web_front', depth: -.25, dof: true, url: `/art/layers/${def.id}/background.png` },
      { name: 'frame', mesh: 'web_front', depth: 0, opacity: 1, url: `/art/layers/${def.id}/frame.png` },
      // 最前面那张 quad：角色 → 线稿高光 → 文字（文字压在角色之上）
      { name: FIGURE_LAYER, mesh: 'front-quad', depth: .4, url: `/${figureUrl(def.id)}` },
      { name: 'lineart', mesh: 'front-quad', depth: .4, url: `/art/layers/${def.id}/lineart.png` },
      { name: 'text', mesh: 'front-quad', depth: 0, url: `/art/layers/${def.id}/text.png` },
      { name: 'foil', source: 'official RuiC view-dependent GLSL' },
    ],
  };
}
