import type { PegKind, PhaseDeprivation, PhaseKnobs, SlotKind, ZoneKind } from '../data/schema.ts';
import type { StrikePrimitive } from './strike.ts';

export interface StrikePreview {
  charId: string;
  name: string;
  color: string;
  primitives: StrikePrimitive[];
  targets: { pegId: string; x: number; y: number; r: number; hp: number; damage: number; kill: boolean }[];
  /** Effective enemy HP loss, excluding overkill. Not Boss damage. */
  totalDamage: number;
  totalKills: number;
  angleDeg: number;
  x: number;
  y: number;
}

/* ------------------------------------------- 运行时 → 模拟层 的输入事件 */

export type BattleEvent =
  | { t: 'recoveryEnter'; x: number; y: number }
  /**
   * 击射。`followUp` 为 true 表示这是追打（球已经在盘上），不是首发。
   *
   * 区分它是因为 sim 要按「首发 / 补射」给不同反馈：
   * 首发是「这一局开始」，补射是「你又救回来一次」——后者该更响。
   */
  | { t: 'launch'; power: number; angleDeg: number; x: number; y: number; followUp?: boolean }
  | { t: 'pegHit'; pegId: string; pegKind: PegKind; intensity: number; x: number; y: number }
  /**
   * 玩家按下翻板并**打到了球**。只在真的打中时发，按空不���。
   *
   * 为什么要区分「按了」和「打到了」：前者是玩家意图（可以有，可以落空），
   * 后者是既成事实。Runtime 只在后者上播特效和音效，玩家才不会对着空气
   * 听到「砰」一声却什么也没发生。`side` 用来挑左板 / 右板的动画与音高。
   */
  | { t: 'flipperHit'; side: 'left' | 'right'; x: number; y: number; power: number; timeRefund: number }
  | { t: 'zoneEnter'; zoneId: string; kind: ZoneKind; x: number; y: number }
  | { t: 'slotEnter'; slotId: string; kind: SlotKind; value: number; weak: boolean; x: number; y: number; viaFever?: boolean }
  /** 球卡在阵型死角被脱困机制救出：Runtime 用它播放提示特效 */
  | { t: 'escape'; x: number; y: number }
  | { t: 'ballRetired'; x: number; y: number };

/* ------------------------------------------- 模拟层 → 运行时 的执行指令 */

export type SimCommand =
  | { t: 'strike'; preview: StrikePreview }
  | { t: 'restorePegs'; pegIds: string[] }
  | { t: 'destroyPegs'; pegIds: string[]; reason: string }
  /**
   * 敌人钉剩余血量比例。敌人钉是全盘唯一的「撞得越久打越疼」的输出源，
   * 但它血掉到哪一步原来只有一瞬飘字——击坠这个最大的正反馈在画面上是凭空发生的。
   * 这条指令让血弧常驻在钉子上，「这颗快爆了，接着撞它」变成看得见的事。
   */
  | { t: 'enemyHp'; pegId: string; ratio: number }
  | { t: 'setGhostKinds'; channel: string; kinds: PegKind[]; duration: number }
  | { t: 'setGravityScale'; channel: string; scale: number; duration: number }
  | { t: 'setSpeedScale'; channel: string; scale: number; duration: number }
  /**
   * 碰撞恢复系数倍率。怪物弹珠的伤害公式是「撞得越久打越疼」，
   * 恢复系数就是反弹次数的开关，所以它必须是一条独立通道，不能折进速度里。
   */
  | { t: 'setBounceScale'; channel: string; scale: number; duration: number }
  /** 线性阻尼倍率。<1 = 球不容易被磨停 */
  | { t: 'setDampingScale'; channel: string; scale: number; duration: number }
  /** 球速下限，防止球在阵型死角几乎静止 */
  | { t: 'setSpeedFloor'; channel: string; floor: number; duration: number }
  /** 持续外力（恒定加速度），用来把球往某个方向"推"而不是改它的物理参数 */
  | { t: 'setForce'; channel: string; ax: number; ay: number; duration: number }
  | { t: 'boostBall'; dirX: number; dirY: number; impulse: number }
  /**
   * 演出指令。`text` 纯粹是给人看的一句话，`value` 才是这一下的实际数值。
   *
   * 分开的原因是实测踩过的坑：smoke 原来靠 `text.replace(/[^\d.-]/g,'')` 从
   * 「+818」里抠数字来断言伤害公式，文案一改（「3弹 154」）抠出来就成了 3154，
   * 一条硬校验红得莫名其妙。数值必须有一条和文案无关的路可走，
   * 否则 UI 每次改措辞都会连带把规则校验带崩。
   */
  | { t: 'fx'; fx: string; x: number; y: number; text?: string; color?: string; scale?: number; value?: number }
  | { t: 'shake'; amount: number; duration: number }
  | { t: 'flash'; color: string; duration: number }
  | { t: 'sound'; name: 'skill' | 'link' | 'bossHit' | 'slot' | 'zone' | 'charge' | 'deny' | 'shot' | 'flipper' | 'comboHit'; value?: number }
  /**
   * Boss 进入新阶段：runtime 必须真的改写盘面（漂移落槽 / 压球时 / 加横向重力）。
   *
   * `knobs` 是**解算后的档位**（数据里的 `over` 已和 constants 的默认值合并过），
   * 物理层不该也不需要再去读 stage 数据算一遍——它只要照着执行。
   */
  | { t: 'bossPhase'; index: number; name: string; deprive: PhaseDeprivation[]; knobs: PhaseKnobs }
  /** 確変口开合：runtime 必须真的搬动那张看不见的嘴，Sim 单方面宣布等于没触发 */
  | { t: 'feverGate'; on: boolean }
  | { t: 'ghostTimers'; seconds: number };

export interface GaugeState {
  charId: string;
  value: number;
  max: number;
}

export interface BuffState {
  key: string;
  label: string;
  color: string;
  left: number;
  duration: number;
  mult: number;
}

export interface LinkState {
  linkId: string;
  name: string;
  color: string;
  active: boolean;
  left: number;
  duration: number;
  cooldown: number;
  /** 玩家已锁定：条件满足也不会自动触发，用于攒三卡 Ultimate */
  locked: boolean;
  /** 条件当前是否已满足（供 UI 提示「可以触发了」） */
  armed: boolean;
}

export interface FeverState {
  /** 確変进行中 */
  active: boolean;
  /** 剩余秒数 */
  left: number;
  duration: number;
  /** 当前连打档位（0 起，封顶 fever.chainMax） */
  chain: number;
  /** 当前落槽倍率：基础 slotFactor 每档叠 chainStep */
  mult: number;
  /** 本次確変期间的累计连打 */
  renda: number;
  /** 全局最高连打 */
  best: number;
  /** 触发了几次確変 */
  times: number;
}

export interface EnemyState {
  /** 击坠数 */
  killed: number;
  /** 盘上还剩几个敌人 */
  alive: number;
  /** 小怪总数。HUD 用它和 alive 拼成「清空 3/5」 */
  total: number;
  /**
   * 清空进度换来的 Boss 伤害倍率（1.0 = 一枚没清）。
   * 小怪是独立目标，清空它们才让打 Boss 这件事变得划算——这个数就是那条反馈。
   */
  sweepMult: number;
  /** 本球已反弹次数（伤害公式的主变量） */
  bounces: number;
  /** 单球最高反弹次数 */
  maxBounces: number;
  /**
   * 本球此刻撞中敌人钉的**基准伤害**（baseDamage + perBounce × 反弹数，已算上
   * 反弹上限和 bounceDamage 增益，不含撞击强度 / 五行相性 / 会心）。
   *
   * 由 Sim 算好再往外发，UI 绝不能自己抄一遍公式——抄一份就会和结算各走各的。
   */
  hitDamage: number;
  /** 球的五行（克制关系用） */
  wuxing: string;
  /**
   * 球的五行键（金/木/水/火/土），UI 靠它取色块颜色。
   *
   * 只给 `wuxing` 那个中文标签是不够的：盘面上敌人钉是靠**颜色**认属性的，
   * 说明条必须用同一个 `WUXING_HEX` 才能和盘面对上号。
   */
  wuxingKey: string;
  /**
   * 本球是否已经飞过中区「破绽标记」带。
   *
   * 少了这一条，玩家在盘面上永远看不出「这颗球带着破绽」，于是那个 ×1.5
   * 就是一个凭空多出来的数字。这是要上盘面的实时状态，不是内部记账。
   */
  marked: boolean;
}

export interface BattleSnapshot {
  weapon: { casts: number; hits: number; damage: number; kills: number; bossDamage: number };
  recovery: { charge: number; max: number; perEntry: number; restorations: number; pulse: number };
  phase: 'playing' | 'victory' | 'defeat';
  bossHp: number;
  bossMaxHp: number;
  bossArmor: number;
  bossPhaseName: string;
  bossPhaseIndex: number;
  /**
   * 当前相位施加的剥夺。**这是「Boss 现在拿走了什么」的唯一权威来源**：
   * HUD 的倒计时变红、救球窗口关闭提示、盘面提示条全都读它，
   * 各自再抄一份判据就会出现「界面说关了、物理没关」。
   */
  phaseDeprivation: {
    list: PhaseDeprivation[];
    /** 本球球时倍率（1 = 没被压缩） */
    ballScale: number;
    /** 破绽判定半径倍率 */
    weakScale: number;
    /** 追打救球窗口是否关闭 */
    noRescue: boolean;
    /** 横向重力振幅（0 = 没在推） */
    lateralG: number;
  };
  combo: number;
  comboMult: number;
  comboTimer: number;
  energy: number;
  energyMax: number;
  ballsLeft: number;
  ballsTotal: number;
  ballInPlay: boolean;
  gauges: GaugeState[];
  buffs: BuffState[];
  links: LinkState[];
  score: number;
  totalDamage: number;
  slotsHit: number;
  pegHits: number;
  maxCombo: number;
  pierced: number;
  detonated: number;
  destroyedPegs: number;
  elapsed: number;
  lastSlotLabel: string;
  lastDamage: number;
  /** 本球已撞过的万金钉数；HUD 拿它常驻显示「本球 万金 ×N」 */
  goldHits: number;
  /** 实际落槽倍率（标准口 / 正中破绽口），均已受总倍率上限约束。 */
  slotMultiplier: number;
  weakSlotMultiplier: number;
  pendingNextMultiplier: number;
  fever: FeverState;
  enemy: EnemyState;
  log: string[];
}

export interface BallControlState {
  state: 'idle' | 'live' | 'done';
  secondsLeft: number;
  canShoot: boolean;
  rescueHeld: boolean;
  /** 救球窗口被 ammo 相位关闭。UI 要把「不能救」说出来，而不是让金环默默不亮 */
  noRescue: boolean;
}
