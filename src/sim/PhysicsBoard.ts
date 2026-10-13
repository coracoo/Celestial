import type { Collider, RigidBody } from '@dimforge/rapier2d-compat';
import { BOTTOM, FLIPPER, PHYSICS, PLUNGER, clamp, deg2rad } from '../core/constants.ts';
import type { ColliderTag, Physics } from '../core/Physics.ts';
import type { Wuxing, PegKind, SlotKind, ZoneKind, WallDef } from '../data/schema.ts';
import type { ExpandedStage, FlipperGeom } from './board.ts';
import type { BattleEvent, SimCommand } from './types.ts';
import { predictTrajectory, type TrajectoryResult } from './trajectory.ts';

export interface PegMeta {
  id: string;
  enemyId?: string;
  kind: PegKind;
  x: number;
  y: number;
  r: number;
  value: number;
  collider: Collider;
  /** 仍存在于盘面（未被摧毁） */
  alive: boolean;
  /** 当前是否被技能设为可穿过 */
  ghosted: boolean;
  meshIndex: number;
  /** 仅敌人钉：剩余血量 */
  hp: number;
  maxHp: number;
  /** 仅敌人钉：相生相克属性 */
  wuxing?: Wuxing;
}

export interface ZoneSensor {
  id: string;
  kind: ZoneKind;
  label: string;
  cx: number;
  cy: number;
  hx: number;
  hy: number;
  collider: Collider;
  inside: boolean;
  glow: number;
}

export interface SlotSensor {
  id: string;
  kind: SlotKind;
  label: string;
  value: number;
  cx: number;
  cy: number;
  hx: number;
  hy: number;
  collider: Collider;
  inside: boolean;
  flash: number;
  /** 中位（漂移 = 0）时的 x。每帧按 `slotDrift` 改写 `cx`，收尾兜底按 cx 找最近槽 */
  baseX: number;
}

interface Channel {
  scale: number;
  until: number;
}

interface GhostChannel {
  kinds: Set<PegKind>;
  until: number;
}

/**
 * 一块翻板的运行时状态。
 *
 * 进度用 0..1 而不是「当前角度」存，是为了让**回落**和**再按下**两件事
 * 都只是这个数的线性插值——玩家在板还没落回静止位时再次按下，板会从
 * 当前角度继续往上走而不是「跳一下」，真弹球就是这个手感。
 */
export interface FlipperState {
  geom: FlipperGeom;
  /** 0 = 静止，1 = 弹到位 */
  t: number;
  /** 上弹中为 1，其余为 0；用完即清零（弹到位就停在那儿） */
  dir: 0 | 1;
  /**
   * 本次摆动是否正处在**上弹**途中。
   *
   * 和 `dir` 分开是因为 `dir` 在「板已弹到位、玩家仍按着」时也是 0，
   * 而那一段板是不动的。击打判定必须只认真正在往上走的那几帧。
   */
  swinging: boolean;
  /**
   * 本次挥板是否已经还过倒计时。
   * 挥板那 0.07s 里会连续几帧都判到打中，每帧都还时间的话一次挥板能赚 2 秒多，
   * 比球还能活的时长还长——倒计时直接作废。
   */
  refundedThisSwing: boolean;
  /** 玩家是否正按着。板靠这个停在弹起位，松手才回落 */
  held: boolean;
  /** 最近一次触发击打的时刻，用于连点保护 */
  lastHitAt: number;
  body: RigidBody;
  collider: Collider;
  /** 当前角度（弧度），渲染层直接读它，不要自己再算一遍 */
  angle: number;
}

export interface PhysicsBoardHooks {
  /** 在改变球速之前核验战斗预算。 */
  canLaunch?: () => boolean;
  onEvent?: (ev: BattleEvent) => void;
  onPegVisuals?: () => void;
}

/**
 * 速度硬上限。
 *
 * 原来 62 是按「顶部抛物线发射，最大初速 33」定的——球出膛就减速，从来碰不到上限。
 * 弹射道是**竖直爬 30bu 的全程加速**，最弱一发也要 v≈48、最强一发 v≈76
 * （见 `plungerMaxPower`），62 这个上限会在道顶把满力的球直接掐掉，
 * 表现是「拉到底和拉一半进盘位置差不多」。必须抬到能容下最强一发。
 */
const BASE_MAX_SPEED = 96;

/**
 * 追打救球的角度与力度范围。
 *
 * 这是**独立的**一组数，不复用弹射道的：首发是竖直爬坡，不需要选方向；
 * 救球是在盘上改向，要瞄准。两者物理量纲差一个数量级（17~30 对 48~76），
 * 共用一组会让救球一出手就把球打飞。
 */
const SHOOT_MIN_ANGLE_DEG = 42;
const SHOOT_MAX_ANGLE_DEG = 138;
const SHOOT_MIN_POWER = 17;
const SHOOT_MAX_POWER = 30;

/** 点到线段的距离。翻板判击球用——比「球心到板中心」准，不会因为板短而漏判板尖。 */
function pointSegDist(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? clamp(((px - ax) * vx + (py - ay) * vy) / len2, 0, 1) : 0;
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

/**
 * 纯物理的柏青哥盘面。不依赖 Three.js，因此可以在 Node 里无头跑完整局。
 * 视觉层 BoardView 只读这里的状态，物理与表现单向解耦。
 */
export class PhysicsBoard {
  readonly stage: ExpandedStage;
  private readonly physics: Physics;
  private readonly hooks: PhysicsBoardHooks;

  readonly pegs: PegMeta[] = [];
  /** 实际创建的墙体/导流板/发射杯/落槽隔板；w/h 为碰撞体半尺寸。 */
  readonly walls: WallDef[] = [];
  private readonly pegById = new Map<string, PegMeta>();
  readonly zones: ZoneSensor[] = [];
  readonly slots: SlotSensor[] = [];
  /** 玩家能按的翻板（Z / X）。盘面数据只标了「这里有块板」，转动全在这里。 */
  readonly flippers: FlipperState[] = [];

  private body: RigidBody | null = null;
  /**
   * 球的碰撞体。改恢复系数必须走 collider 而不是 body——
   * 「撞得越久打越疼」是本作伤害公式的根，弹性是唯一能改反弹次数的旋钮，
   * 所以它得是一条真正的物理通道，不能用速度倍率糊弄过去。
   */
  private ballCollider: Collider | null = null;
  private ballState: 'idle' | 'live' | 'done' = 'idle';
  /**
   * 击射冷却剩余时间。玩家在球还在盘上时可以反复打它，这是整个游戏唯一的操作——
   * 没有它，一次发射之后玩家就只能看着球弹 5~9 秒，是纯观众。
   */
  private shotCooldown = 0;
  /**
   * 球速低于 `readySpeed` 已经多久。
   *
   * 这条时间线同时决定两件事：够不够久算「可以再射」，以及久到离谱之后
   * 强制落槽（玩家赖在盘上不动也是一种「没玩懂」）。两个阈值共用一个计时器，
   * 因为它们本来就是同一件事的两端。
   */
  private slowTime = 0;
  /**
   * 球「基本停住」的累计时长。判卡死强制落槽用，和上面的 slowTime 是两件事。
   * 合并成一个计时器的话，「打得��住」这条线一抬，正常滚动的球就会被误判卡死。
   */
  private stallTime = 0;
  /**
   * 球「基本不动」的累计时长（带缓释、不归零）。
   * 存在的唯一理由见 `step()` 里的注释：它替 `stallTime` 兜住
   * 「被 antiStuck 反复推、始终挪不出去」的那一类球。
   */
  private parkedTime = 0;
  /** 球是否处于「可以再打」的状态。盘面用它决定球环亮不亮。 */
  private ready = false;
  /** 金环亮时按下即可保留本次救球窗口，松手前球继续真实运动。 */
  private rescueReserved = false;
  /** 確変口传感器（常驻，位置靠搬移切换） */
  private feverCatcher!: Collider;
  private feverGateOn = false;
  private ballAge = 0;
  /**
   * 移动落槽：整排（传感器 + 隔板 + 端墙）作为一个刚体组左右平移。
   *
   * `body` 是运动学刚体，`baseX` 是它在中位（漂移 = 0）时的 x。每帧按
   * `slotDrift` 调 `setNextKinematicTranslation`，于是球撞端墙时拿到的是
   * 端墙的**表面速度**（Rapier 只对运动学体算），球会被端墙「推着走」
   * 而不是穿过去 —— 用固定碰撞体每帧 setTranslation 就没有这个效果。
   */
  private slotRig: { body: RigidBody; baseX: number }[] = [];
  /** 落槽整排当前的横向偏移（bu）。渲染层直接读它画槽口 */
  private slotDrift = 0;
  private slotClock = 0;
  /**
   * 位移幅度。从**实际槽距**反算，不写死盘宽：
   * `slotDriftRatio / slotSpanRatio × 槽距` ≈ 0.8 个槽距。
   * 这样改 `slotSpanRatio` 时幅度自动跟着走，不会出现「排比槽还宽」把槽顶进侧壁。
   */
  private slotAmplitude = 0;
  /** 本关单颗球的总预算（秒）。读 rules.ballSeconds，缺省回 PHYSICS.ballMaxAge。 */
  private readonly ballBudget: number;
  private stuckTime = 0;
  /**
   * 「这一次卡住」已经持续了多久。**不因为发了冲量而归零**。
   *
   * stuckTime 是给冲量用的短计时器：超过 0.3s 就推一把然后清零重数。
   * 如果虚化脱困也复用它，阈值必然定在 0.3s 之上，而那一帧冲量分支会先把
   * 计数清掉——于是 escapeTrap 一次都不会触发，是段死代码（实测确实 0 次）。
   * 所以「推一把」和「虚化」必须各用各的计时器：一个可重置，一个只增不减。
   */
  private stuckEpisode = 0;
  private bestY = Number.POSITIVE_INFINITY;
  private descentStall = 0;
  /**
   * 「无净下降」看门狗已经连续推了几次。
   *
   * 推满 `PHYSICS.descentPushLimit` 次仍不见下降就**停止加能量**，改走 `escapeTrap()`。
   * 不设这个上限的话，同一记横向冲量会每 0.8s 重复一次直到超时，
   * 而球在密集钉阵里被横向加速后只会弹得更高——看门狗成了共振泵。
   * 球一旦真的下降（下一次 bestY 刷新）就清零，所以正常球碰不到这条分支。
   */
  private descentPushes = 0;
  private readonly lastHitAt = new Map<string, { x: number; y: number }>();
  private readonly ghostChannels = new Map<string, GhostChannel>();
  /** 脱困机制临时虚化的钉板：pegId → 恢复时间，与技能通道叠加互不干扰 */
  private readonly escapeGhosts = new Map<string, number>();
  /** 脱困触发次数：盘面设计质量的健康指标，正常盘面应接近 0 */
  escapes = 0;
  private readonly speedChannels = new Map<string, Channel>();
  private readonly gravityChannels = new Map<string, Channel>();
  /** 弹性倍率：直接乘到球的恢复系数上 */
  private readonly bounceChannels = new Map<string, Channel>();
  /** 线性阻尼倍率 */
  private readonly dampingChannels = new Map<string, Channel>();
  /** 球速下限：多个通道取最大值 */
  private readonly floorChannels = new Map<string, { floor: number; until: number }>();
  /** 持续外力：每帧清零重加，避免积分器把残留力一直累积 */
  private readonly forceChannels = new Map<string, { ax: number; ay: number; until: number }>();
  private clock = 0;
  /*
   * Boss 相位的三维剥夺（见 constants 的 PHASE）。
   *
   * 存的是**整份当前档位**，不是三个布尔：相位切走时必须能一次全部收回，
   * 而「逐个旋钮设回去」漏掉一个就是永久生效的隐形惩罚。
   */
  private aimDriftMult = 1;
  private aimDriftSpeed = 1;
  private weakScale = 1;
  private ballScale = 1;
  private rescueClosed = false;
  private lateralG = 0;
  private lateralHz = 2.4;
  private cameraShake = 0;
  /**
   * 盘面阻尼的当前值（技能通道连乘后）。道内会被 `PLUNGER.laneDamping` 顶掉，
   * 出道后要恢复到这里——所以必须单独记一份，不能每次重算。
   */
  private baseDamping: number = PHYSICS.ballLinearDamping;

  /**
   * 球还在球道里、等着到交汇处出射。
   *
   * 首发分成两段物理：道底竖直上行（真爬升，看得见球被顶上去），
   * 到 `stage.plunger.bendY` 才换成出射弹道。这个开关就是第二段的闸门。
   * 救球 `shoot()` 不走这段，直接给速度。
   */
  private launchPending = false;
  /** 出射速度是否已经给过。`launchPending` 还要再等球真正进主盘才关 */
  private exitFired = false;
  /** 本次首发用的力度，掉回道底重发时沿用 */
  /** 道内回弹次数。只用来兜底，正常情况下恒为 0 */
  private laneStalls = 0;
  /** 本次首发在交汇处要用的出射速度与仰角，`plunge` 算好、`tryExitLane` 兑现 */
  private exitSpeed = 0;
  private exitAngleDeg = 90;
  /** 连续脱困次数决定的加成倍率，逐次加倍封顶 4 倍 */
  private escapeBoost = 1;

  /**
   * 脱困方向的确定性随机源。故意不用 Math.random：
   * 无头 smoke 要能在同一颗种子下复现同一场战斗，否则平衡数字每次跑都漂。
   * 与 BattleSim.rng 同一套 LCG。
   */
  private rngState = 0x51ed270b;
  /**
   * 重置出口偏角的随机源。
   *
   * 为什么需要它：无头探针要对比「同一发球在多个随机种子下的落点分布」，
   * 而默认种子写死在字段初始化里，每 new 一个板都是同一个序列——
   * 于是 40 次采样退化成 1 次，探针会报「落点范围 [x, x]」然后误判力度无效。
   * 这不是随机性没实现，是种子没法变。
   */
  seedRng(seed: number): void {
    this.rngState = seed >>> 0;
  }

  private rng(): number {
    this.rngState = (this.rngState * 1664525 + 1013904223) >>> 0;
    return this.rngState / 0x100000000;
  }

  /** 视觉层读取 */
  ballX = 0;
  ballY = 0;
  ballVX = 0;
  ballVY = 0;
  /**
   * 盘面正在被「时间」相位推着摇的强度（0..1）。渲染层拿它调 Boss 嘴色。
   *
   * 旧版叫 `frenzyGlow`：值确实只有一个「有没有」，但名字把机制说死了
   * （发飙），于是「谁在什么时候发飙」被写进了下游每一个调用点。
   */
  phaseSway = 0;
  /** 救球窗口是否被 ammo 相位关闭。UI 要能说「为什么金环不亮」 */
  noRescue = false;
  /** 本球球时倍率。HUD 用它把倒计时染红 */
  ballTimeScale = 1;
  /** 结束原因统计：用于验证盘面节奏是否健康 */
  readonly endReason = { slot: 0, out: 0, timeout: 0 };
  /** 超时球的落点坐标与当时的球况，用于定位盘面死角 / 机制卡点 */
  readonly timeoutSpots: { x: number; y: number; vx: number; vy: number; inLane: boolean; laneStalls: number; pending: boolean; fired: boolean; state: string }[] = [];
  totalBallAge = 0;
  finishedBalls = 0;

  constructor(physics: Physics, stage: ExpandedStage, hooks: PhysicsBoardHooks = {}) {
    this.physics = physics;
    this.stage = stage;
    this.hooks = hooks;
    // 每关一份的单球时间预算。见 schema 里 `rules.ballSeconds` 的注释：
    // 盘面密度差三倍，同一条线去卡会让最密的几关有 16% 的球被倒计时判死。
    this.ballBudget = stage.rules.ballSeconds ?? PHYSICS.ballMaxAge;
    this.build();
    physics.addImpact((info) =>
      this.handleImpact(info.tag.id, info.tag.kind ?? 'normal', info.intensity, info.x, info.y),
    );
    physics.addCollide((a, b, started) => this.handleCollide(a, b, started));
  }

  /* ---------------------------------------------------------------- 构建 */

  private build(): void {
    const s = this.stage;

    const wall = (
      id: string,
      x: number,
      y: number,
      w: number,
      h: number,
      rotDeg: number,
      role: 'wall' | 'deflector' = 'wall',
    ): Collider => {
      this.walls.push({ id, x, y, w, h, rotDeg, role });
      return this.physics.createWall(x, y, w, h, deg2rad(rotDeg), { role, id });
    };

    /*
     * 侧壁 / 顶盖 / 底板。**宽度必须覆盖球道**，这是第一版最大的坑。
     *
     * 旧代码用 `hw = stage.width / 2` 建墙，改造后 `stage.width` 是「主盘 + 球道」
     * 的总宽，球道外壁落在 `width/2` 之外，于是侧壁和顶盖都只盖住主盘，
     * 球道完全没有天花板：满弹的球从道顶敞口冲出去后一路飞到 y=39 飞出机台
     * （实测如此，12 关全关且全报「逃顶」）。
     *
     * 所以侧壁位置必须**分别**按主盘左缘和球道外壁来放：
     *   左壁 = −(主盘左缘 + 余量)  ← 贴着主盘，不要多留空地
     *   右壁 = 球道外壁 + 余量
     *   顶盖 / 底板 = 跨这两个位置的全宽
     */
    const playLeft = -this.stage.playLeftX - 0.35;
    const playRight = s.plunger.outerX + 0.35;
    const spanMid = (playLeft + playRight) / 2;
    const spanHalf = (playRight - playLeft) / 2;
    wall('wall_left', playLeft, s.height / 2, 0.35, s.height / 2 + 0.8, 0);
    wall('wall_right', playRight, s.height / 2, 0.35, s.height / 2 + 0.8, 0);
    wall('wall_top', spanMid, s.height + 0.45, spanHalf, 0.35, 0);
    wall('wall_floor', spanMid, 0.35, spanHalf, 0.35, 0);

    /*
     * 弹射道。球停在右下角道底，往下拉杆蓄力，松手沿道竖直弹上去，
     * 到道顶被导流板拐进主盘——和 Windows 经典 3D 弹球同一套读法。
     *
     * 三面墙的分工（少一面球就会漏出去，多一面就成不了「道」）：
     *   内壁：道与主盘的分界。**必须从道底通到道顶拐弯点**，中间不能有缺口——
     *          否则高速上行的球会从缝里提前窜进主盘，玩家看到的就不是「弹上去再落回来」。
     *   外壁：机台右侧边。和 wall_right 之间的夹层就是球道。
     *   道底：球停在这里等玩家拉杆。
     * 道顶不封口，导流板斜着把球拨向主盘。
     */
    const p = s.plunger;
    /*
     * 球道四面：内壁 / 外壁 / 道底。**没有第四面**。
     *
     * 早期版本在这里挂了片「出口斜坡」，想让球沿坡滑进主盘，结果三个约束
     * （水平跨度、坡角、垂直落差）互相打架，实测板和球道差 1.22bu 空洞、还低 2.15bu。
     * 球冲出敞口时脚下是空的，直接撞天花板被垂直弹回，力度对落点完全没有影响
     * （实测 12 关深度差 0.0）。斜坡整条删掉，改由交汇处按力度直接给定出射弹道。
     *
     * 两侧壁**不等高**，这是有意的：
     *   外壁砌到 `bendY`（交汇处），给球一个上边界；
     *   内壁提前 `innerTopDrop` 收头，在交汇处留出一扇朝左的窗口。
     * 内壁若也砌到 `bendY`，球刚被折向左侧就糊在竖直墙上出不来——
     * 竖直通道必然吃掉横向速度，这是绕不过去的物理事实。
     */
    const laneBot = 0.4;
    const laneWall = (id: string, x: number, top: number): void => {
      wall(id, x, (top + laneBot) / 2, 0.07, (top - laneBot) / 2, 0);
    };
    laneWall('lane_outer', p.outerX - 0.07, p.bendY);
    laneWall('lane_inner', p.innerX + 0.07, p.innerTopY);
    // 道底：球停在 restY，球底面离地板顶面 restHeight，所以地板顶面必须落在
    // restY − ballRadius − restHeight。写成 0.4+floorHalf 是同一件事的写法。
    wall('lane_floor', p.x, 0.4 + PLUNGER.floorHalf, PLUNGER.laneWidth / 2, PLUNGER.floorHalf, 0);

    for (const w of s.walls) wall(w.id, w.x, w.y, w.w, w.h, w.rotDeg, w.role);

    /*
     * 可操作翻板。
     *
     * 挂在运动学体上、绕**外端枢轴**转。碰撞盒沿局部 +x 偏移半板长，
     * 于是板的一端正好落在刚体原点上——这一点必须由 `Physics.createFlipper`
     * 保证，板的长度和位置全在那儿算，物理层不再重复推导。
     */
    for (const f of s.flippers) {
      const made = this.physics.createFlipper(f.px, f.py, f.len / 2, f.half, f.restRad, {
        role: 'flipper',
        id: f.id,
      });
      this.flippers.push({
        geom: f,
        t: 0,
        dir: 0,
        swinging: false,
        refundedThisSwing: false,
        held: false,
        lastHitAt: -99,
        body: made.body,
        collider: made.collider,
        angle: f.restRad,
      });
    }

    for (const p of s.pegs) {
      const c = this.physics.createPeg(p.x, p.y, p.r, {
        role: 'peg',
        id: p.id,
        kind: p.kind,
        destructible: p.kind === 'destructible',
      });
      const meta: PegMeta = {
        id: p.id,
        enemyId: p.enemyId,
        kind: p.kind,
        x: p.x,
        y: p.y,
        r: p.r,
        value: p.value,
        collider: c,
        alive: true,
        ghosted: false,
        meshIndex: this.pegs.length,
        hp: p.hp ?? 0,
        maxHp: p.hp ?? 0,
        wuxing: p.wuxing,
      };
      this.pegs.push(meta);
      this.pegById.set(p.id, meta);
    }

    for (const z of s.zones) {
      const c = this.physics.createSensor(z.x, z.y, z.w / 2, z.h / 2, { role: 'sensor', id: z.id });
      this.zones.push({
        id: z.id,
        kind: z.kind,
        label: z.label,
        cx: z.x,
        cy: z.y,
        hx: z.w / 2,
        hy: z.h / 2,
        collider: c,
        inside: false,
        glow: 0,
      });
    }

    const recovery = s.recovery;
    this.physics.createSensor(recovery.x, recovery.y, recovery.width / 2, recovery.height / 2,
      { role: 'recovery', id: 'recovery_pool' });

    /*
     * 落槽：整排做成一个**会左右平移的运动学组**（传感器 + 隔板 + 两块端墙）。
     *
     * ── 端墙是什么，为什么必须有 ──
     *
     * 槽行收窄到 `BOTTOM.slotSpanRatio`（盘宽的 72%）之后，槽行两侧多出来一条
     * 「排外面」的带子。球砸在那条带子上会直落到底、永远够不到任何槽。
     * 端墙就是接住它的：墙从槽行外缘往外上翻且**朝内下倾**，球砸上去顺着墙
     * 滑进排里 —— 落进哪一个，取决于**那一刻排停在哪**。这就是「移动落槽」
     * 的技巧含量：不是瞄一个固定位置，是卡时机。
     *
     * ── 隔板顶高 ──
     *
     * 顶高读 `BOTTOM.dividerTop`，停在滚落钉排下方。隔板要是高于它，
     * 翻板下方的空间会被横向切成 5 段，球在自己的槽通道里滚，
     * 整排移动就退化成「换条通道」。
     */
    const sorted = [...s.slots].sort((a, b) => a.x - b.x);
    const rigPart = (
      x: number,
      y: number,
      hx: number,
      hy: number,
      rotRad: number,
      tag: Omit<ColliderTag, 'alive'>,
      sensor: boolean,
    ): void => {
      const { body } = this.physics.createKinematicBox(hx, hy, x, y, tag, sensor);
      this.slotRig.push({ body, baseX: x });
      // 旋转：刚体先建在原点姿态，再单独设一次，避免 x 带着旋转重复偏移
      if (rotRad !== 0) body.setNextKinematicRotation(rotRad);
    };

    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i]!;
      const b = sorted[i + 1]!;
      const mid = (a.x + b.x) / 2;
      const base = a.y - a.h / 2;
      const top = Math.max(base + 0.6, BOTTOM.dividerTop);
      rigPart(mid, (base + top) / 2, 0.12, (top - base) / 2, 0, { role: 'wall', id: `divider_${i}` }, false);
    }
    for (const sl of s.slots) {
      const { body, collider } = this.physics.createKinematicBox(sl.w / 2, sl.h / 2, sl.x, sl.y, {
        role: 'slot',
        id: sl.id,
        slotKind: sl.kind,
        value: sl.value,
      }, true);
      this.slotRig.push({ body, baseX: sl.x });
      this.slots.push({
        id: sl.id,
        kind: sl.kind,
        label: sl.label,
        value: sl.value,
        cx: sl.x,
        cy: sl.y,
        hx: sl.w / 2,
        hy: sl.h / 2,
        collider,
        inside: false,
        flash: 0,
        baseX: sl.x,
      });
    }
    /*
     * 槽行两侧的收口漏斗是**静态几何**（`genstages.ts` 的 `bottomFlippers`），
     * 不在这里建。
     *
     * 一度把它做成整排的一部分（跟着漂移一起动），栽了两个坑，都得记着：
     *   1. 墙跟着排走 → 排往一边漂的时候，另一边腾出一条没人接的带子，球直接漏下去；
     *   2. 墙和侧壁之间留了 0.67bu（≈ 一个球径）—— 那是**夹球缝**，
     *      stage_01 实测 28% 的球卡在那儿磨到超时，铜钱一球没进。
     *      漏口要么明显过得去（>1.2bu），要么干脆封死（<0.3bu），0.67 最糟。
     * 静态漏斗从「排漂到最远时仍能盖住」的位置一直斜到侧壁，排在里面滑，两头都不漏。
     */
    const pitchSlots = sorted.length > 1 ? sorted[1]!.x - sorted[0]!.x : 0;
    this.slotAmplitude = (pitchSlots * BOTTOM.slotDriftRatio * 5) / BOTTOM.slotSpanRatio;

    /*
     * 確変口。平常停在盘面外 400 单位处（永远碰不到），进入確変时挪到中央口上方——
     * 这就是「中奖口敞开」在物理层的落法：不是把原口改大，而是上面多架一张嘴，
     * 于是原本擦边飞过去的球会被吃进来。中獎概率翻倍这件事由此变成看得见的手感。
     */
    this.feverCatcher = this.physics.createSensor(
      0,
      -400,
      this.stage.rules.fever.gate.w / 2,
      this.stage.rules.fever.gate.h / 2,
      { role: 'fever', id: this.stage.rules.fever.triggerSlot, slotKind: 'fever' },
    );
    this.feverGateOn = false;
  }

  /** 開 / 關確変口。位置直接搬，不重建碰撞体，切换不会有任何掉帧或状态残留。 */
  setFeverGate(on: boolean): void {
    if (this.feverGateOn === on) return;
    this.feverGateOn = on;
    const g = this.stage.rules.fever.gate;
    // 开门那一刻先落到「破绽口当前所在的位置」；之后由 moveSlotRig 每帧跟着排走。
    const at = on ? { x: this.weakCircle().x, y: g.y } : { x: 0, y: -400 };
    this.feverCatcher.setTranslation(at);
    this.feverCatcher.setEnabled(true);
  }

  /* --------------------------------------------------------------- 弹射道 */

  /** 把球放回道底等待下一次拉杆。落槽 / 超时之后由 BattleScene 调。 */
  armLauncher(): void {
    this.rescueReserved = false;
    this.ballState = 'idle';
    // 移动落槽每球从中位重新起摆，玩家每一发看到的相位一样，不靠上一发的运气
    this.slotClock = 0;
    this.slotDrift = 0;
    // 关掉出射闸门：上一发的球已经飞进主盘了，不能让它在盘上再被出射一次
    this.launchPending = false;
    this.exitFired = false;
    this.laneStalls = 0;
    this.shotCooldown = 0;
    this.ready = false;
    this.slowTime = 0;
    this.stallTime = 0;
    this.parkedTime = 0;
    this.ballAge = 0;
    this.stuckTime = 0;
    this.stuckEpisode = 0;
    this.bestY = Number.POSITIVE_INFINITY;
    this.descentStall = 0;
    this.descentPushes = 0;
    this.lastHitAt.clear();
    this.ballX = this.stage.plunger.x;
    this.ballY = this.stage.plunger.restY;
    this.ballVX = 0;
    this.ballVY = 0;
    if (!this.body) {
      const made = this.physics.createBall(this.ballX, this.ballY);
      this.body = made.body;
      this.ballCollider = made.collider;
      this.body.setGravityScale(0, true);
    } else {
      this.body.setEnabled(true);
      this.body.setTranslation({ x: this.ballX, y: this.ballY }, true);
      this.body.setLinvel({ x: 0, y: 0 }, true);
      this.body.setGravityScale(0, true);
    }
    // 新球重置：把上一次发射残留的弹性 / 阻尼 / 外力全部退回默认值
    this.ballCollider?.setRestitution(PHYSICS.ballRestitution);
    this.baseDamping = PHYSICS.ballLinearDamping;
    this.body.setLinearDamping(this.baseDamping);
    this.body.resetForces(true);
  }

  /**
   * **只给无头探针用**：把球瞬移到指定位置并清零速度。
   *
   * 存在的理由：测「翻板几何本身会把球推向哪边」需要从任意点自由落体，
   * 而 `plunge()` 只能从发射道走完整条球路，位置完全不可控。
   * 这是纯测试入口，`BattleScene` / `main.ts` 都不调它，所以没有作弊风险。
   */
  placeBall(x: number, y: number, vx = 0, vy = 0): void {
    this.ballState = 'live';
    this.body?.setTranslation({ x, y }, true);
    this.body?.setLinvel({ x: vx, y: vy }, true);
    this.body?.setGravityScale(1, true);
    this.ballX = x;
    this.ballY = y;
    this.ballVX = vx;
    this.ballVY = vy;
  }

  /**
   * **首发**：拉杆弹射。球从道底被顶上去，沿竖直球道真爬到**交汇处**，
   * 到那里再按力度折向左上方飞进主盘（`tryExitLane`）。
   *
   * 玩家唯一的输入是拉多大力。**力度一个量同时决定两件事**：
   *   出射速度——拉得越满飞得越快；
   *   出射仰角——拉得越满仰角越平。
   * 弱弹仰角陡、速度小，落在主盘最右侧的浅处；满弹仰角平、速度快，
   * 横扫进钉阵深处。这才是经典 3D 弹球的读法：你能控制力气，控制不了落点。
   *
   * 球道那一段是真物理（玩家看得见球被顶上去），但它只负责把球送到交汇处，
   * **不参与决定落点**。竖直通道必然吃掉横向速度，所以指望「靠球道里的速度
   * 把球甩进主盘」是行不通的：早期版本实测球到顶时 `vx` 只剩 −1.0bu/s，
   * 落点散度 0.1bu，力度对落点完全没有影响。
   */
  plunge(power: number): void {
    if (!this.body || this.ballState !== 'idle') return;
    if (this.hooks.canLaunch && !this.hooks.canLaunch()) return;
    const p = clamp(power, this.stage.plunger.minPower, this.stage.plunger.maxPower);
    this.ballState = 'live';
    this.ballAge = 0;
    this.slowTime = 0;
    this.stallTime = 0;
    this.parkedTime = 0;
    this.stuckTime = 0;
    this.stuckEpisode = 0;
    this.descentStall = 0;
    this.descentPushes = 0;
    this.bestY = this.stage.plunger.restY;
    this.ready = false;
    this.shotCooldown = PHYSICS.shotCooldown;
    this.body.setGravityScale(1, true);
    /*
     * 道内上行：竖直分量是弹簧给的力度，水平给一份朝左的初速让球贴住内壁。
     *
     * 水平分量的作用**不是转向**（竖直通道必然把它吃掉），而是把出射点
     * 从球道中心挪到内壁边上 —— 球道中心比主盘右缘还靠外 2.25bu，
     * 弱弹的出射速度飘不过那段距离。详见 `PLUNGER.laneGuideVx` 的注释。
     */
    this.launchPending = true;
    this.exitFired = false;
    this.laneStalls = 0;
    this.body.setLinvel({ x: -PLUNGER.laneGuideVx, y: p }, true);
    /*
     * 出射弹道在这里就**算好**，但速度要等球真的爬到交汇处才给。
     *
     * `launch` 事件只在**此刻**发一次，不能等到出射时再发一次：
     * `BattleSim.onLaunch` 会扣 `ballsLeft` 并重置每球状态，发两次等于
     * 一次发射吃掉两颗球。事件里的 `angleDeg` 直接报交汇处将要用的那个角，
     * 而不是先报个竖直的假值再更正——玩家看到的是这一发的真实仰角。
     */
    const g = this.stage.plunger.exit;
    const r = this.launchRatio(p);
    const speed = g.weakSpeed + (g.fullSpeed - g.weakSpeed) * r;
    this.exitAngleDeg = g.weakAngleDeg + (g.fullAngleDeg - g.weakAngleDeg) * r;
    this.exitSpeed = speed;
    this.emit({
      t: 'launch',
      power: p,
      angleDeg: this.exitAngleDeg,
      x: this.ballX,
      y: this.ballY,
      followUp: false,
    });
  }

  /**
   * 交汇处出射 + 「球到底进没进主盘」的闸门。每帧在 `step()` 里问一次。
   *
   * **两个闸门是分开的**，因为「出射」和「成功进盘」是两件事：
   *   `exitFired`  —— 出射速度给过没有。给了就不再给，球真的飞走了。
   *   `launchPending` —— 这颗球算不算「还在半路上」。一直到球的 x 越过主盘右缘
   *                    才算完事，中途掉回球道会重新顶一次。
   *
   * 为什么需要第二个闸门：出射点在球道中心，比主盘右缘还靠外 1.3bu。
   * 弱弹的出射速度小，万一没飘过主盘右缘就落回球道，球会永远在道里打转，
   * 玩家看到的是「这球坏了」。真机上对应的是弹簧没把球送出出口、落回道里再顶一次。
   *
   * 速度与仰角都按力度比例在弱/满两档之间插值（`stage.plunger.exit`），
   * 两档都由 `buildPlunger` 按本关重力实算，所以 12 关的落点区间一致。
   *
   * **为什么直接 `setLinvel` 而不是让它撞什么东西拐弯**：
   * 撞出来的方向受钉阵二次碰撞打散，「拉得越满落得越深」不成立
   * （实测强弹均值有时比弱弹还靠右）。把映射写死成一条插值曲线，
   * 玩家读一个数就能预判落点，这是手感的前提。
   */
  private tryExitLane(): void {
    if (!this.body || !this.launchPending) return;
    const p = this.stage.plunger;

    /*
     * 球在道里待超过 `PLUNGER.laneClimbLimit` → 这一发压根没发出去，直接结算。
     *
     * 力度下限是按「临界速度 × 1.18」算的，正常爬满 29bu 只要 1.2~1.6 秒；
     * 但实测有一批球在道内以 2~13 bu/s 往上磨，磨满整个 9.5 秒球龄：
     * 超时落点 (10.3,2.2) v=(-2.7,12.7)、(9.4,3.2) v=(1.3,2.3)、(11,1) v=(0,0)。
     *
     * 球道是**发射器**，不是球场。让球在发射器里磨到超时，玩家看到的是
     * 「球掉进右边管子里卡住，很久之后莫名结算」；更糟的是它会以「超时」
     * 进 smoke 的关卡问题清单（stage_02/05/11 15~18%），于是所有人跑去
     * 调盘面布局，而问题根本不在盘面上。
     */
    if (this.ballX > p.innerX - 0.2 && this.ballY < p.innerTopY && this.ballAge > PLUNGER.laneClimbLimit) {
      this.launchPending = false;
      this.settleToNearestSlot();
      this.finishBall('slot');
      return;
    }

    // 进主盘了，这颗球的事办完
    if (this.exitFired && this.ballX < this.stage.playRightX) {
      this.launchPending = false;
      return;
    }

    if (!this.exitFired && this.ballY >= p.bendY) {
      this.exitFired = true;
      this.applyExitVelocity();
    }
  }

  /**
   * 球出过一次、结果又掉回球道里 → 这一发没进盘，直接按就近槽结算。
   *
   * **必须放在 `step()` 而不是 `tryExitLane()` 里**：`tryExitLane` 开头就
   * `if (!this.launchPending) return`，而球一旦合法漂过主盘右缘，
   * `launchPending` 就会被清掉——那正是它「已经在盘上正常玩」的标志。
   * 于是「出射后又落回球道」这种球永远走不到 `tryExitLane` 里的任何规则，
   * 只能在道里磨到 9.5 秒超时（实测闸0/已射1 的卡点全是这一类）。
   *
   * 玩家看到的是「球在盘上飞了一会儿，忽然掉回右边管子里卡住」。
   * 掉回发射器 = 这一发没进盘 = 该结束了。
   */
  private settleIfBackInLane(): void {
    if (!this.exitFired) return;
    const p = this.stage.plunger;
    if (this.ballX <= p.innerX - 0.2 || this.ballY >= p.innerTopY) return;
    this.launchPending = false;
    this.settleToNearestSlot();
    this.finishBall('slot');
  }

  /** 写进刚体的出射速度。由 `plunge` 算好，`tryExitLane` 在交汇处兑现 */
  private applyExitVelocity(): void {
    if (!this.body) return;
    // 仰角 0 = 正水平朝左，90 = 竖直朝上。弱弹陡、满弹平。
    const rad = (this.exitAngleDeg * Math.PI) / 180;
    this.body.setLinvel({ x: -Math.cos(rad) * this.exitSpeed, y: Math.sin(rad) * this.exitSpeed }, true);
  }

  /** 力度 → [0,1] 的比例。出射速度和仰角都按它插值 */
  private launchRatio(power: number): number {
    const p = this.stage.plunger;
    return clamp((power - p.minPower) / Math.max(1, p.maxPower - p.minPower), 0, 1);
  }

  /**
   * 本次首发掉回球道重发的次数。**正常应恒为 0**。
   *
   * 暴露出来是给无头探针当断言用的：它一旦大于 0，就说明出射参数弱到
   * 球飘不回主盘，玩家会看到「这球在道里弹个没完」。这是个不该发生但
   * 一旦发生就必须被发现的分支，不能只靠肉眼看。
   */
  get laneStallCount(): number {
    return this.laneStalls;
  }

  /**
   * **追打救球**：给正在盘上滚的球一记改向的冲量，方向由玩家瞄准决定。
   *
   * 这条通道和首发是两回事，刻意分开：首发是「放球进盘」，不选方向；
   * 救球是「在盘上打这一颗」，要瞄准。合并成一个函数会让首发也不得不接角度，
   * 那正是这次要改掉的东西。
   */
  shoot(power: number, angleDeg: number): void {
    if (!this.body || this.ballState !== 'live') return;
    if (this.hooks.canLaunch && !this.hooks.canLaunch()) return;
    // 救球窗口被相位关闭时，这一发直接不成立：不能「金环还亮着但打不出去」，
    // 也不能扣掉一发预算再告诉玩家不行。
    if (this.rescueClosed) return;
    if (this.shotCooldown > 0 || (!this.ready && !this.rescueReserved)) return;
    const a = clamp(angleDeg, SHOOT_MIN_ANGLE_DEG, SHOOT_MAX_ANGLE_DEG);
    const p = clamp(power, SHOOT_MIN_POWER, SHOOT_MAX_POWER);
    const rad = deg2rad(a);
    this.rescueReserved = false;
    // 补射**不重置 ballAge**：一局的时长是有限资源，允许多次击射就能无限续命。
    // 但要清掉「没在下降」和「卡住」的计时器，否则补射完立刻又被判定成卡死。
    this.stuckTime = 0;
    this.stuckEpisode = 0;
    this.descentStall = 0;
    this.descentPushes = 0;
    this.slowTime = 0;
    this.stallTime = 0;
    this.parkedTime = 0;
    this.ready = false;
    this.shotCooldown = PHYSICS.shotCooldown;
    this.body.setGravityScale(1, true);
    // 关键：初速是**设定**而不是「叠加」。玩家打出的角度就是他想要的方向，
    // 不该被球当前残留的动量带偏——那是物理的诚实，玩家的困惑。
    this.body.setLinvel({ x: Math.cos(rad) * p, y: Math.sin(rad) * p }, true);
    this.emit({
      t: 'launch',
      power: p,
      angleDeg: a,
      x: this.ballX,
      y: this.ballY,
      /** 补射时为 true：UI 要区分「首发」和「追打」，提示语不一样 */
      followUp: true,
    });
  }

  /** 落槽整排当前的横向偏移（bu）。渲染层用它把槽口整排一起挪过去 */
  get slotOffset(): number { return this.slotDrift; }

  /** 现在能不能击射。UI 的瞄准线和球环都读它，玩家不该靠猜。 */
  get canShoot(): boolean {
    if (this.rescueClosed && this.ballState === 'live') return false;
    return this.ballState !== 'done' && this.shotCooldown <= 0 &&
      (this.ballState === 'idle' || this.ready || this.rescueReserved) && (this.hooks.canLaunch?.() ?? true);
  }

  beginCharge(): boolean {
    if (this.rescueClosed && this.ballState === 'live') return false;
    if (!this.canShoot) return false;
    this.rescueReserved = this.ballState === 'live';
    return true;
  }

  cancelCharge(): void { this.rescueReserved = false; }

  get rescueHeld(): boolean { return this.rescueReserved && this.ballState === 'live'; }

  get secondsLeft(): number {
    if (this.ballState !== 'live') return 0;
    return Math.max(0, this.ballBudget * this.ballScale - this.ballAge);
  }

  /** 本球球时的满格（秒）。HUD 画倒计时条读它，不是读 `rules.ballSeconds`。 */
  get ballSecondsFull(): number {
    return this.ballBudget * this.ballScale;
  }

  /** 「时间」剥夺的镜头摇晃倍率。0 = 这一相位不带镜头反馈。 */
  get phaseCameraShake(): number {
    return this.cameraShake;
  }

  /** 球速够不够快到「正在飞」。够快的时候球环灭，玩家就知道现在打是浪费。 */
  get isReady(): boolean {
    return this.ballState === 'live' && this.canShoot && (this.ready || this.rescueReserved);
  }

  /** 击射冷却进度 0~1，UI 拿它画冷却环。 */
  get cooldownRatio(): number {
    if (this.shotCooldown <= 0) return 1;
    return 1 - this.shotCooldown / PHYSICS.shotCooldown;
  }

  get state(): 'idle' | 'live' | 'done' {
    return this.ballState;
  }

  get ballSpeed(): number {
    return Math.hypot(this.ballVX, this.ballVY);
  }

  /**
   * 弹道预测。**只服务追打救球**。
   *
   * 首发不画这条线：首发落点由导流板 + 力度 + 出口随机偏角共同决定，
   * 画一条确定的线给玩家看等于骗人——「我瞄准了」恰恰是这套弹射道刻意不给的东西。
   */
  preview(power: number, angleDeg: number): TrajectoryResult {
    const radians = deg2rad(clamp(angleDeg, SHOOT_MIN_ANGLE_DEG, SHOOT_MAX_ANGLE_DEG));
    const p = clamp(power, SHOOT_MIN_POWER, SHOOT_MAX_POWER);
    // 落槽挡板用传感器**当前**的 x（cx），不是 stage 里的静态 x：
    // 整排一直在漂，用静态坐标预测出来的线会偏出将近一个槽距，
    // 而救球本来就靠这条线瞄——瞄准线偏了就等于「准头被人偷偷改了」。
    const stops = this.slots.map((s) => ({ x: s.cx, y: s.cy, w: s.hx * 2, h: s.hy * 2 }));
    if (this.feverGateOn) {
      const g = this.stage.rules.fever.gate;
      stops.push({ x: this.weakCircle().x, y: g.y, w: g.w, h: g.h });
    }
    return predictTrajectory({ x: this.ballX, y: this.ballY, vx: Math.cos(radians) * p, vy: Math.sin(radians) * p,
      gravity: this.stage.gravity * this.physics.gravityScale, ax: this.physics.lateralGravity,
      radius: PHYSICS.ballRadius, restitution: ((this.ballCollider?.restitution() ?? PHYSICS.ballRestitution) + PHYSICS.pegRestitution) / 2,
      damping: this.body?.linearDamping() ?? PHYSICS.ballLinearDamping,
      pegs: this.pegs.filter((peg) => peg.alive && !peg.ghosted),
      walls: this.walls.filter((wall) => !wall.id.startsWith('lane_')), stops });
  }

  /* ---------------------------------------------------------------- 翻板 */

  /**
   * 按下 / 松开一块翻板。
   *
   * **按住 = 持续弹起**，和真弹球一样：板升到弹起位就停在那儿，
   * 松手才回落。所以这里只记录「意图」，真正的插值在 `stepFlipper` 里每帧做。
   *
   * 落空不罚：按了板没碰到球，玩家只是白按一下。弹板已经是唯一的操作，
   * 再加个「按空扣能量」会把这条操作变成需要先瞄准的技巧，
   * 而这盘面根本没有让玩家预判的空间。
   */
  pressFlipper(side: 'left' | 'right', down: boolean): void {
    const f = this.flippers.find((v) => v.geom.side === side);
    if (!f) return;
    f.held = down;
    if (down && this.clock - f.lastHitAt >= FLIPPER.cooldown) {
      f.dir = 1;
      f.swinging = true;
      f.refundedThisSwing = false;
      f.lastHitAt = this.clock;
    } else if (!down) {
      f.swinging = false;
    }
  }

  /**
   * 翻板每帧推进。**必须在 `physics.step()` 之前跑完**。
   *
   * 顺序是硬要求：`setNextKinematicRotation` 是对 Rapier 的「下一帧目标角度」
   * 预约，必须在求解之前登记；反过来做，Rapier 会把这一帧的运动学体当静止，
   * 板「瞬移」过去，球要么穿板而过要么被弹飞，没有中间态。
   */
  private stepFlipper(dt: number): void {
    for (const f of this.flippers) {
      if (f.dir !== 0) {
        const span = f.dir === 1 ? FLIPPER.upTime : FLIPPER.downTime;
        f.t = clamp(f.t + (f.dir * dt) / span, 0, 1);
        if (f.t >= 1 || f.t <= 0) { f.dir = 0; f.swinging = false; }
      } else if (!f.held && f.t > 0) {
        // 松手回落。走的是同一条 `t`，所以半途再按下会从当前角度继续上抬，
        // 不会跳一下——真弹球翻板就是这个手感。
        f.swinging = false;
        f.t = clamp(f.t - dt / FLIPPER.downTime, 0, 1);
      }
      f.angle = f.geom.restRad + (f.geom.flipRad - f.geom.restRad) * f.t;
      f.body.setNextKinematicRotation(f.angle);
      /*
       * 只在**上弹途中**判击打。
       *
       * 判据不能用「0 < t < 1」：那样板**回落**到接近静止位时 t 趋近 0，
       * 而冲量系数是 `1 - t`，于是回落末段反而给出接近满额的推力。
       * 球被板压回静止位的那一下会以最大力道弹出去——
       * 玩家看到的是「我松开 Z，球突然被狠狠弹了一下」，和他按没按 Z 毫无关系。
       */
      if (f.t > 0 && f.t < 1 && f.swinging) this.tryFlipperStrike(f);
    }
  }

  /**
   * 翻板击球。
   *
   * 判定用「点到线段的距离」而不是碰撞事件：板在 0.07s 内扫过 2.4bu，
   * 球速上限 96bu/s，一帧走 1.6bu——按连续接触判定的话，擦边打中会被
   * 判成「这一帧刚接触」或「上一帧刚接触」全凭运气。点到线段是一个
   * 与帧率无关的确定判定，无头跑和实机跑结果一致。
   */
  private tryFlipperStrike(f: FlipperState): void {
    if (this.ballState !== 'live' || !this.body) return;
    const g = f.geom;
    const tipX = g.px + Math.cos(g.restRad + (g.flipRad - g.restRad) * f.t) * g.len;
    const tipY = g.py + Math.sin(g.restRad + (g.flipRad - g.restRad) * f.t) * g.len;
    const d = pointSegDist(this.ballX, this.ballY, g.px, g.py, tipX, tipY);
    const reach = PHYSICS.ballRadius + g.half + FLIPPER.hitPad;
    if (d > reach) return;

    /*
     * 击打强度 = 板当前的速度。板慢下来（已经弹到位）时不该再补冲量，
     * 否则「按住 Z」会把球反复顶上去，玩家等于按住不放就能无限续命。
     * 所以只有 t 严格在 0..1 之间才给全额，冲量随后半程线性衰减。
     */
    const swing = 1 - f.t;
    if (swing <= 0) return;
    const v = this.body.linvel();
    const n = Math.cos(g.kickRad);
    const m = Math.sin(g.kickRad);
    const add = FLIPPER.kickImpulse * swing;
    // 沿击球方向补速度，而不是**设**速度：球自己带的水平分量必须留着，
    // 否则每打一次球的横向动量就被清零，按 Z 会把球锁死在一条竖线上。
    this.body.setLinvel({ x: v.x + n * add, y: v.y + m * add }, true);
    /*
     * 一次挥板只还一次时间。
     *
     * 挥板期间会连续 4 帧都判到「打中」，每帧都还的话一次挥板能白赚 2.2 秒，
     * 比球本身还能活的时间还长——倒计时直接形同虚设。
     */
    if (!f.refundedThisSwing) {
      f.refundedThisSwing = true;
      this.ballAge = Math.max(0, this.ballAge - FLIPPER.timeRefund);
    }
    f.lastHitAt = this.clock;
    this.hooks.onEvent?.({
      t: 'flipperHit',
      side: g.side,
      x: this.ballX,
      y: this.ballY,
      power: add,
      timeRefund: FLIPPER.timeRefund,
    });
  }

  /* ---------------------------------------------------------------- 步进 */

  /**
   * 移动落槽：整排左右平移。
   *
   * **必须排在 `physics.step()` 之前**，而且只能用 `setNextKinematicTranslation`
   * —— 那是在告诉 Rapier「这一帧我要到这里」，由它推出表面速度；直接
   * `setTranslation` 等于瞬移，球会被端墙穿过去而不是被推着走。
   */
  private moveSlotRig(dt: number): void {
    this.slotClock += dt;
    const amp = this.slotAmplitude * this.aimDriftMult;
    // 从 0 开始、起点在中位：第一帧就有最大速度，玩家一进盘就能看出它在动
    const period = Math.max(1.2, BOTTOM.slotDriftPeriod / Math.max(0.2, this.aimDriftSpeed));
    this.slotDrift = amp * Math.sin((2 * Math.PI * this.slotClock) / period);
    for (const part of this.slotRig) part.body.setNextKinematicTranslation({ x: part.baseX + this.slotDrift, y: 0 });
    for (const s of this.slots) s.cx = s.baseX + this.slotDrift;
    /*
     * 確変口跟着排一起走。
     *
     * 它平时挂在盘外，开门时被搬到「中央破绽口上方」——而破绽口属于排的一员，
     * 排漂了它不跟的话，中獎口就悬在一处空槽上方：既接不到本该接的球，
     * 画面上也是一张嘴对着一块地板。
     */
    if (this.feverGateOn) {
      const g = this.stage.rules.fever.gate;
      // 逐帧 setTranslation 而非 setNextKinematicTranslation：口是挂在固定体上的
      // 传感器，不是运动学体，每帧直接搬不会产生速度脉冲，也不会与排的位置打架。
      this.feverCatcher.setTranslation({ x: this.stage.boss.weakPoint.x + this.slotDrift, y: g.y });
    }
  }

  /**
   * 破绽判定圈。**跟着落槽整排一起漂**。
   *
   * 旧版拿 `stage.boss.weakPoint` 的静态 x 判「正中破绽」，而破绽口本身是排的一员、
   * 每秒都在左右跑——于是「×weakSlotMult」判的是一个玩家看不见、也瞄不到的圆。
   * 现在判据和渲染层读的是同一个量（排的偏移），玩家看得见的亮区就是判定区。
   */
  private weakCircle(): { x: number; y: number; r: number } {
    const wp = this.stage.boss.weakPoint;
    return { x: wp.x + this.slotDrift, y: wp.y, r: wp.r * this.weakScale };
  }

  /** 破绽判定圈的公开读法（渲染层画高亮、Boss 嘴对位、伤害特效都读它）。 */
  get weakPointNow(): { x: number; y: number; r: number } {
    return this.weakCircle();
  }

  step(dt: number): void {
    this.clock += dt;
    this.expireChannels();
    this.moveSlotRig(dt);

    if (this.lateralG > 0) {
      // 「时间」剥夺：整盘横向推球。与旧版的 frenzyTimer 不同，
      // 它不靠倒计时自己结束，而是**跟着相位活**——相位一换，下发的新档位
      // 就把 lateralG 收回 0。倒计时版会在相位早就切走后继续推 20 秒。
      this.phaseSway = Math.min(1, this.phaseSway + dt * 3);
      this.physics.lateralGravity = Math.sin(this.clock * this.lateralHz) * this.lateralG;
    } else {
      this.phaseSway = Math.max(0, this.phaseSway - dt * 2);
      this.physics.lateralGravity = 0;
    }

    /*
     * 翻板必须排在 `physics.step()` **之前**：它向 Rapier 预约的是「下一帧转到哪」，
     * 登记晚于求解就等于这一帧的板是静止的，球会直接穿过去。
     */
    this.stepFlipper(dt);
    this.physics.step();

    if (this.body && this.ballState === 'live') {
      this.applyForce();
      this.applyLaneDamping();

      if (this.shotCooldown > 0) this.shotCooldown = Math.max(0, this.shotCooldown - dt);

      const t = this.body.translation();
      this.ballX = t.x;
      this.ballY = t.y;
      this.physics.setBallState(t.x, t.y, this.body.linvel().x, this.body.linvel().y);
      /*
       * 交汇处出射闸门。必须在读位置之后、读速度之前跑。
       *
       * **顺序是硬要求，不是风格问题**：球到交汇处时速度会被整个换掉，
       * 如果先读 `v` 再出射，下面那段限速就会拿**道内的旧速度**（满弹约 110）
       * 去判定超速，然后用那个旧方向把速度写回去——出射直接被抹掉，
       * 玩家看到的是「球在道顶顿一下又继续往上冲」。第一版就踩了这个坑。
       */
      this.tryExitLane();
      this.settleIfBackInLane();
      if (this.ballState !== 'live') return;

      const v = this.body.linvel();
      this.ballVX = v.x;
      this.ballVY = v.y;
      const sp = Math.hypot(v.x, v.y);
      const maxSpeed = BASE_MAX_SPEED * this.speedProduct();
      if (sp > maxSpeed) {
        this.body.setLinvel({ x: (v.x / sp) * maxSpeed, y: (v.y / sp) * maxSpeed }, true);
      } else {
        // 速度下限：多通道取最大值。球在深口袋里快停住时被硬推回最低速度，
        // 技能方能把「球滚多久」当成一个可操作的量
        const floor = this.speedFloor();
        if (floor > 0 && sp < floor && sp > 0.01) {
          this.body.setLinvel({ x: (v.x / sp) * floor, y: (v.y / sp) * floor }, true);
        }
      }

      this.ballAge += dt;

      // 「可再射」判定。球慢到打得住时，玩家才值得花一发去改它的方向。
      //
      // 进出用两条线（迟滞）：进入要连续慢够 readyCooldown，退出要快回 readyRelease。
      // 单阈值在这种分布上会一直闪，详见 PHYSICS.readyRelease 的注释。
      if (sp < PHYSICS.readySpeed) this.slowTime += dt;
      else this.slowTime = 0;
      if (this.ballState === 'live') {
        if (this.slowTime > PHYSICS.readyCooldown) this.ready = true;
        else if (sp > PHYSICS.readyRelease) this.ready = false;
      }

      // 玩家赖在盘上不动是另一种「没玩懂」：球**基本停住**太久就强制落槽。
      // 走的是和「掉出盘外 / 超时」同一条结算路径，但**不**记 endReason——
      // 这是玩家自己不动，不是关卡布局的缺陷。
      //
      // 这里必须用另一条更低的线（stallSpeed），不能复用上面的 slowTime：
      // slowTime 的阈值是「打得住」，一颗以 11bu/s 正常滚动的球也会往里累加，
      // 拿它判「卡死」等于把还在动的球提前判死。这是两个不同的问题。
      if (sp < PHYSICS.stallSpeed) this.stallTime += dt;
      else this.stallTime = 0;
      /*
       * 「基本不动」的**累计**时长。和 `stallTime` 分开，因为它要求连续——
       * 而 `antiStuck` 每 0.3s 会给停死的球补一记冲量把速度顶回 stallSpeed 之上，
       * `stallTime` 每次都被清零，永远够不到 `stallForceSlot`。
       *
       * 结果是：球卡在钉阵口袋里被反复推一把、始终挪不出去，
       * 一路挂到 `ballMaxAge` 才以「超时」结束。smoke 把它算成**关卡布局缺陷**
       * （stage_05 超时率 19%），但那其实是「球停死了没人管」——
       * 调布局怎么调都没用，因为坑会随机出现在不同坐标上。
       *
       * 所以这里要一条**带缓释、不归零**的累计线：给 antiStuck 几次脱困机会，
       * 脱不掉就把这颗球结算掉。缓释系数 0.35 意味着补一把冲量只能削掉
       * 三成多的累计值，球必须真的离开那个口袋才可能停下来。
       */
      if (sp < PHYSICS.stallSpeed) this.parkedTime += dt;
      else this.parkedTime = Math.max(0, this.parkedTime - dt * 0.35);
      if (this.parkedTime > PHYSICS.parkedForceSlot) {
        this.ballState = 'done';
        this.rescueReserved = false;
        this.totalBallAge += this.ballAge;
        this.finishedBalls++;
        this.body.setLinvel({ x: 0, y: 0 }, true);
        this.body.setGravityScale(0, true);
        this.body.setEnabled(false);
        // **不记 endReason**：和上面的 stallForceSlot 同理，
        // 「球停死了」是脱困机制没救回来，不是盘面几何有洞。
        this.settleToNearestSlot();
        this.emit({ t: 'ballRetired', x: this.ballX, y: this.ballY });
        return;
      }
      if (this.stallTime > PHYSICS.stallForceSlot) {
        this.ballState = 'done';
        this.rescueReserved = false;
        this.totalBallAge += this.ballAge;
        this.finishedBalls++;
        this.body.setLinvel({ x: 0, y: 0 }, true);
        this.body.setGravityScale(0, true);
        this.body.setEnabled(false);
        this.settleToNearestSlot();
        this.emit({ t: 'ballRetired', x: this.ballX, y: this.ballY });
        return;
      }

      this.antiStuck(dt, sp);
    }

    for (const z of this.zones) z.glow = Math.max(0, z.glow - dt * 2.2);
    for (const s of this.slots) s.flash = Math.max(0, s.flash - dt * 2.6);
  }

  /**
   * 球在弹射道内时切到低阻尼。
   *
   * 为什么必须有这个开关：盘面阻尼 `PHYSICS.ballLinearDamping = 0.45` 是和
   * 「撞得越久打越疼」绑定的——它决定球在钉阵里弹多久，动了整套伤害公式就塌。
   * 但同一套阻尼作用在「竖直爬 29bu 的球道」上会吃掉一半以上动能：
   * 实测 v0=74 只能爬 24.94bu，而解析值要 71.5 才够爬 29.08bu。
   * 后果是「力度 → 进盘深度」变成一条极陡的曲线，玩家拉杆没有手感。
   *
   * 所以道内单独降阻尼（`PLUNGER.laneDamping`），一进主盘立刻恢复盘面阻尼。
   *
   * 这里**不再施加任何横向导向力**。曾经试过「在道顶末段加一个恒定向左的力
   * 把球推向出口」，结果力度和落点的关系整个反过来：弱弹在道里待得久被推得更远，
   * 强弹掠过快推不动，于是「拉得越满落得越靠右」。改成在出口直接按力度给
   * 横向速度（`applyExitKick`）之后，这条关系才是单调的。
   */
  /**
   * 球此刻算不算「还在弹射道里」。
   *
   * 三个条件缺一不可，缺一个都会让道内低阻尼（0.02）泄漏到主盘上：
   *   - 横向在球道的 x 区间内
   *   - 还没爬过交汇处
   *   - **这一发还没出射过**。只看 y 是不够的：出射后的球如果又被顶回
   *     交汇处高度附近（补射、手动干预），会被误判成「还在道里」，
   *     于是主盘阻尼不恢复，球在盘上永远慢不下来，金环窗口再也打不开。
   */
  private get inLane(): boolean {
    const p = this.stage.plunger;
    return !this.exitFired &&
      this.ballX > p.innerX - 0.2 && this.ballX < p.outerX + 0.2 && this.ballY < p.bendY;
  }

  private applyLaneDamping(): void {
    if (!this.body) return;
    const want = this.inLane ? PLUNGER.laneDamping : this.baseDamping;
    if (Math.abs(this.body.linearDamping() - want) > 0.001) this.body.setLinearDamping(want);
  }

  private antiStuck(dt: number, speed: number): void {
    /*
     * **看门狗在球道和交汇窗口里必须停用。**
     *
     * 它的触发条件是「球长时间没有净下降」，而球沿竖直球道爬 26bu 的过程中
     * 净下降一直是 0 —— 这不是卡死，这是弹射道该有的样子。于是它在球刚出
     * 交汇处、正要按力度飞进主盘时补了一记 `rng()` 随机横向冲量
     * （实测 `vx` 从 −2.6 突变成 −23.8），把设计好的「力度 → 落点」曲线整个打乱。
     * 玩家看到的现象是「同一档力度有时落很浅有时落很深」，而且完全不可复现。
     *
     * 判据用「还在球道里，或者已经出射但还没进主盘」，而不是单纯看 x：
     * 出射后的球有一小段时间仍待在主盘右缘外侧，那一段同样不该被判成卡死。
     */
    const p = this.stage.plunger;
    const inLaneOrGate = this.ballX > p.innerX - 0.2 &&
      this.ballY < p.bendY + 0.2;
    /*
     * 重力为 0 的盘面**不跑**「无净下降」看门狗。
     *
     * 这条看门狗的前提是「球该往下掉却没掉」，判定的是卡死。但在零重力盘面上
     * 球本来就永远不下沉（真实 12 关重力都是 −62~−88，只有无头夹具会用 0），
     * 判据必然一直成立，于是球正 coasts 到停、马上要开金环窗口时，
     * 看门狗先补一记随机冲量把球踢飞——窗口永远打不开。
     */
    const noGravity = Math.abs(this.stage.gravity) < 1e-6;
    if (inLaneOrGate || noGravity) {
      this.stuckTime = 0;
      this.descentStall = 0;
      this.stuckEpisode = 0;
      if (this.ballY < -1.5 || this.outOfBounds()) this.finishBall('out');
      if (noGravity) return;
    }

    // 看门狗 1：球几乎静止
    if (speed < 3.2) {
      this.stuckTime += dt;
      this.stuckEpisode += dt;
    } else {
      this.stuckTime = Math.max(0, this.stuckTime - dt * 0.7);
      this.stuckEpisode = Math.max(0, this.stuckEpisode - dt * 2.2);
    }
    // 看门狗 2：球还活着但长时间没有净下降（在高密度钉阵里空转）
    if (this.ballY < this.bestY - 0.5) {
      this.bestY = this.ballY;
      this.descentStall = 0;
      // 真的下来了才清零。计数代表「这一串推拿完全没效果」，
      // 中途只要见效一次就该从头算，否则一次早期的无效推会永久拉高后续的升级门槛。
      this.descentPushes = 0;
    } else {
      this.descentStall += dt;
    }
    if (this.body) {
      // 看门狗 3：球在同一处反复卡住太久 → 临时虚化身边钉板，让它穿过去。
      // 用 stuckEpisode 而不是 stuckTime：后者每次推一把就清零，永远够不到阈值。
      if (this.stuckEpisode > PHYSICS.escapeStuckTime) {
        this.escapeTrap();
        this.stuckEpisode = PHYSICS.escapeStuckTime * 0.5;
      }
      if (this.stuckTime > 0.3 || this.descentStall > 0.8) {
        this.stuckTime = 0;
        this.descentStall = 0;
        /*
         * 推满上限就**停止加能量**，改用脱困。
         *
         * 横向冲量对「球卡在两颗钉的凹坑里」是对的：侧向分量把它挤出去，
         * 向下分量让重力接手。但球挤不出去时（同一次下压反复触发、
         * bestY 一直不刷新），这记冲量就成了唯一的能量源：撞进密集钉阵被
         * 反射成上抛，球越推越快、越快越落不下去（实测 27 → 147bu/s）。
         * 那时正确做法是**移除约束**（虚化身边钉板 + 给确定的向下初速），
         * 而不是再补一记横向冲量。
         *
         * 升级时**不能**把 descentPushes 清零：清零就变成「推、推、升级+清零、
         * 推、推、升级+清零」，泵只是被削弱并没有停——实测封在盒子里 4.5 秒仍补了
         * 5 次横向冲量。清零的唯一合法时机是球真的下降（见上面 bestY 刷新那处）。
         * 所以计数只增不减，超限之后每一次都走脱困。
         */
        if (this.descentPushes >= PHYSICS.descentPushLimit) {
          this.escapeTrap();
        } else {
          this.descentPushes++;
          // 冲量要**向下**，不是向上。
          // 球被两颗钉的接触法线夹住时，接触法线的合力本来就是斜向上的，
          // 再补一个正的 y 冲量只会把它顶回同一个凹坑——推一万次也是原地。
          // 侧向分量负责把它从口袋里横着挤出去，向下分量负责让重力接手。
          //
          // 「靠边」的阈值必须跟着盘宽走：写死 6.2 的话，18 宽的关卡里球还没贴到
          // 侧壁就已经被判成靠边，脱困方向会一直往盘心推，窄盘关卡则几乎不触发。
          const edge = this.stage.width / 2 - 1.8;
          const dir = Math.abs(this.ballX) > edge ? -Math.sign(this.ballX) : this.rng() < 0.5 ? -1 : 1;
          this.body.applyImpulse({ x: dir * 8, y: -2 }, true);
        }
      }
    }
    if (this.ballY < -1.5 || this.outOfBounds()) {
      this.finishBall('out');
      return;
    }
    if (this.ballAge > this.ballBudget * this.ballScale) this.finishBall('timeout');
  }

  /**
   * 球飞出盘面了吗。
   *
   * 判据**不能**用 `stage.width / 2`：那个宽度已经把弹射道算进去了，
   * 球在道里就永远超过它 —— 第一版就是这里出的错，stage_07 机台总宽 11.04、
   * 阈值 7.52，而球道中心在 x=8.19，于是球一离开发射道就在第 0 步被判 `done`，
   * 12 关全关且现象是「球纹丝不动」。
   *
   * 正确做法是分开算：球在**主盘**里就用主盘右缘判，球在**球道**里就拿球道外壁判，
   * 两条通道各自成立才算出界。
   */
  private outOfBounds(): boolean {
    const p = this.stage.plunger;
    // 球道纵向范围：道底到拐弯板。球在这段里就按球道外壁判
    const inLane = this.ballX > p.innerX && this.ballX < p.outerX;
    if (inLane) return this.ballX > p.outerX + 1.2;
    // 主盘左右缘 + 一点缓冲（导流罩之类贴边的装饰不参与判定）
    //
    // `playLeftX` 存的是**左缘的正值幅度**（`buildPlunger` 里是 `-left`），
    // 拿它直接和 ballX 比会在盘中央就判出界：`stage_04` 的 `playLeftX` 是 7.92，
    // 判据变成 `ballX < 6.32`，球从交汇处横穿主盘时在半路就被判 `out`。
    // 侧壁用的是 `-playLeftX - 0.35`（x=−8.27），判据必须和它同一个符号约定。
    return this.ballX > this.stage.playRightX + 1.6 || this.ballX < -this.stage.playLeftX - 1.6;
  }

  /* ------------------------------------------------------------ 指令执行 */

  /** 把模拟层产出的指令真正落到物理世界上 —— 技能因此能改写盘面规则。 */
  apply(cmd: SimCommand): void {
    switch (cmd.t) {
      case 'restorePegs': {
        for (const id of cmd.pegIds) {
          const meta = this.pegById.get(id);
          if (!meta || meta.alive || meta.kind !== 'enemy') continue;
          meta.collider = this.physics.createPeg(meta.x, meta.y, meta.r,
            { role: 'peg', id: meta.id, kind: meta.kind, destructible: false });
          meta.alive = true;
          meta.hp = meta.maxHp;
          meta.ghosted = false;
          this.lastHitAt.delete(id);
        }
        this.refreshGhosts();
        this.hooks.onPegVisuals?.();
        break;
      }
      case 'destroyPegs': {
        let n = 0;
        for (const id of cmd.pegIds) {
          const meta = this.pegById.get(id);
          if (!meta || !meta.alive) continue;
          meta.alive = false;
          meta.ghosted = false;
          this.physics.removeCollider(meta.collider);
          n++;
        }
        if (n > 0) this.hooks.onPegVisuals?.();
        break;
      }
      case 'setGhostKinds': {
        if (cmd.kinds.length === 0) this.ghostChannels.delete(cmd.channel);
        else this.ghostChannels.set(cmd.channel, { kinds: new Set(cmd.kinds), until: this.channelUntil(cmd.duration) });
        this.refreshGhosts();
        break;
      }
      case 'setGravityScale': {
        if (cmd.scale === 1) this.gravityChannels.delete(cmd.channel);
        else this.gravityChannels.set(cmd.channel, { scale: cmd.scale, until: this.channelUntil(cmd.duration) });
        this.physics.gravityScale = this.gravityProduct();
        break;
      }
      case 'setSpeedScale': {
        if (cmd.scale === 1) this.speedChannels.delete(cmd.channel);
        else this.speedChannels.set(cmd.channel, { scale: cmd.scale, until: this.channelUntil(cmd.duration) });
        break;
      }
      case 'setBounceScale': {
        if (cmd.scale === 1) this.bounceChannels.delete(cmd.channel);
        else this.bounceChannels.set(cmd.channel, { scale: cmd.scale, until: this.channelUntil(cmd.duration) });
        this.applyBounce();
        break;
      }
      case 'setDampingScale': {
        if (cmd.scale === 1) this.dampingChannels.delete(cmd.channel);
        else this.dampingChannels.set(cmd.channel, { scale: cmd.scale, until: this.channelUntil(cmd.duration) });
        this.applyDamping();
        break;
      }
      case 'setSpeedFloor': {
        if (cmd.floor <= 0) this.floorChannels.delete(cmd.channel);
        else this.floorChannels.set(cmd.channel, { floor: cmd.floor, until: this.channelUntil(cmd.duration) });
        break;
      }
      case 'setForce': {
        if (cmd.ax === 0 && cmd.ay === 0) this.forceChannels.delete(cmd.channel);
        else this.forceChannels.set(cmd.channel, { ax: cmd.ax, ay: cmd.ay, until: this.channelUntil(cmd.duration) });
        break;
      }
      case 'boostBall': {
        if (this.body && this.ballState === 'live') {
          const len = Math.hypot(cmd.dirX, cmd.dirY) || 1;
          this.body.applyImpulse(
            { x: (cmd.dirX / len) * cmd.impulse, y: (cmd.dirY / len) * cmd.impulse },
            true,
          );
        }
        break;
      }
      case 'bossPhase': {
        // 先整份收回再按新的剥夺重下：相位是**替换**不是叠加，
        // 逐项设回去漏掉一项，玩家就会带着一条隐形惩罚打完剩下半局。
        this.aimDriftMult = 1;
        this.aimDriftSpeed = 1;
        this.weakScale = 1;
        this.ballScale = 1;
        this.rescueClosed = false;
        this.noRescue = false;
        this.ballTimeScale = 1;
        this.lateralG = 0;
        this.cameraShake = 0;
        this.physics.lateralGravity = 0;
        const k = cmd.knobs;
        if (cmd.deprive.includes('aim')) {
          this.aimDriftMult = k.aim?.driftMult ?? 1;
          this.aimDriftSpeed = k.aim?.driftSpeed ?? 1;
          this.weakScale = k.aim?.weakScale ?? 1;
        }
        if (cmd.deprive.includes('ammo')) {
          this.ballScale = k.ammo?.ballScale ?? 1;
          this.rescueClosed = k.ammo?.noRescue === true;
          this.noRescue = this.rescueClosed;
          this.ballTimeScale = this.ballScale;
          if (this.rescueClosed) {
            // 窗口在相位切换**那一刻**就没了：不能等球慢下来再说，
            // 否则玩家会以为「我刚才那一下应该还能救」。
            this.rescueReserved = false;
            this.ready = false;
          }
        }
        if (cmd.deprive.includes('time')) {
          this.lateralG = k.time?.lateralG ?? 0;
          this.lateralHz = k.time?.lateralHz ?? 2.4;
          this.cameraShake = k.time?.cameraShake ?? 0;
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * 通道的到期时刻。**`duration === 0` 表示整局常驻**。
   *
   * 这条语义在 BattleSim 侧一直成立（`applyRecipe` 存 `left = 0`，
   * 到期清理里 `if (m.duration <= 0) continue`），但物理层以前没跟上：
   * 它直接 `until = clock + duration`，`duration 0` 让 `until === clock`，
   * 而清理判据是 `until <= clock`——**开局那一帧就把通道删了**。
   *
   * 症状极有欺骗性：命令确实下发过（`pushChannel` 正常返回），
   * `snapshot` 之外的任何断言都看不出问题，只有跑够时间再读物理量才会露馅。
   * 被动技能第一次用 `duration 0` 就踩到了，所以这里统一收口：
   * 所有通道的 `until` 都必须过这一个函数，不要再直接算。
   */
  private channelUntil(duration: number): number {
    return duration > 0 ? this.clock + duration : Infinity;
  }

  private expireChannels(): void {
    let ghostDirty = false;
    for (const [k, c] of [...this.ghostChannels]) {
      if (c.until <= this.clock) {
        this.ghostChannels.delete(k);
        ghostDirty = true;
      }
    }
    for (const [k, until] of [...this.escapeGhosts]) {
      if (until <= this.clock) {
        this.escapeGhosts.delete(k);
        ghostDirty = true;
      }
    }
    if (ghostDirty) this.refreshGhosts();

    for (const [k, c] of [...this.speedChannels]) {
      if (c.until <= this.clock) this.speedChannels.delete(k);
    }
    for (const [k, c] of [...this.bounceChannels]) {
      if (c.until <= this.clock) {
        this.bounceChannels.delete(k);
        this.applyBounce();
      }
    }
    for (const [k, c] of [...this.dampingChannels]) {
      if (c.until <= this.clock) {
        this.dampingChannels.delete(k);
        this.applyDamping();
      }
    }
    for (const [k, c] of [...this.floorChannels]) {
      if (c.until <= this.clock) this.floorChannels.delete(k);
    }
    for (const [k, c] of [...this.forceChannels]) {
      if (c.until <= this.clock) this.forceChannels.delete(k);
    }
    let gDirty = false;
    for (const [k, c] of [...this.gravityChannels]) {
      if (c.until <= this.clock) {
        this.gravityChannels.delete(k);
        gDirty = true;
      }
    }
    if (gDirty) this.physics.gravityScale = this.gravityProduct();
  }

  private refreshGhosts(): void {
    const kinds = new Set<PegKind>();
    for (const c of this.ghostChannels.values()) for (const k of c.kinds) kinds.add(k);
    for (const p of this.pegs) {
      if (!p.alive) continue;
      const ghost = kinds.has(p.kind) || this.escapeGhosts.has(p.id);
      if (ghost === p.ghosted) continue;
      p.ghosted = ghost;
      p.collider.setEnabled(!ghost);
    }
  }

  /**
   * 脱困：球在阵型形成的几何死角里彻底静止时，临时把身边的钉板虚化一小会儿，
   * 让球自然穿过去继续下落。
   *
   * 为什么不只靠给冲量：像十字阵/横墙这类密排钉阵会形成完美局部极小值，
   * 球被两侧钉的接触法线夹住后，任何冲量都只会把它原路弹回同一个坑里。
   * 虚化是唯一不破坏物理、又能保证任意阵型（含未来 108 关的新阵型）必然收敛的手段。
   *
   * **虚化的同时必须给一个向下的初速**，否则脱困不彻底：
   * 只虚化钉子而球自己不动，重力虽然会拉它下落，但**下面还有钉子接着**——
   * 实测 stage_02 球卡在装甲钉轨（rail pegs 间距 0.96bu < 球径 0.66，刻意不可穿越）
   * 的锯齿凹口里，钉板虚化 0.35s、球掉下去又被正下方那颗敌人钉顶回同一个凹口，
   * 来回 9.5 秒直到超时。给一个确定的向下初速，球才会真的穿过虚化窗口落下去。
   *
   * 反复卡在同一处的球，脱困窗口逐次加倍（封顶 4 倍）：
   * 一次脱困不管用说明这个坑比想象的深，第二次就该给它更长的时间。
   */
  private escapeTrap(): void {
    const reach = PHYSICS.ballRadius + PHYSICS.escapeReach;
    let touched = 0;
    for (const p of this.pegs) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - this.ballX, p.y - this.ballY);
      if (d > reach + p.r) continue;
      this.escapeGhosts.set(p.id, this.clock + PHYSICS.escapeGhostDuration * this.escapeBoost);
      touched++;
    }
    if (touched > 0) {
      this.refreshGhosts();
      this.escapeBoost = Math.min(4, this.escapeBoost * 2);
      // 让球在钉板虚化期间真的往下走，而不是停在原地等下一颗钉来接
      this.body?.setLinvel({ x: this.ballVX * 0.3, y: -PHYSICS.escapeDropSpeed }, true);
      this.escapes++;
      this.hooks.onEvent?.({ t: 'escape', x: this.ballX, y: this.ballY });
    } else {
      // 身边一根钉都没有还卡住：不是钉阵死角，是被墙/导流板夹住了。
      // 这时候加倍也等不到钉子虚化，只能靠更大的向下初速硬挤出去。
      this.escapeBoost = Math.min(4, this.escapeBoost * 2);
      this.body?.setLinvel({ x: this.ballVX * 0.3, y: -PHYSICS.escapeDropSpeed * 2 }, true);
    }
  }

  private speedProduct(): number {
    let f = 1;
    for (const c of this.speedChannels.values()) f *= c.scale;
    return f;
  }

  /** 恢复系数：基准 0.3 × 各弹性通道连乘。超过 1 会抖动，所以夹住。 */
  private applyBounce(): void {
    if (!this.ballCollider) return;
    let f = 1;
    for (const c of this.bounceChannels.values()) f *= c.scale;
    this.ballCollider.setRestitution(clamp(PHYSICS.ballRestitution * f, 0, 0.96));
  }

  private applyDamping(): void {
    if (!this.body) return;
    let f = 1;
    for (const c of this.dampingChannels.values()) f *= c.scale;
    // 技能改的是**盘面**阻尼。球在弹射道里时要让位给 `PLUNGER.laneDamping`，
    // 否则技能的「降低阻尼」会把道内也一起改掉，力度曲线又歪了。
    const inLane = this.inLane;
    this.baseDamping = clamp(PHYSICS.ballLinearDamping * f, 0, 4);
    this.body.setLinearDamping(inLane ? PLUNGER.laneDamping : this.baseDamping);
  }

  private speedFloor(): number {
    let m = 0;
    for (const c of this.floorChannels.values()) if (c.floor > m) m = c.floor;
    return m;
  }

  /**
   * 持续外力。必须每帧 resetForces 后重加：
   * Rapier 的力在 step 之后不会自动清零，不重置的话力会一路累加成轨道炮。
   */
  private applyForce(): void {
    if (!this.body) return;
    let ax = 0;
    let ay = 0;
    for (const c of this.forceChannels.values()) {
      ax += c.ax;
      ay += c.ay;
    }
    this.body.resetForces(false);
    if (ax === 0 && ay === 0) return;
    const m = this.body.mass() || 1;
    this.body.addForce({ x: ax * m, y: ay * m }, true);
  }

  private gravityProduct(): number {
    let f = 1;
    for (const c of this.gravityChannels.values()) f *= c.scale;
    return f;
  }

  /* -------------------------------------------------------------- 事件流 */

  private handleImpact(colliderId: string, kind: string, intensity: number, x: number, y: number): void {
    if (this.ballState !== 'live') return;
    // 物理求解器在同一接触上会高频抖动，去重掉 0.35 单位内的重复撞击，避免连击数虚高
    const prev = this.lastHitAt.get(colliderId);
    if (prev) {
      const dx = x - prev.x;
      const dy = y - prev.y;
      if (dx * dx + dy * dy < 0.1225) return;
    }
    this.lastHitAt.set(colliderId, { x, y });
    this.emit({ t: 'pegHit', pegId: colliderId, pegKind: kind as PegKind, intensity, x, y });
  }

  private handleCollide(a: ColliderTag | undefined, b: ColliderTag | undefined, started: boolean): void {
    if (this.ballState !== 'live') return;
    const other = a?.role === 'ball' ? b : b?.role === 'ball' ? a : undefined;
    if (!other) return;

    if (other.role === 'recovery') {
      if (started) this.emit({ t: 'recoveryEnter', x: this.ballX, y: this.ballY });
      return;
    }

    if (other.role === 'sensor') {
      const z = this.zones.find((v) => v.id === other.id);
      if (z) {
        z.inside = started;
        if (started) {
          z.glow = 1;
          this.emit({ t: 'zoneEnter', zoneId: z.id, kind: z.kind, x: this.ballX, y: this.ballY });
        }
      }
      return;
    }

    // 確変口：按触发槽的 id 与数值结算，玩家看到的就是「中央口被吃进去了」
    if (other.role === 'fever' && started) {
      if (!this.feverGateOn) return;
      const s = this.slots.find((v) => v.id === other.id);
      if (!s) return;
      s.flash = 1;
      this.emit({
        t: 'slotEnter',
        slotId: s.id,
        kind: s.kind,
        value: s.value,
        weak: true,
        viaFever: true,
        x: this.ballX,
        y: this.ballY,
      });
      this.finishBall('slot');
      return;
    }

    if (other.role === 'slot' && started) {
      const s = this.slots.find((v) => v.id === other.id);
      if (!s) return;
      s.flash = 1;
      const wp = this.weakCircle();
      const weak = Math.hypot(this.ballX - wp.x, this.ballY - wp.y) < wp.r + 0.15;
      this.emit({
        t: 'slotEnter',
        slotId: s.id,
        kind: s.kind,
        value: s.value,
        weak,
        x: this.ballX,
        y: this.ballY,
      });
      /*
       * 这里**必须**直接 finishBall：球一进 sensor 就收掉，是 battle 能正常
       * 结算的硬条件。改成「先结算、球再沉一会儿」会让球多活 0.2 秒，
       * 期间 ballState 一直是 live —— 一旦这颗是场上最后一颗、或者沉降判据
       * 失效（兜底被别的东西挡住），phase 就永远推进不到胜利，画面卡在战斗里。
       * 落槽观感要改，改这里以外的地方（入替区 / 滚落钉排），不要动结算时序。
       */
      this.finishBall('slot');
    }
  }

  private emit(ev: BattleEvent): void {
    this.hooks.onEvent?.(ev);
  }

  /** 结束当前球。timeout 时按 x 就近结算到一个槽，避免玩家空等。 */
  private finishBall(reason: 'slot' | 'out' | 'timeout'): void {
    if (this.ballState !== 'live') return;
    this.ballState = 'done';
    this.rescueReserved = false;
    this.endReason[reason]++;
    if (reason === 'timeout') {
      const p = this.stage.plunger;
      this.timeoutSpots.push({
        x: Number(this.ballX.toFixed(1)),
        y: Number(this.ballY.toFixed(1)),
        vx: Number(this.ballVX.toFixed(1)),
        vy: Number(this.ballVY.toFixed(1)),
        inLane: this.ballX > p.innerX - 0.2,
        laneStalls: this.laneStalls,
        pending: this.launchPending,
        fired: this.exitFired,
        state: this.ballState,
      });
    }
    this.totalBallAge += this.ballAge;
    this.finishedBalls++;
    if (this.body) {
      this.body.setLinvel({ x: 0, y: 0 }, true);
      this.body.setGravityScale(0, true);
      this.body.setEnabled(false);
    }
    if (reason === 'timeout') this.settleToNearestSlot();
    this.emit({ t: 'ballRetired', x: this.ballX, y: this.ballY });
  }

  /**
   * 球没能自己落进任何一口（超时 / 停太久 / 掉出盘外）时，按 x 就近强制结算。
   *
   * 抽出来是因为它现在有两个调用点：超时和「球停了太久」。
   * 后者是「可再射」机制的必要代价——允许玩家无限次击射，就必须有一条
   * 「你不动我就替你结算」的兜底，否则玩家会一直赖在盘上刷时间。
   *
   * `endReason` 不记这一类：它是玩家操作的结果，不是关卡布局的缺陷，
   * 混进 timeout 里会让布局探针误报死角。
   */
  private settleToNearestSlot(): void {
    let best: SlotSensor | null = null;
    let bd = Infinity;
    for (const s of this.slots) {
      const d = Math.abs(s.cx - this.ballX);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    if (!best) return;
    best.flash = 1;
    const wp = this.weakCircle();
    const weak = Math.hypot(best.cx - wp.x, this.ballY - wp.y) < wp.r + 0.7;
    this.emit({
      t: 'slotEnter',
      slotId: best.id,
      kind: best.kind,
      value: best.value,
      weak,
      x: this.ballX,
      y: this.ballY,
    });
  }

  dispose(): void {
    this.physics.onImpact = [];
    this.physics.onCollide = [];
  }
}



