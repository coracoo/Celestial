import * as THREE from 'three';
import { clamp } from '../core/constants.ts';
import type { Engine } from '../core/Engine.ts';
import type { CharacterDef } from '../data/schema.ts';
import { createCard, createOpponentCard, CARD_H, CARD_W, type CardVisual } from './CardFactory.ts';
import { Fx } from './Fx.ts';
import { Fireworks, type FireworkShape } from './Fireworks.ts';

/** 取景时要框进安全区的内容：卡牌 + 铭板 + 底座灯环 + 一点点留白 */
const FRAME_W = CARD_W * 1.15;
// 1.40 而不是 1.28：底座在 y=-2.5、CARD_H/2 只有 1.8，按 1.28 框（±2.3）
// 会把底座和灯环切在画外，卡牌看着像悬在空里，没有落座感。
const FRAME_H = CARD_H * 1.4;

/**
 * 卡牌整体上浮的高度。
 *
 * **数字是量出来的，不是估的。** `.acceptance/_lift.mts` 在真机上扫一遍
 * baseY，量「出血下沿」和「底座近侧顶沿」的屏幕间距（画布 1478×902，底座顶沿
 * 在 screenY=726.6）：
 *
 *     baseY=0.62 → 脚底在底座上方 101.9 px   ← 太飘，读起来像悬在半空
 *     baseY=0.34 → 61.4 px
 *     baseY=0.16 → 35.3 px
 *     baseY=0    → 12.2 px
 *
 * 注意最后一行：**baseY=0 时脚底本来就已经在底座上方了**。所以这个值解决的
 * 不是「脚被底座切掉」——那个问题从来不存在；它控制的是「卡与灯盘之间留多少
 * 空隙」，留太多就成了飘着的贴图。要调就动这一个数，0.16 → 0.30 之间都成立。
 */
const CARD_LIFT = 0.20;

/** 名册一排最多摆几张。取景按整排宽度算，超过这个数每张就缩成邮票。 */
const ROSTER_ROW_MAX = 5;

export type SafeRect = { x: number; y: number; w: number; h: number };

/**
 * 卡槽内衬：卡牌背后那块被灯照亮的面板。
 * 之前卡牌直接悬在纯黑里，只能靠底座撑着，构图上永远像「一张飘着的贴图」；
 * 真机台上角色是嵌在一块被灯带照亮的役物面板里的。
 */
function nicheTexture(): THREE.Texture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(S / 2, S / 2, 8, S / 2, S / 2, S * 0.52);
  grad.addColorStop(0, 'rgba(255,208,152,0.34)');
  grad.addColorStop(0.42, 'rgba(198,98,60,0.15)');
  grad.addColorStop(1, 'rgba(18,9,16,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  /* 这里原来还画了两道金色描边框和四个角点（机台饰框）。删了：
     卡牌本来就有一圈实打实的金边，背景板上再套一个同色的框，
     两个框一前一后夹着卡，看着像卡被装进了相框——而且角色探出卡缘之后，
     那个框反而比角色更抢眼。只留这一片柔光当衬底。 */
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * 抽卡 / 图鉴的 3D 展示台。复用同一台 Engine 与画布，
 * 战斗时切回盘面取景，非战斗时切到展示台。
 */
export class Showcase {
  readonly group = new THREE.Group();
  private readonly cards: CardVisual[] = [];
  private readonly fx = new Fx();
  /** 切卡时的粒子烟花。池里有三发，快速连点也能一发接一发。 */
  private readonly fireworks = new Fireworks();
  /** 连着切卡时轮换花型，全是同一种球形看两遍就腻了。 */
  private fireworkTurn = 0;
  private readonly engine: Engine;
  private safeRect: SafeRect | null = null;
  private revealed = -1;
  private revealT = 0;
  private active = false;
  private spin = 0;
  private readonly platform: THREE.Mesh;
  private readonly niche: THREE.Mesh;
  private readonly nicheMat: THREE.MeshStandardMaterial;
  private readonly owned: { dispose(): void }[] = [];
  /** 动态光源：三盏点光 + 一盏环境光，都挂在自己的 group 下，group 隐藏时连灯一起跳过 */
  private readonly keyLight: THREE.PointLight;
  private readonly faceLight: THREE.PointLight;
  private readonly rimLight: THREE.PointLight;
  private readonly ambient: THREE.AmbientLight;
  /** 平滑后的指针位置，既驱动卡牌倾斜也驱动主光位置 */
  private tiltX = 0;
  private tiltY = 0;
  private hover = 0;
  private hoverTarget = 0;
  private flipped = false;
  /** 当前卡投影到屏幕后的矩形，指针映射与悬停判定都按它算 */
  private cardRect: { left: number; right: number; top: number; bottom: number; cx: number; cy: number; halfW: number; halfH: number } | null = null;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();

  constructor(engine: Engine) {
    this.engine = engine;

    // 卡槽内衬（卡牌背后，z 更靠后）。
    // 原来是 MeshBasicMaterial —— 完全不吃光，动态光源打上去一点反应都没有，
    // 背景板永远是同一块死掉的暖色。改成 Standard 并保留自发光兜底：
    // 亮处会随光源走，暗处仍靠 emissiveMap 撑着底。
    const nicheTex = nicheTexture();
    this.owned.push(nicheTex);
    this.nicheMat = new THREE.MeshStandardMaterial({
      // color 压暗：背景板只该被灯"扫"出一点变化，不能让 diffuse 抢戏。
      // 直接给纯白的话，点光源一照会整块泛白，卡牌背后的板比卡还亮。
      color: 0x241610,
      map: nicheTex,
      emissive: new THREE.Color(0xffc890),
      emissiveMap: nicheTex,
      emissiveIntensity: 0.5,
      roughness: 0.78,
      metalness: 0,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.owned.push(this.nicheMat);
    const niche = new THREE.Mesh(new THREE.PlaneGeometry(FRAME_W, FRAME_H), this.nicheMat);
    niche.position.z = -0.9;
    this.group.add(niche);
    this.niche = niche;

    // 底座收小并压哑光。原来的圆盘直径 6.8，比卡牌还宽，整块比卡更抢眼；
    // 而且它是一块**朝上的大平面**——按盘面那条规律，低粗糙度 + 有金属度会被
    // 环境顶光整片反射，糊成一只比卡还亮的紫浴缸。这里给足粗糙度、压掉环境强度，
    // 让底座只负责接住卡牌下缘，不参与视觉竞争。
    // 半径收到 1.5：卡放大之后 1.75 的底座在取景里会压到右下的控制条。
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x171019,
      roughness: 0.92,
      metalness: 0.08,
      envMapIntensity: 0.35,
    });
    this.owned.push(baseMat);
    this.platform = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.78, 0.26, 64), baseMat);
    this.platform.position.y = -2.12;
    this.platform.receiveShadow = true;
    this.group.add(this.platform);

    // 底座铬边：与盘面的镀铬件同一套材质语言，但压暗一档——
    // 细亮环才是铬件，圆环本体再高光就会比整张卡还抢眼。
    // 粗糙度给到 0.38：镜面铬环正对着动态主光时，0.3 会把高光收成一个烧白的硬边。
    const chrome = new THREE.MeshStandardMaterial({
      // 偏暖的灰：原来 0xb9c4d6 偏冷，在暖红机台里会读成一道发蓝的白灯管，
      // 抢走整张卡的注意力
      color: 0xa39c96,
      roughness: 0.4,
      metalness: 1,
      envMapIntensity: 0.45,
    });
    this.owned.push(chrome);
    const edge = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.04, 10, 72), chrome);
    edge.rotation.x = -Math.PI / 2;
    edge.position.y = -1.99;
    this.group.add(edge);

    // 底座下的暖色灯环：托住卡牌下缘，别让它看起来是悬空的
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(1.5, 1.95, 72),
      new THREE.MeshBasicMaterial({
        color: 0xffb877,
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -1.99;
    this.group.add(halo);

    // 均匀底子。点光源衰减是平方级的，名册横排三张卡跨度 5.8：
    // 单靠点光，亮的那张和暗的那张能差一倍以上，最外侧那张直接糊成黑块。
    // 所以铺底交给环境光（对全组等权），点光只负责立体感和那条移动高光。
    this.ambient = new THREE.AmbientLight(0xffdcb4, 0);
    this.group.add(this.ambient);

    // ---- 动态光线源 ----
    // 机台顶灯是给盘面调的：它从 (-7, 30, 22) 打下来，落到卡牌上就是一片擦角光，
    // 卡面本身又是 emissive 驱动的（立绘是平涂赛璐璐，不能交给 PBR 塑形），
    // 结果就是整张卡从头到尾没有一处在「动」。这里自己开一套灯：
    //   主光  跟着鼠标在卡前移动，负责卡框 / 铬边 / 底座上那条会滑的高光
    //   面光  正面柔光，给卡面一点立体感
    //   轮廓光 背侧，染角色 accent 色——每张卡有自己的光色
    this.keyLight = new THREE.PointLight(0xfff2d8, 0, 16, 2);
    this.keyLight.position.set(0, 1.15, 2.5);
    this.group.add(this.keyLight);

    this.faceLight = new THREE.PointLight(0xffe9cc, 0, 22, 2);
    this.faceLight.position.set(0, 0.1, 3.4);
    this.group.add(this.faceLight);

    // 轮廓光放正后方而不是偏一侧：偏过去会顺带把最左那张挑出来当主角，
    // 居中才是给整排卡统一勾一条背光边。
    this.rimLight = new THREE.PointLight(0xffb877, 0, 12, 2);
    this.rimLight.position.set(0, 1.7, -1.6);
    this.group.add(this.rimLight);
    this.group.add(this.fx.group);
    this.group.add(this.fireworks.group);
    // 粒子的点尺寸是按画布高度换算的，构造时先把当前尺寸吃进去；
    // 改窗口大小后要重算，否则烟花在高分屏上会小一圈
    this.fireworks.setViewportHeight(engine.renderer.domElement.height);
    window.addEventListener('resize', this.onResize);
    this.group.visible = false;
    engine.scene.add(this.group);
  }

  private readonly onResize = (): void => {
    this.fireworks.setViewportHeight(this.engine.renderer.domElement.height);
  };

  /** 摆卡：清旧 → 横排 → 复位演出。武将卡和敌方大图共用这一条。 */
  private place(built: CardVisual[]): void {
    for (const c of this.cards) {
      c.dispose();
      this.group.remove(c.group);
    }
    this.cards.length = 0;
    built.forEach((card, i) => {
      // 必须走 setBase 而不是直接写 group.position.y：卡自己的 update() 每帧都会
      // 把 position.y 重写成 baseY，直接赋值第一帧就被抹掉，卡根本没上浮。
      card.setBase({ x: (i - (built.length - 1) / 2) * 2.9, y: CARD_LIFT, z: 0 });
      // 展台上还有 fx / card-reveal-fx 两个特效组也是 Group，光靠类型分不出卡。
      card.group.userData.showcaseCard = true;
      this.group.add(card.group);
      this.cards.push(card);
    });
    this.revealed = -1;
    this.revealT = 0;
    this.flipped = false;
  }

  setCards(defs: CharacterDef[]): void {
    this.place(defs.map((def) => createCard(def)));
  }

  /**
   * 敌方大图：**一张**，尺寸和武将卡一模一样，所以灯位、底座、取景全都不用改。
   * 之前这里是 showRoster() 摆一排，把「看大图」变成了「看一排小图」。
   */
  showOpponent(def: { id: string; name: string; layers: { subject: string; background: string; frame: string } },
                accentHex: number): void {
    this.active = true;
    this.group.visible = true;
    this.place([createOpponentCard(def, accentHex)]);
    this.applyFraming();
    this.revealed = 0;
    this.revealT = 0;
    // 轮廓光和切卡粒子是和 \show()\ 同一段，不是敌方专属的一套演出
    this.rimLight.color.setHex(accentHex);
    this.celebrate(accentHex);
  }

  show(def: CharacterDef, rarityHex: number): void {
    this.active = true;
    this.group.visible = true;
    // 顺序要紧：先换卡再取景。反过来的话 applyFraming 读到的是上一屏的卡数
    // （从名册切过来时是 3 张），跨度按 3 张算，单张卡会被缩成一半大。
    this.setCards([def]);
    this.applyFraming();
    this.revealed = 0;
    this.revealT = 0;
    // 轮廓光染成这张卡自己的色，灯和卡是同一套身份
    this.rimLight.color.setHex(rarityHex);
    this.celebrate(rarityHex);
  }

  /**
   * 切卡时的登场演出。
   *
   * 以前这里是 fx.burst() + fx.ring()：一坨大光斑糊在镜头上，像镜头脏了，
   * 而且和「换了一张卡」没有关系。再后来是两段式烟花——可那是在卡**旁边**
   * 的空处放一朵花，和卡本身没关系，读起来仍然是「旁边有个东西在炸」。
   *
   * 现在是炉石那种抽卡观感：能量**沿卡面四边**涌出来，符文碎片自转着飞开，
   * 一圈过曝的亮边顺着卡框往外扩张一次。粒子贴着卡长，才有「这张卡正在
   * 被点亮」的意思——扔在空处的一万个点也还是「几个粗糙的粒子」。
   *
   * **只有 aura**：切卡就是切卡。之前这里轮换 ['aura','aura','chrysanthemum','willow']
   * 想避免连点看着重复，可那等于每两次切卡就有一次在卡旁边的空处放一朵升空烟花——
   * 和下面这段注释自己写的「只有 aura 才是切卡的正确形态」直接矛盾，读起来就退回成
   * 「旁边有个东西在炸」。另外三种留给手动放烟花（验收探针走的就是那条路径）。
   */
  private celebrate(rarityHex: number): void {
    this.fire(rarityHex, 'aura');
    // 底座灯环跟着闪一下，让台面接住这一下
    this.fx.ring(0, -1.99, rarityHex, 0.4, 6.2, 0.7);
  }

  /**
   * 手动放一发烟花。验收探针靠它走真实路径，而不是自己复刻一份发射参数——
   * 参数抄一遍的话，探针验的就是它自己那份数字，不是游戏真的在用的那份。
   *
   * - **aura**（切卡用）：卡心 (0, CARD_LIFT, 0.28)。粒子框取卡面尺寸再外扩
   *   6%/3%，所以第一帧粒子正好长在**卡框上**而不是卡心；z 往前推是为了让
   *   粒子有纵深——全在卡平面里的话再密也只是一张贴纸。
   * - 其余花型：发射 y = CARD_LIFT - 2.4（刚在底座顶面 -1.99 之上），x = ±1.85
   *   在卡面半宽（1.2）之外。走卡侧是因为整条升空轨迹都得在暗背景上才看得见
   *   ——从卡心正上方升的话亮点正好飞过角色的白裙身，白点落在白底上等于没放。
   *   z = 1.0 在卡面前方，不被卡面挡住。
   */
  fire(rarityHex: number, shape: FireworkShape = 'aura'): void {
    const side = this.fireworkTurn % 2 ? 1 : -1;
    if (shape === 'aura') {
      this.fireworks.launch({
        x: 0, y: CARD_LIFT, z: 0.28, color: rarityHex, shape, scale: 1,
        frame: { w: CARD_W * 1.06, h: CARD_H * 1.03 },
        card: { w: CARD_W, h: CARD_H },
      });
      return;
    }
    this.fireworks.launch({
      x: side * 1.85, y: CARD_LIFT - 2.4, z: 1.0,
      color: rarityHex, rise: 3.3, shape, scale: 1,
    });
  }

  /**
   * 鼠标是否落在 3D 卡舞台上。落在上面就把闪卡拉满并点亮动态主光——
   * 《炉石传说》的传奇卡就是这样：手指擦过去箔纸才亮。
   */
  setHover(on: boolean): void {
    this.hoverTarget = on ? 1 : 0;
  }

  /**
   * 由 UI 层告知当前没有被面板遮挡的区域；取景据此把卡牌摆到可见空隙正中。
   * 传 null 表示整屏都可用（标题页 / 战斗）。
   */
  setSafeRect(rect: SafeRect | null): void {
    this.safeRect = rect;
    if (this.active) this.applyFraming();
  }

  /**
   * 名册模式：一次摆开多张已获得的武将。
   * 抽卡页在「还没抽到东西」的时候右侧原本是空的，两千多像素的纯色底，
   * 视觉上比做得难看更糟；把已有武将摆出来既填了画面也顺带回答了「我现在有什么」。
   *
   * 但**必须限量**：取景是按整排宽度算的，三张时每张还有巴掌大，
   * 十二张排开就是 34 个单位宽塞进半屏——每张缩成邮票，一排贴纸比空屏更难看。
   * 所以这里只摆最高稀有度的前几张，其余交给左侧列表点开看。
   */
  showRoster(defs: CharacterDef[]): void {
    if (defs.length === 0) {
      this.hide();
      return;
    }
    const ORDER: Record<string, number> = { UR: 0, SSR: 1, SR: 2, R: 3 };
    const picked = defs
      .map((d, i) => ({ d, i }))
      .sort((a, b) => (ORDER[a.d.rarity] ?? 9) - (ORDER[b.d.rarity] ?? 9) || a.i - b.i)
      .slice(0, ROSTER_ROW_MAX)
      .map((x) => x.d);
    this.active = true;
    this.group.visible = true;
    this.setCards(picked);
    // 名册也要指一张「当前卡」：revealed 停在 -1 的话，倾斜、光、闪卡
    // 三个驱动全都挂不上，一排卡会像三张贴纸。
    this.revealed = 0;
    this.revealT = 1;
    this.rimLight.color.setHex(0xffb877);
    this.applyFraming();
  }

  private applyFraming(): void {
    const n = this.cards.length;
    // 多张横排时取景要跟着变宽，否则排到两侧的卡会被安全区裁掉
    const rowW = n > 1 ? (n - 1) * 2.9 + CARD_W : CARD_W;
    const span = n > 1 ? (n - 1) * 2.9 + CARD_W * 1.15 : FRAME_W;
    // 背景板要真的罩住整排卡。按张数拍一个魔数会在换屏时留下上一屏的宽度，
    // 这里直接由排布宽度换算。
    this.niche.scale.x = Math.max(1, (rowW * 1.1) / FRAME_W);
    const rect = this.safeRect ?? { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    this.engine.frameInRect(span, FRAME_H, rect);
  }

  hide(): void {
    this.active = false;
    this.group.visible = false;
    this.hover = 0;
    this.hoverTarget = 0;
    // 切走时收掉正在放的烟花，否则它会飘到战场上去
    this.fireworks.clear();
    this.engine.clearManualCamera();
  }

  get isActive(): boolean {
    return this.active;
  }

  flip(): void {
    const c = this.cards[this.revealed];
    if (!c) return;
    // 必须自己记状态。原来是拿 rotation.y 的正负当正反面判据，可待机姿态
    // setTilt(0.55, 0) 会把 rotation.y 一直顶在正值上，于是 flip() 永远
    // 判定成"正面"再翻回 0 —— 卡根本翻不过去。
    this.flipped = !this.flipped;
    c.setFlip(this.flipped ? 1 : 0);
  }

  /**
   * 屏幕指针 → 卡面内归一化坐标（-1..1），再驱动倾斜与闪卡。
   *
   * 关键：判定和映射都按**卡面本身**的屏幕矩形算，不是整屏。
   * 用整屏归一化的话，鼠标在离卡还有半米的地方就已经把卡推到底了，
   * 真正移到卡上时反而没有变化区间——手感上就是「飘、怎么动都没反应」。
   *
   * 出了卡面不是硬钉在卡缘，而是按距离平滑收回中心。硬夹在边界上看着像
   * 「卡歪了卡住了」：抽卡揭示屏的卡没人去碰它，鼠标却在左边面板上，
   * 整张卡就死死歪向一边。两段必须连续，所以衰减的起点正好在 out=0 处取 1。
   *
   * 悬停判定也收进这里：卡牌画在 canvas 里，没有 DOM 元素可命中。
   */
  setPointer(clientX: number, clientY: number): void {
    const r = this.cardRect;
    if (!r) return;
    const rawX = (clientX - r.cx) / r.halfW;
    const rawY = (clientY - r.cy) / r.halfH;
    // >0 表示指针已经出了卡面，单位是「几个半张卡宽/高」
    const out = Math.max(Math.abs(rawX), Math.abs(rawY)) - 1;
    const fade = out > 0 ? 1 / (1 + out * out * 1.2) : 1;
    this.applyTilt(clamp(rawX, -1, 1) * fade, clamp(rawY, -1, 1) * fade);
    this.hoverTarget =
      clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom ? 1 : 0;
  }

  /** 倾斜、动态光、闪卡光斑三者的唯一入口，分开写就会各走各的。 */
  private applyTilt(nx: number, ny: number): void {
    this.tiltX = nx;
    this.tiltY = ny;
    this.cards[this.revealed]?.setTilt(nx, ny);
  }

  /**
   * 把当前卡的 CARD_W × CARD_H 盒子投影成屏幕矩形。
   * 引擎每帧先 `updateCamera()` 再跑 `onFrame`，所以这里拿到的相机是本帧最新的。
   * 忽略卡的自身旋转取外接矩形——顺带给一点宽容，手感比严丝合缝好。
   */
  private updateCardRect(): void {
    const c = this.cards[this.revealed];
    if (!c) {
      this.cardRect = null;
      return;
    }
    const cam = this.engine.camera;
    // 渲染器是在 render() 里才刷新相机矩阵的，而这里跑在 onFrame 里——
    // 不手动刷一次就会用到上一帧的相机，投影出来的矩形差一帧。
    cam.updateMatrixWorld();
    c.group.getWorldPosition(this.tmp);
    const hw = CARD_W * 0.5 * 1.14;
    const hh = CARD_H * 0.5 * 1.08;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 4; i++) {
      const p = this.tmp2
        .set(i & 1 ? hw : -hw, i & 2 ? hh : -hh, 0)
        .add(this.tmp)
        .project(cam);
      const sx = (p.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-p.y * 0.5 + 0.5) * window.innerHeight;
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }
    this.cardRect = {
      left: minX,
      right: maxX,
      top: minY,
      bottom: maxY,
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      halfW: Math.max(1, (maxX - minX) / 2),
      halfH: Math.max(1, (maxY - minY) / 2),
    };
  }

  update(dt: number, time: number): void {
    if (!this.active) return;
    this.spin += dt;
    this.revealT = Math.min(1, this.revealT + dt * 1.25);
    this.hover += (this.hoverTarget - this.hover) * Math.min(1, dt * 5);
    this.updateCardRect();

    // 动态光源每帧跟着指针走。强度全部乘 revealT，登场没走完时灯是黑的，
    // 不会出现「卡还在侧面翻出来、灯已经打满」的穿帮。
    const e = this.revealT;
    this.keyLight.position.set(this.tiltX * 1.9, 1.15 + this.tiltY * 1.6, 2.5);
    this.keyLight.intensity = 11 * e * (0.7 + this.hover * 0.5);
    this.faceLight.intensity = 7 * e;
    this.rimLight.intensity = 8 * e;
    this.ambient.intensity = 0.9 * e;
    this.nicheMat.emissiveIntensity = 0.5 + this.hover * 0.22;

    for (let i = 0; i < this.cards.length; i++) {
      const card = this.cards[i]!;
      const focused = i === this.revealed;
      if (focused) {
        card.setReveal(this.revealT);
        card.setGlow(0.35 + Math.sin(time * 3) * 0.18);
        // 底噪按闪卡样式给：游走模式本来就该一直亮着，不用等鼠标；
        // 金闪要等鼠标来定位圆心；普通卡不给底噪。
        const idle = card.holoMode === 'auto' ? 0.5 : card.holoMode === 'gold' ? 0.1 : 0;
        card.setShimmer(idle + this.hover * (1 - idle));
      } else {
        // 名册里没被选中的卡也留一份底噪，不然整张卡糊成黑块，看不出画的是什么
        card.setReveal(1);
        card.setGlow(0.16);
        card.setShimmer(card.holoMode === 'auto' ? 0.35 : 0.06);
      }
      card.update(dt, time);
    }

    this.group.position.y = Math.sin(this.spin * 0.9) * 0.14;
    this.fx.update(dt);
    this.fireworks.update(dt);

    if (this.revealT >= 1) {
      const c = this.cards[this.revealed];
      // 待机 3/4 姿态：只在没人操作卡的时候接管，玩家一动就交还控制权。
      // 少了 hover 判据的话，玩家正把指针按在卡上，姿态还会突然被抢走。
      if (c && this.hover <= 0.02 && !c.group.userData.spun) {
        c.group.userData.spun = true;
        this.applyTilt(0.55, 0);
      }
    }
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    for (const c of this.cards) c.dispose();
    this.fx.dispose();
    this.fireworks.dispose();
    for (const o of this.owned) o.dispose();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.engine.scene.remove(this.group);
  }
}
