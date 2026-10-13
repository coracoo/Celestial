import { COMBAT, PHASE } from '../core/constants.ts';
import {
  DEPRIVATION_HINT,
  DEPRIVATION_LABEL,
  PHYS_KEY_LABEL,
  WUXING_HEX,
  WUXING_LABEL,
  wuxingTier,
  type BossPhaseDef,
  type CharacterDef,
  type LinkCondition,
  type LinkDef,
  type LinkEffect,
  type PegKind,
  type PegDef,
  type PhaseKnobs,
  type AimKnobs,
  type AmmoKnobs,
  type TimeKnobs,
  type PhysKey,
  type StackEvent,
  type Wuxing,
} from '../data/schema.ts';
import type { ExpandedStage } from './board.ts';
import type { BattleEvent, BattleSnapshot, GaugeState, LinkState, SimCommand, StrikePreview } from './types.ts';
import { buildStrikePrimitives, pegsInStrike } from './strike.ts';
import { enemyCardFor } from '../data/EnemyCards.ts';

/**
 * 一枚正在生效的旋钮。
 *
 * 这里是整个技能系统的全部实现：Runtime 不认识「狂暴」「贯穿」「震荡」，
 * 只认识一堆带倒计时的 `PhysKey` 乘区。加第 108 个角色时这里一行都不用动。
 */
interface ActiveMod {
  charId: string;
  key: PhysKey;
  /** 当前生效值（基础值 + 事件叠加上限内） */
  value: number;
  /** 事件叠加的步长与上限 */
  perEvent: number;
  maxValue: number;
  stackOn: StackEvent | null;
  left: number;
  duration: number;
}

/** 穿通透��。多张卡同时开穿透时按伤害相加，不互相覆盖。 */
interface ActivePierce {
  charId: string;
  left: number;
  duration: number;
  damagePerPeg: number;
  kinds: PegKind[];
}

/** 链���引爆。 */
interface ActiveChain {
  charId: string;
  left: number;
  radius: number;
  damage: number;
  wuxing: Wuxing;
}

/** 一次性加法旋钮（会心率、能量）。不参与叠乘，释放瞬间结算一次。 */
const ADDITIVE_KEYS: ReadonlySet<PhysKey> = new Set<PhysKey>(['critChance', 'energy']);

/** 需要真正下发到物理层的通道。伤害类旋钮只在结算里读，不进通道表。 */
const PHYSICS_KEYS: ReadonlySet<PhysKey> = new Set<PhysKey>([
  'gravity',
  'speed',
  'speedFloor',
  'bounce',
  'damping',
]);


interface ActiveLink {
  left: number;
  duration: number;
  slotFactor: number;
  chainDetonate: boolean;
  detonateDamage: number;
  destroyRadius: number;
}

function rank(link: LinkDef): number {
  return link.tier === 'triple' ? 2 : 1;
}

/**
 * 纯逻辑战斗模拟。不引用 Three.js / Rapier，因此可以在 Node 里无头跑冒烟测试。
 * 输入 BattleEvent，输出 SimCommand；真正的物理改写由 BattleScene 执行指令完成。
 */
export class BattleSim {
  readonly stage: ExpandedStage;
  readonly team: CharacterDef[];
  readonly links: LinkDef[];

  readonly gauges: GaugeState[] = [];
  private readonly destroyed = new Set<string>();
  /**
   * 待下发的被动角色。构造函数填、第一次 update 消费。
   * 见 update() 里那段注释——不在构造函数下发是因为那时物理层还没建好。
   */
  private pendingPassives: CharacterDef[] = [];

  private readonly mods = new Map<string, ActiveMod>();
  private readonly pierces = new Map<string, ActivePierce>();
  private readonly chains = new Map<string, ActiveChain>();

  private readonly active = new Map<string, ActiveLink>();
  private readonly linkCooldown = new Map<string, number>();
  private readonly lockedLinks = new Set<string>();

  private combo = 0;
  private comboTimer = 0;
  /** 最近一次撞到的钉类型：spearHit 触发要靠它判断，充能入口拿不到 pegKind */
  private lastPegKind: PegKind = 'normal';
  private energy = 0;
  private bossHp: number;
  private bossVulnLeft = 0;
  private bossVulnFactor = 1;
  /** 被动角色带来的常驻破防：一旦为真就不再倒计时（见 update 里那段注释） */
  private passiveVuln = false;
  private phaseIndex = -1;
  private phaseName = '镇守';
  private phase: 'playing' | 'victory' | 'defeat' = 'playing';

  /** Boss 已倒但小怪未清时，只播一次的提示，避免每帧刷日志 */
  private cleansingAnnounced = false;

  private ballsLeft: number;
  private ballInPlay = false;
  private ballSlotFactor = 1;
  private ballNextFactor = 1;
  private pendingNextFactor = 1;
  private recoveryCharge = 0;
  private recoveries = 0;
  private recoveryPulse = 0;
  private ballBossMark = false;
  /** 本球撞过几枚万金钉。每撞一枚给 `COMBAT.goldenPegMult` 倍落槽，只对当球生效。 */
  private ballGoldHits = 0;
  /** 技能的 wuxingShift 临时改写球的五行；每发新球时清空 */
  private ballWuxingOverride: Wuxing | null = null;

  /*
   * 確変。真柏青哥的刺激不在「中一次」，而在「口一直开着」——
   * 一旦中央口吃进球，接下来十几秒每颗球都还有机会被吃进去，而且倍率随连打一路叠上去。
   * 玩家追的是连打数，不是单次结算。
   */
  private feverLeft = 0;
  private feverChain = 0;
  private feverRenda = 0;
  private feverBest = 0;
  private feverTimes = 0;
  /** 追加球是否已经发放过。一局只发一次，由独立标记把关，不依赖 feverTimes。 */
  private feverBonusGiven = false;

  /** 敌人钉剩余血量：pegId → hp */
  private readonly enemyHp = new Map<string, number>();
  private enemiesKilled = 0;
  /**
   * 「全部清空」的那一次额外伤害是否已经发过。
   *
   * 必须记而不是靠 `sweptCount === total` 判断：恢复池会把打倒的五行靶点**复活**
   * （`onRecoveryEnter`），清空 → 复活 → 再清空会再触发一次，那一笔白送的 Boss 伤害
   * 就变成了可重复刷的。
   */
  private fullSweepFired = false;
  /** 本局翻板成功回击次数。只用于结算展示和 HUD，不参与任何伤害计算。 */
  private flipperHits = 0;
  /** 组合技剩余段数 / 距下一段的倒计时 / 已放段数（决定这次是第几段） */
  private comboLeft = 0;
  private comboSeqTimer = 0;
  private comboFired = 0;
  /**
   * 球最近一次被系统看到的位置。
   *
   * 组合技是**自动**触发的，它自己不知道球在哪；翻板、组合技的飘字
   * 都得落在球身上才读得懂。盘面上任何一个事件都带坐标，
   * 在这里记一笔是唯一能让「自动机制也知道球在哪」的办法。
   */
  private lastBallX = 0;
  private lastBallY = 10;
  private readonly weapon = { casts: 0, hits: 0, damage: 0, kills: 0, bossDamage: 0 };
  /** 本球已经反弹过几次：伤害公式的主变量 */
  private ballBounces = 0;
  private maxBounces = 0;

  private score = 0;
  private totalDamage = 0;
  private slotsHit = 0;
  private pegHits = 0;
  private maxCombo = 0;
  private pierced = 0;
  private detonated = 0;
  private elapsed = 0;
  private lastSlotLabel = '';
  private lastDamage = 0;
  private readonly log: string[] = [];

  constructor(stage: ExpandedStage, team: CharacterDef[], links: LinkDef[]) {
    this.stage = stage;
    this.team = team;
    this.links = links.filter((l) => l.members.every((m) => team.some((c) => c.id === m)));
    for (const c of team) {
      // 被动角色不占充能条：max 记 0，UI 读它就知道「这人没有进度条、也没有键位」。
      // 不这么做的后果是它会顶着一个永远填不满的条，玩家看着像坏了——正是这次要修的病。
      const passive = c.skill.trigger.auto === true;
      this.gauges.push({
        charId: c.id,
        value: 0,
        max: passive ? 0 : Math.max(1, Math.ceil(c.skill.trigger.charges * (stage.rules.skillChargeScale ?? 1))),
      });
      if (passive) this.pendingPassives.push(c);
    }
    this.bossHp = stage.boss.maxHp;
    this.ballsLeft = stage.rules.balls;
    this.energy = stage.rules.startingEnergy;
    this.pushLog(`${stage.name} · 参战 ${team.map((c) => c.name).join('、')}`);
  }

  /* ------------------------------------------------------------- 外部查询 */

  snapshot(): BattleSnapshot {
    return {
      weapon: { ...this.weapon },
      recovery: { charge: this.recoveryCharge, max: this.stage.recovery.threshold,
        perEntry: this.stage.recovery.perEntry, restorations: this.recoveries, pulse: this.recoveryPulse },
      phase: this.phase,
      bossHp: Math.round(this.bossHp),
      bossMaxHp: this.stage.boss.maxHp,
      bossArmor: this.effectiveArmor(),
      bossPhaseName: this.phaseName,
      bossPhaseIndex: this.phaseIndex,
      phaseDeprivation: this.phaseDeprivationState(),
      combo: this.combo,
      comboMult: this.comboMult(),
      comboTimer: this.comboTimer,
      energy: Math.round(this.energy),
      energyMax: COMBAT.energyMax,
      ballsLeft: this.ballsLeft,
      ballsTotal: this.stage.rules.balls,
      ballInPlay: this.ballInPlay,
      gauges: this.gauges.map((g) => ({ ...g })),
      buffs: this.buffList(),
      links: this.linkList(),
      score: Math.round(this.score),
      totalDamage: Math.round(this.totalDamage),
      slotsHit: this.slotsHit,
      pegHits: this.pegHits,
      maxCombo: this.maxCombo,
      pierced: this.pierced,
      detonated: this.detonated,
      destroyedPegs: this.destroyed.size,
      elapsed: this.elapsed,
      lastSlotLabel: this.lastSlotLabel,
      lastDamage: this.lastDamage,
      /** 本球已撞过的万金钉数。HUD 用它显示「本球 万金 ×N」，飘字抓不到时的常驻回执。 */
      goldHits: this.ballGoldHits,
      slotMultiplier: this.slotMultiplier(false),
      weakSlotMultiplier: this.slotMultiplier(true),
      pendingNextMultiplier: this.pendingNextFactor,
      fever: {
        active: this.feverLeft > 0,
        left: Math.max(0, this.feverLeft),
        duration: this.stage.rules.fever.duration,
        chain: this.feverChain,
        mult: this.feverMult(),
        renda: this.feverRenda,
        best: this.feverBest,
        times: this.feverTimes,
      },
      enemy: {
        killed: this.enemiesKilled,
        alive: this.minionsAlive,
        /** 小怪总数。HUD 用它和 alive 拼成「清空 3/5」 */
        total: this.minionTotal,
        /** 清空进度换来的 Boss 伤害倍率，HUD 直接显示这个数 */
        sweepMult: this.sweepMult(),
        bounces: this.ballBounces,
        maxBounces: this.maxBounces,
        hitDamage: this.bounceBaseDamage(),
        wuxing: WUXING_LABEL[this.ballWuxing()],
        wuxingKey: this.ballWuxing() ?? '',
        marked: this.ballBossMark,
      },
      log: this.log.slice(-6),
    };
  }

  charById(id: string): CharacterDef | undefined {
    return this.team.find((c) => c.id === id);
  }

  private slotMultiplier(weak: boolean): number {
    const mult = this.comboMult() * this.ballSlotFactor * this.ballNextFactor *
      this.linkSlotFactor() * this.mod('slot', 1) *
      (this.ballBossMark ? COMBAT.markSlotMult : 1) *
      Math.pow(COMBAT.goldenPegMult, this.ballGoldHits) * this.feverMult() * this.bounceMult();
    return Math.min(COMBAT.slotMultCap, mult * (weak ? COMBAT.weakSlotMult : 1));
  }

  get linkActiveList(): LinkDef[] {
    return this.links.filter((l) => this.active.has(l.id));
  }

  canRelease(id: string): boolean {
    const g = this.gauges.find((x) => x.charId === id);
    // 被动角色恒不可放：它没有「就绪」这个时刻，常驻就是它的常态。
    // 不挡的话 `g.max === 0 && g.value === 0` 会让 `value >= max` 成立，
    // 按 Digit 会把常驻旋钮重下一遍（视觉上是一次多余的施法特效）。
    if (g && g.max <= 0) return false;
    return !!g && g.value >= g.max && this.phase === 'playing';
  }

  /* --------------------------------------------------------------- 推进 */

  update(dt: number): SimCommand[] {
    this.recoveryPulse = Math.max(0, this.recoveryPulse - dt * 0.8);
    this.elapsed += dt;
    const cmds: SimCommand[] = [];

    /*
     * 被动技能开局一次性下发旋钮。
     *
     * 为什么不放构造函数：构造函数跑的时候物理层（PhysicsBoard）还没建好，
     * `setGravityScale` 之类命令没有接收方。而 `update` 是每帧都会走的命令出口，
     * 放这里既能保证「第一帧就生效」，又复用了现成的 applyRecipe / pushChannel。
     *
     * 只做一次：passiveDone 标记在构造函数里就置好（见下），这里判的是「有没有
     * 被动角色要下发」，发完把它们的旋钮写进 this.mods（duration 0 = 永不到期），
     * 后续帧不会再重复下发。
     */
    if (this.pendingPassives.length) {
      const list = this.pendingPassives;
      this.pendingPassives = [];
      for (const def of list) {
        this.pushLog(`${def.name} · ${def.skill.name}（常驻）`);
        if (def.skill.bossVuln) this.passiveVuln = true;
        cmds.push(...this.applyRecipe(def.id, def.color, 0, this.stage.height * 0.5));
      }
    }

    // 组合技逐段释放。放在最前面：满能量的那一帧就要有反馈，不能等下一帧。
    this.tickCombo(dt, cmds);

    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        this.comboTimer = 0;
        if (this.combo > 0) this.combo = 0;
      }
    }

    // 確変倒计时。时间到就收口，同时把连打倍率清零——刺激必须有时间压力。
    if (this.feverLeft > 0) {
      this.feverLeft -= dt;
      if (this.feverLeft <= 0) cmds.push(...this.endFever());
    }

    // 旋钮到期：一个角色一个频道地收回物理通道。
    // 收回靠重新下发 scale=1，而不是让通道自己等超时——前者立刻生效，
    // 后者会因为多技能叠乘时的先后顺序差半帧。
    for (const [id, m] of [...this.mods]) {
      if (m.duration <= 0) continue; // duration 0 = 整局常驻
      m.left -= dt;
      if (m.left > 0) continue;
      this.mods.delete(id);
      if (PHYSICS_KEYS.has(m.key)) cmds.push(...this.resetChannel(id, m.key));
    }

    for (const [id, p] of [...this.pierces]) {
      p.left -= dt;
      if (p.left > 0) continue;
      this.pierces.delete(id);
      cmds.push(...this.refreshGhosts());
    }

    for (const [id, c] of [...this.chains]) {
      c.left -= dt;
      if (c.left > 0) continue;
      this.chains.delete(id);
    }

    if (this.bossVulnLeft > 0) {
      // 被动技能的破防跟着常驻：否则技能是整局的、破防只有前 6 秒，
      // buff 列表里还会挂一条倒计时，玩家看到「常驻」却只剩 1/4 的效果。
      if (!this.passiveVuln) {
        this.bossVulnLeft -= dt;
        if (this.bossVulnLeft <= 0) {
          this.bossVulnLeft = 0;
          this.bossVulnFactor = 1;
        }
      }
    }

    for (const [id, l] of [...this.active]) {
      l.left -= dt;
      if (l.left <= 0) {
        this.active.delete(id);
        this.linkCooldown.set(id, 6);
        const def = this.links.find((l) => l.id === id);
        cmds.push({ t: 'fx', fx: 'linkEnd', x: 0, y: 0, text: `${def?.name ?? id} 结束` });
      }
    }
    for (const [id, c] of [...this.linkCooldown]) {
      const v = c - dt;
      if (v <= 0) this.linkCooldown.delete(id);
      else this.linkCooldown.set(id, v);
    }

    /*
     * 盘面空闲时也要跑一次结算。
     *
     * 旧版胜利只看 `bossHp <= 0`，而 Boss 一定是在**事件里**死的（落槽、击坠、
     * 技能），所以 `resolveRun` 挂在 `onSlotEnter` / `onBallRetired` 上就够了。
     * 改成「Boss 死 **且** 小怪清空」之后就不行了：这两件事可以错开发生，
     * 真正同时成立的那一刻盘面上什么事件都没有——上一颗球早就退役了，
     * 最后一枚小怪是被一颗还在盘的球顺手打掉的，而球还没停。
     *
     * 不补这一句的后果是静默卡死：血 0%、残怪 0，球也用完了，
     * 但 phase 永远停在 playing，战斗画面卡在最后一击不会进结算界面。
     * stage_06/08/09/10/12 用 200 球探针跑出来就是这个形状。
     *
     * `resolveRun` 在 phase 不是 playing 时立即返回空，所以这里每帧调用无副作用；
     * 它内部的两个分支自带守卫（判负要求没球在盘上），直接每帧跑就行。
     */
    cmds.push(...this.resolveRun());

    return cmds;
  }

  /* ----------------------------------------------------------- 事件入口 */

  handle(ev: BattleEvent): SimCommand[] {
    /*
     * 记住球的位置。组合技是**自动**触发的，它自己拿不到球的坐标；
     * 而盘面上每一个带坐标的事件都从这里过一遍，
     * 所以这里是「自动机制也知道球此刻在哪」的唯一入口。
     */
    if (ev.t === 'pegHit' || ev.t === 'zoneEnter' || ev.t === 'slotEnter' || ev.t === 'launch' || ev.t === 'flipperHit') {
      this.lastBallX = ev.x;
      this.lastBallY = ev.y;
    }
    const cmds: SimCommand[] = [];
    switch (ev.t) {
      case 'recoveryEnter':
        cmds.push(...this.onRecoveryEnter(ev.x, ev.y));
        break;
      case 'launch':
        cmds.push(...this.onLaunch(ev));
        break;
      case 'pegHit':
        cmds.push(...this.onPegHit(ev.pegId, ev.pegKind, ev.intensity, ev.x, ev.y));
        break;
      case 'zoneEnter':
        cmds.push(...this.onZoneEnter(ev.zoneId, ev.kind, ev.x, ev.y));
        break;
      case 'slotEnter':
        cmds.push(...this.onSlotEnter(ev.slotId, ev.kind, ev.value, ev.weak, ev.x, ev.y, ev.viaFever));
        break;
      case 'ballRetired':
        cmds.push(...this.onBallRetired());
        break;
      case 'escape':
        // 脱困是兜底机制，正常的盘面设计不该频繁触发；这里只给一个克制的视觉提示
        cmds.push({ t: 'fx', fx: 'escape', x: ev.x, y: ev.y, scale: 0.9 });
        break;
      case 'flipperHit':
        cmds.push(...this.onFlipperHit(ev));
        break;
    }
    /*
     * 每一条事件都跑一次结算，不只是落槽和退球那两条。
     *
     * 清场成为通关条件之后，胜利需要「Boss 死 且 小怪清空」同时成立；
     * 这两件事往往不在同一条事件里发生。真正让这一帧两边同时为真的，
     * 常常就是**最后一枚小怪被击坠的那条 pegHit**——
     * 而击坠路径不经过 onSlotEnter，也不一定赶在球退役之前。
     * 漏掉它，后果不是「慢一点结算」，而是血 0%、残怪 0、球也用完了，
     * 战斗却永远停在 playing，进不了结算界面（200 球探针在 stage_06/09/12
     * 上三局全僵，就是这条）。
     *
     * `resolveRun` 在 phase 已结束时立即返回空，重复调用无副作用。
     */
    cmds.push(...this.resolveRun());
    return cmds;
  }

  /**
   * 翻板回击。
   *
   * **这里一分伤害都不给**，是刻意的。
   *
   * 翻板的定位是「延长本球的打击时间」：把落向底槽的球打回中区，
   * 球在空中多待一会儿，钉子自然多挨几次——伤害是从**钉子**那一通道流出来的。
   * 若这里再补一笔直接伤害，按 Z 就变成了刷伤害的技能键，
   * 「清小怪 / 打 Boss / 按板」三条路会挤成同一条，玩家不需要任何判断。
   *
   * 给的只有分和记录：让玩家看见「我这一板确实打中了」，以及本局一共救回来几次。
   */
  private onFlipperHit(ev: Extract<BattleEvent, { t: 'flipperHit' }>): SimCommand[] {
    if (this.phase !== 'playing') return [];
    this.flipperHits += 1;
    this.score += COMBAT.flipperScore;
    this.pushLog(`翻板 ${ev.side === 'left' ? '左' : '右'} · 救球 ${this.flipperHits}`);
    return [
      { t: 'fx', fx: 'flipper', x: ev.x, y: ev.y, text: '回 击', color: '#ffd76a', scale: 1.1 },
      // 时间是这次按板**真正买到的东西**，必须和「回击」一起印出来。
      // 只印「回击」的话玩家不会知道倒计时被延长了，
      // 于是「按板到底值不值」这件事在界面上根本读不出来。
      { t: 'fx', fx: 'flipperTime', x: ev.x, y: ev.y, text: `+${ev.timeRefund.toFixed(2)}s`, color: '#7bf3d4', scale: 0.9 },
      { t: 'sound', name: 'flipper' },
      { t: 'shake', amount: 0.2, duration: 0.18 },
    ];
  }

  /**
   * 击射。每一次都扣一份资源——**包括追打**。
   *
   * 为什么追打也要扣：没有代价的话，玩家会一直点，0.34s 冷却挡得住连点
   * 挡不住「每冷却打一发」，球就能无限续命，14 份资源变成无限。
   * 扣了之后才有一个真实的决策：**花一发救这颗球，还是留着给下一颗？**
   *
   * 为什么补射不清空反弹数：`ballBounces` 就是「撞得越久打越疼」的主变量。
   * 补射的整个意义就是把球从快停住的状态救回来继续弹——如果补射顺手把反弹数清零，
   * 救球反而变亏，玩家的正确策略就变成「不救，让它掉」，机制和目标正好相反。
   */
  private onLaunch(ev: Extract<BattleEvent, { t: 'launch' }>): SimCommand[] {
    if (this.phase !== 'playing' || this.ballsLeft <= 0) return [{ t: 'sound', name: 'deny' }];
    const followUp = ev.followUp === true;
    this.ballInPlay = true;
    this.ballsLeft = Math.max(0, this.ballsLeft - 1);

    if (!followUp) {
      // 换新球：每球状态全部归零
      this.ballSlotFactor = 1;
      this.ballNextFactor = this.pendingNextFactor;
      this.pendingNextFactor = 1;
      this.ballBossMark = false;
      this.ballGoldHits = 0;
      this.ballBounces = 0;
      // 化五行只作用于当球：下一发重新按队形首位算，否则「一变就一直变」，
      // 队形选择就失去了意义
      this.ballWuxingOverride = null;
      return [];
    }

    // 补射：只给反馈，不动任何每球状态。飘字要响——「你又救回来一次」
    // 是这个玩法存在的理由，不出声玩家就意识不到自己这一发干了什么。
    return [
      {
        t: 'fx',
        fx: 'followUp',
        x: ev.x,
        y: ev.y,
        text: `追打 ${this.ballBounces} 弹`,
        color: '#9fe8ff',
        scale: 1.25,
        value: this.ballBounces,
      },
      { t: 'sound', name: 'shot' },
    ];
  }

  /**
   * 技能充能的唯一入口。
   *
   * 为什么必须收在一处：早期版本把充能判断内联在 onPegHit 里，
   * 结果 `SkillTriggerEvent` 里的 slotEnter 与 enemyKill **从来没有实现过**——
   * schema 里有、数据里能配、类型检查也过，宋江的「落槽充能」就这么整局不充。
   * 这种「数据说会触发、Runtime 忘了接」的洞，是数据驱动最贵的 bug：
   * 玩家只会看到这将很弱，开发只会看到数值不够，然后去乱调倍率。
   * 现在任何新增触发都必须在这里加一行，漏了会在 smoke 的配方校验里报出来。
   */
  private chargeFor(
    event: 'pegHit' | 'slotEnter' | 'enemyKill' | 'zoneEnter',
    x: number,
    y: number,
    intensity: number,
    out: SimCommand[],
  ): void {
    let anyFull = false;
    for (const c of this.team) {
      const trig = c.skill.trigger;
      if (trig.on === 'none') continue;
      // 被动角色不进充能：它的旋钮开局就常驻，再充能既没意义也会把「就绪」提示
      // 打成噪声（每局进几次区就响一次，而技能早就在生效了）。
      if (trig.auto) continue;
      // 事件 → 触发条件的映射表。加一个 SkillTriggerEvent 就必须在这里加一行。
      const matched =
        trig.on === event ||
        (trig.on === 'pegImpact' && event === 'pegHit') ||
        (trig.on === 'spearHit' && event === 'pegHit' && this.lastPegKind === 'spear') ||
        (trig.on === 'heavyImpact' && event === 'pegHit' && intensity >= 0.45) ||
        (trig.on === 'zoneSkill' && event === 'zoneEnter');
      if (!matched || intensity < trig.minIntensity) continue;
      const g = this.gauges.find((v) => v.charId === c.id);
      if (!g || g.value >= g.max) continue;
      const wasReady = g.value >= g.max;
      g.value = Math.min(g.max, g.value + trig.perHit);
      if (!wasReady && g.value >= g.max) {
        anyFull = true;
        out.push({ t: 'sound', name: 'charge' });
        out.push({ t: 'fx', fx: 'gaugeFull', x, y, text: `${c.skill.name} 就绪`, color: c.color });
      }
    }
    if (anyFull) out.push({ t: 'fx', fx: 'charge', x, y });
  }

  private onPegHit(
    pegId: string,
    pegKind: PegKind,
    intensity: number,
    x: number,
    y: number,
  ): SimCommand[] {
    if (this.phase !== 'playing') return [];
    this.pegHits++;

    const cmds: SimCommand[] = [];

    // 反弹计数：《怪物弹珠》的伤害公式建立在「撞得越久打越疼」上，
    // 所以每次撞击都要计入本球的反弹数，而不是看球的初速度。
    this.ballBounces++;
    this.maxBounces = Math.max(this.maxBounces, this.ballBounces);

    // 反弹里程碑：**每多弹一次敌人多疼 perBounce** 是全游戏唯一的核心手感，
    // 但它是静默的——HUD 上的反弹数在涨，玩家不知道自己在赚什么。
    // 跨过 5 / 10 / 上限时把「这一跳赚了多少伤害」喊出来，机制就不用教了。
    const r = this.stage.rules.enemy;
    for (const mark of [5, 10, r.bounceMax]) {
      if (this.ballBounces === mark) {
        cmds.push({
          t: 'fx',
          fx: 'bounceMilestone',
          x,
          y: y + 1.3,
          text: `${mark} 弹　敌人 +${r.perBounce * mark}`,
          color: mark === r.bounceMax ? '#ffd24a' : '#9fe8ff',
          scale: mark === r.bounceMax ? 1.6 : 1.2,
        });
        cmds.push({ t: 'sound', name: 'charge' });
        break;
      }
    }

    // 连击
    this.combo = this.comboTimer > 0 ? this.combo + 1 : 1;
    this.comboTimer = this.stage.rules.comboWindow;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    // 每撞一次就往上抬一格落槽倍率：叠加上限与增量由各角色自己在配方里配
    // （武松就是 slot: 1.55 起，每次碰撞 +0.035，叠到 3.2 封顶）
    this.stackMods('pegHit');

    // 万金钉：撞一枚给本球叠一格落槽倍率。
    // 关键在这一句飘字——钉子的作用不能只靠「碰了之后分数变高」让玩家自己发现，
    // 必须在碰的那一帧就说清楚「碰它换到了什么」。金钉是全盘第二亮的东西，
    // 玩家早就盯上它了，现在终于知道盯它是对的。
    if (pegKind === 'golden') {
      this.ballGoldHits++;
      const now = Math.pow(COMBAT.goldenPegMult, this.ballGoldHits);
      cmds.push({
        t: 'fx',
        fx: 'golden',
        x,
        y: y + 1.2,
        text: `万金 ×${now.toFixed(1)}`,
        color: '#ffd24a',
        scale: 1.4,
        value: now,
      });
    }

    // 技能充能：完全由物理过程驱动
    this.lastPegKind = pegKind;
    this.chargeFor('pegHit', x, y, intensity, cmds);

    // 穿透：钉板被穿过时即时结算伤害；穿过 Boss 口的破绽钉则直接对 Boss 造成伤害。
    // 这里不关心是谁开的穿透——多张卡同时开就把伤害加起来。
    const pierceDmg = this.pierceDamageFor(pegKind);
    if (pierceDmg > 0) {
      this.pierced++;
      const isWeak = pegKind === 'weak';
      const dmg = pierceDmg * (isWeak ? 2 : 1);
      this.score += dmg;
      if (isWeak) cmds.push(...this.applyBossDamage(dmg));
      cmds.push({
        t: 'fx',
        fx: isWeak ? 'pierceWeak' : 'pierceHit',
        x,
        y,
        text: isWeak ? `破绽 +${dmg}` : `+${dmg}`,
        color: isWeak ? '#ff5470' : '#7ad7ff',
      });
    }

    // 连锁引爆：角色技能（chain）和连携（chainDetonate）都走这一条通路，
    // 区别只是连锁伤害带哪个五行、吃不吃相生相克。
    for (const ch of this.chains.values()) this.detonate(ch.charId, pegId, x, y, ch.radius, ch.damage, ch.wuxing, cmds);
    const link = [...this.active.values()].find((l) => l.chainDetonate);
    if (link) this.detonate(null, pegId, x, y, link.destroyRadius, link.detonateDamage, this.ballWuxing(), cmds);

    // 敌人钉：真正会疼、会白闪、会爆数字，血空即击坠
    cmds.push(...this.hitEnemy(pegId, pegKind, intensity, x, y));

    cmds.push(...this.tryLinks(x, y));
    return cmds;
  }

  private onZoneEnter(zoneId: string, kind: string, x: number, y: number): SimCommand[] {
    if (this.phase !== 'playing') return [];
    const cmds: SimCommand[] = [];

    switch (kind) {
      case 'energy':
        this.addEnergy(COMBAT.zoneEnergyGain, cmds);
        break;
      case 'combo':
        this.combo += COMBAT.zoneComboGain;
        this.comboTimer = this.stage.rules.comboWindow * 1.7;
        this.maxCombo = Math.max(this.maxCombo, this.combo);
        break;
      case 'skill':
        // 技能区充能：只有真的进技能区才算，previous 版本把 zoneSkill 挂在
        // 「每次撞钉」上，等于这三人每局能放几十次，数值全靠这个 bug 撑着。
        // `max > 0` 顺带把被动角色排除掉——它们开局就常驻，不该再吃充能。
        for (const g of this.gauges) {
          if (g.max <= 0) continue;
          g.value = Math.min(g.max, g.value + COMBAT.zoneSkillCharge);
        }
        this.chargeFor('zoneEnter', x, y, 1, cmds);
        break;
      case 'multiplier':
        this.ballSlotFactor *= COMBAT.zoneSlotMult;
        break;
      case 'boss':
        this.ballBossMark = true;
        break;
      default:
        break;
    }

    const label = this.stage.zones.find((z) => z.id === zoneId)?.label ?? kind;
    this.pushLog(`区域 ${label}`);
    cmds.push({ t: 'fx', fx: `zone_${kind}`, x, y, text: label });
    cmds.push({ t: 'sound', name: 'zone', value: kind.length });

    cmds.push(...this.tryLinks(x, y));
    return cmds;
  }

  /**
   * 本球此刻撞中敌人钉的**基准伤害**：base + perBounce × min(反弹数, 上限) × bounceDamage 增益。
   *
   * HUD 的「反弹 → 敌人伤」直接读这个值，而不是自己写一遍公式。
   * 之前 HUD 抄的是 `perBounce × 反弹数`，漏掉 baseDamage 也不含相性和会心，
   * 屏幕上是「12 弹 +264」，玩家会以为那就是这一下的总伤害——实际打出去是 326 起步。
   * 口径对不上，玩家就不敢信盘面上任何一个数字。
   */
  private bounceBaseDamage(): number {
    const r = this.stage.rules.enemy;
    const bounces = Math.min(this.ballBounces, r.bounceMax);
    return Math.round(r.baseDamage + r.perBounce * bounces * this.mod('bounceDamage', 1));
  }

  /**
   * 敌人钉结算。伤害公式抄《怪物弹珠》：
   *   (base + perBounce × 反弹次数 × bounceDamage) × 五行倍率 × 会心倍率
   * 所以打法不是「瞄得准」，是「撞得久」——球在盘上弹得越久，下一击越疼。
   * 击坠还会把球往前推一下，连杀能一路滚下去，这是那股「拦不住的势头」的来源。
   */
  private hitEnemy(pegId: string, pegKind: PegKind, intensity: number, x: number, y: number): SimCommand[] {
    if (pegKind !== 'enemy') return [];
    if (this.destroyed.has(pegId)) return [];
    const peg = this.stage.pegs.find((p) => p.id === pegId);
    if (!peg || peg.hp === undefined) return [];

    const r = this.stage.rules.enemy;
    let dmg = this.bounceBaseDamage() * (0.7 + intensity * 0.6);

    const self = this.ballWuxing();
    let attrMult = 1;
    let attrTag = '';
    if (peg.wuxing && self) {
      const tier = wuxingTier(self, peg.wuxing);
      if (tier.tier === 'win') {
        attrMult = this.mod('attrWin', r.attrWin);
        attrTag = '克制';
      } else if (tier.tier === 'gen') {
        attrMult = this.mod('attrGen', r.attrGen);
        attrTag = '相生';
      } else if (tier.tier === 'same') {
        // 同属不赚也不亏：给 ×1 走 attrMult 默认值，tag 只作提示
        attrMult = 1;
        attrTag = '同属';
      } else {
        attrMult = this.mod('attrLose', r.attrLose);
        attrTag = '逆势';
      }
    }
    dmg *= attrMult;

    const critChance = Math.min(0.95, r.critChance + this.mod('critChance', 0));
    const crit = this.rng() < critChance;
    if (crit) dmg *= this.mod('critMult', r.critMult);

    return this.damageEnemy(peg, dmg, crit, intensity, x, y, attrTag);
  }

  /** Common HP/death/reward path for physical collisions and aimed weapons. */
  private damageEnemy(peg: PegDef, dmg: number, crit: boolean, intensity: number, x: number, y: number,
    attrTag = '', weapon = false): SimCommand[] {
    const pegId = peg.id;
    if (peg.hp === undefined || this.destroyed.has(pegId)) return [];
    const r = this.stage.rules.enemy;

    const hp = this.enemyHp.get(pegId) ?? peg.hp;
    const left = Math.max(0, hp - Math.round(dmg));
    this.enemyHp.set(pegId, left);
    const dealt = Math.round(dmg);
    const bounces = Math.min(this.ballBounces, r.bounceMax);

    const cmds: SimCommand[] = [];
    // 血弧：把「这颗钉已经被打了多少」推到盘面上常驻。少了这一条，
    // 击坠就是凭空发生的事——玩家学不到「接着撞同一颗」这个核心手法。
    cmds.push({ t: 'enemyHp', pegId, ratio: peg.hp > 0 ? left / peg.hp : 0 });
    cmds.push({
      t: 'fx',
      fx: crit ? 'crit' : 'enemyHit',
      x,
      y,
      // 伤害数字里**必须带上这一击是第几弹**。
      // 整个游戏的核心手感是「弹得越久越疼」，但一个光秃秃的 154 读不出这件事，
      // 玩家只会以为自己在打固定伤害。写成「7弹 154」，因果关系就摆在眼前了。
      text: weapon ? `武器 ${dealt}` : bounces > 0 ? `${bounces}弹 ${dealt}` : String(dealt),
      value: dealt,
      color: peg.wuxing ? WUXING_HEX[peg.wuxing] : '#ffe9a8',
      scale: crit ? 1.6 : 1,
    });
    cmds.push({ t: 'sound', name: crit ? 'bossHit' : 'slot', value: crit ? 999 : dealt });
    if (attrTag) {
      cmds.push({
        t: 'fx',
        fx: 'attrTag',
        x,
        y: y + 0.9,
        text: attrTag,
        color: peg.wuxing ? WUXING_HEX[peg.wuxing] : '#ffd76a',
        scale: attrTag === '逆势' ? 0.75 : 0.9,
      });
    }
    // 数字之外还要让钉自己抖一下，否则「打中了」只有数字没有物理
    cmds.push({ t: 'fx', fx: 'enemyHitRing', x, y, color: peg.wuxing ? WUXING_HEX[peg.wuxing] : '#ffe9a8' });

    if (left <= 0) {
      this.destroyed.add(pegId);
      this.enemiesKilled++;
      this.score += peg.value;
      this.stackMods('enemyKill');
      // 击坠充能：靠打倒敌人攒技能的卡，节奏天然跟着盘面走
      this.chargeFor('enemyKill', x, y, intensity, cmds);
      cmds.push({ t: 'destroyPegs', pegIds: [pegId], reason: 'enemy' });
      cmds.push({
        t: 'fx',
        fx: 'enemyKill',
        x,
        y,
        text: `${enemyCardFor(peg.wuxing, peg.enemyId).name} · 击破`,
        color: WUXING_HEX[peg.wuxing ?? 'metal'],
        scale: 1.4,
      });
      cmds.push({ t: 'flash', color: WUXING_HEX[peg.wuxing ?? 'metal'], duration: 0.18 });
      cmds.push({ t: 'shake', amount: 0.34, duration: 0.26 });
      // 向前补一推：连杀时球不会被单次撞击的减速打断，势头能滚起来
      cmds.push({ t: 'boostBall', dirX: 0, dirY: -1, impulse: this.stage.rules.enemy.killBoost });
      cmds.push({ t: 'sound', name: 'link' });

      /*
       * 击坠**不再直接扣 Boss 血**。
       *
       * 旧版这里给 `killDamage`（110/枚），本意是让玩家看到「我在推进 Boss」，
       * 实际是把两件事拧成了一件：小怪有自己的血条，玩家在**清场**；Boss 也在
       * 掉血，于是「专精打大怪」和「专精清小怪」变成同一条路，跳过任何一边都不划算，
       * 两条路都不存在了。
       *
       * 现在击坠只做两件事：把清空进度往前推一格（`sweepMult` 在 applyBossDamage
       * 里统一生效），以及在**全部清空**的那一刻给一笔一次性奖励。
       */
      const swept = this.sweptCount;
      const total = this.minionTotal;
      const justFull = swept >= total && !this.fullSweepFired;
      if (justFull) this.fullSweepFired = true;
      const bonusMult = this.sweepMult();
      cmds.push({
        t: 'fx',
        fx: 'enemyHitRing',
        x: peg.x,
        y: peg.y,
        text: `清空 ${swept}/${total}　Boss 伤害 ×${bonusMult.toFixed(2)}`,
        color: WUXING_HEX[peg.wuxing ?? 'metal'],
        scale: 1.25,
      });
      if (justFull) {
        const hpBefore = this.bossHp;
        cmds.push(...this.applyBossDamage(this.stage.rules.enemy.fullSweepDamage));
        const applied = Math.max(0, hpBefore - this.bossHp);
        this.pushLog(`小怪全清 · Boss 追加 -${applied}`);
        cmds.push({
          t: 'fx',
          fx: 'bossDamage',
          x: this.stage.boss.weakPoint.x,
          y: this.stage.boss.weakPoint.y + 1.6,
          text: `全清 -${applied}`,
          color: '#ffd76a',
          scale: 1.8,
          value: applied,
        });
        cmds.push({ t: 'sound', name: 'bossHit' });
      }
    }
    return cmds;
  }

  /**
   * 连锁引爆：把伤害弹给半径内的其它敌人。
   * wuxing 决定这次连锁吃不吃五行相生相克——所以「用谁的五行引爆」是配置项，不是 if。
   */
  private detonate(
    ownerId: string | null,
    fromPegId: string,
    x: number,
    y: number,
    radius: number,
    baseDamage: number,
    wuxing: Wuxing,
    out: SimCommand[],
  ): void {
    const ids = this.pegsInRadius(fromPegId, x, y, radius, true).filter((id) => {
      const p = this.stage.pegs.find((v) => v.id === id);
      return p?.kind === 'enemy' && !this.destroyed.has(id);
    });
    if (!ids.length) return;

    this.detonated += ids.length;
    let dmg = baseDamage * ids.length * this.mod('burst', 1);
    // 连锁伤害走一遍五行：打中相克的那几个才吃满，这是「选对队形」的第二层收益
    let hit = 0;
    for (const id of ids) {
      const p = this.stage.pegs.find((v) => v.id === id);
      if (p?.wuxing) {
        if (wuxingTier(wuxing, p.wuxing).tier !== 'lose') hit++;
        else this.destroyed.add(id);
      } else hit++;
    }
    dmg *= hit / ids.length;
    // 模拟与碰撞体必须同时移除。后续连锁只查询尚在盘上的敌人。
    for (const id of ids) this.destroyed.add(id);
    this.enemiesKilled += ids.length;
    this.score += dmg;
    out.push(...this.applyBossDamage(dmg));
    out.push({ t: 'destroyPegs', pegIds: ids, reason: ownerId ? 'chain' : 'link' });
    out.push({
      t: 'fx',
      fx: 'detonate',
      x,
      y,
      text: `连锁 ×${ids.length}`,
      color: WUXING_HEX[wuxing],
    });
    out.push({ t: 'shake', amount: 0.3, duration: 0.25 });
  }

  /**
   * 球的五行 = 出战队伍首位武将的五行（队形以第一位为门面，与 UI 一致），
   * 除非某个技能用 wuxingShift 把它临时改了。
   */
  private ballWuxing(): Wuxing {
    return this.ballWuxingOverride ?? this.team[0]?.wuxing ?? 'metal';
  }

  /**
   * 落槽的反弹加成。每多弹一次，后续落槽就更疼——这是《怪物弹珠》
   * 「速度越快、反弹次数越多、伤害越大」那句话在结算层的落点。
   * 上限 1.3：反弹是「手感上的爽」，不是「构筑上的必赢」，所以刻意压在
   * 連打(fever) 之下，让玩家先选路线再吃反弹。
   */
  private bounceMult(): number {
    return Math.min(1.3, 1 + this.ballBounces * 0.012);
  }
  /**
   * 会心判定用的确定性随机源。
   * 故意不用 Math.random：同一颗种子要能在无头 smoke 里复现同一场战斗，
   * 否则「会心是不是真的按 22% 出」这种断言永远验不了。
   */
  private rngState = 0x2f6e2b1;
  private rng(): number {
    this.rngState = (this.rngState * 1664525 + 1013904223) >>> 0;
    return this.rngState / 0x100000000;
  }

  private onSlotEnter(
    slotId: string,
    kind: string,
    value: number,
    weak: boolean,
    x: number,
    y: number,
    viaFever = false,
  ): SimCommand[] {
    if (this.phase !== 'playing') return [];
    const cmds: SimCommand[] = [];
    this.slotsHit++;
    // 落槽充能（宋江）：进哪个口都算，不挑 value，弱口也算——
    // 他的定位就是「进得越多，雨下得越勤」
    this.chargeFor('slotEnter', x, y, 1, cmds);
    const slot = this.stage.slots.find((s) => s.id === slotId);
    const label = slot?.label ?? kind;
    this.lastSlotLabel = label;

    // 確変触发 / 连打累加。放在倍率计算之前，本球就要吃到新档位。
    let feverChainUp: SimCommand[] = [];
    if (slotId === this.stage.rules.fever.triggerSlot) {
      feverChainUp = this.startFever(x, y);
      cmds.push(...feverChainUp);
    } else if (this.feverLeft > 0) {
      const before = this.feverChain;
      this.feverChain = Math.min(this.stage.rules.fever.chainMax, this.feverChain + 1);
      this.feverRenda++;
      this.feverBest = Math.max(this.feverBest, this.feverRenda);
      this.pushLog(`連打 ${this.feverRenda}`);
      cmds.push({
        t: 'fx',
        fx: 'renda',
        x,
        y,
        text: this.feverChain > before ? `${this.feverRenda} 連打 ×${this.feverMult().toFixed(2)}` : `${this.feverRenda} 連打`,
        color: this.stage.rules.fever.palette.led,
        scale: this.feverChain > before ? 1.5 : 1.1,
      });
      cmds.push({ t: 'sound', name: 'slot', value: this.feverRenda });
    }
    void viaFever;

    if (kind === 'energy') {
      this.addEnergy(COMBAT.slotEnergyGain, cmds);
    } else if (kind === 'multiplier') {
      this.pendingNextFactor = COMBAT.slotNextMult;
    }

    // 落槽总倍率。连击 / 球自身 / 连携 / 技能旋钮 / 確変 / 反弹 全部叠乘后由 cap 收口。
    // 技能那一段只有一个 mod('slot', 1)——技能是数据，这里不需要知道有谁在场。
    const mult = this.slotMultiplier(weak);
    let dmg = Math.round(Math.max(0, value) * mult);
    if (this.bossVulnLeft > 0) dmg = Math.round(dmg * this.bossVulnFactor);

    this.score += dmg;
    this.lastDamage = dmg;

    if (kind === 'boss') {
      cmds.push({ t: 'sound', name: 'bossHit' });
      cmds.push({ t: 'shake', amount: 0.22 + Math.min(0.4, dmg / 900), duration: 0.3 });
      cmds.push(...this.applyBossDamage(dmg));
    }

    cmds.push({
      t: 'fx',
      fx: kind === 'boss' ? 'bossDamage' : 'slot',
      x,
      y,
      // 飘字要说「我得到了什么」，不是甩一个 +818 让玩家自己猜这是钱还是伤害。
      // 五个槽各说一句人话，玩家打三颗球就能自己总结出「往哪打」——
      // 这是唯一不需要说明书也能学会的路径。
      //
      // 万金钉是唯一会**在撞钉那一刻**就预告的收益，所以落槽时再叠一句：
      // 「本球 2 枚万金」把刚才屏幕上飘过的 ×2.3 和现在这个数字焊在一起，
      // 玩家才建立得起「追金钉 → 落槽更疼」这条因果。
      text:
        this.ballGoldHits > 0 && !weak
          ? `${this.ballGoldHits} 枚万金 ×${Math.pow(COMBAT.goldenPegMult, this.ballGoldHits).toFixed(1)}　${dmg}`
          : weak
            ? `正中破绽 ×${COMBAT.weakSlotMult}！${dmg}`
            : kind === 'energy'
              ? `充能 +${COMBAT.slotEnergyGain}`
              : kind === 'multiplier'
                ? `下颗球 ×${COMBAT.slotNextMult}`
                : kind === 'combo'
                  ? `连击 ×${this.comboMult().toFixed(2)}`
                  : `加分 ${Math.round(value)}`,
      color: kind === 'boss' ? '#ff5470' : '#ffe9a8',
      scale: weak ? 1.5 : this.ballGoldHits > 0 ? 1.3 : kind === 'boss' ? 1.25 : 1.1,
      value: dmg,
    });
    cmds.push({ t: 'sound', name: 'slot', value: kind === 'boss' ? 0 : dmg });

    this.pushLog(
      `${label}${weak ? '·破绽' : ''} ${dmg > 0 ? `+${dmg}` : ''}${mult > 1.2 ? ` (×${mult.toFixed(1)})` : ''}`,
    );

    cmds.push(...this.tryLinks(x, y));
    // 不在这里结算：`handle()` 会在每条事件之后统一调 `resolveRun()`，
    // `update()` 还有一道帧级兜底。这里再调一次只会让「结算在哪发生」变成三处。
    return cmds;
  }

  private onBallRetired(): SimCommand[] {
    this.ballInPlay = false;
    // 同上：退球只是清场标记，结算统一由 `handle()` / `update()` 兜住。
    return [];
  }

  private onRecoveryEnter(x: number, y: number): SimCommand[] {
    if (this.phase !== 'playing' || !this.ballInPlay) return [];
    const rule = this.stage.recovery;
    this.recoveryCharge = Math.min(rule.threshold, this.recoveryCharge + rule.perEntry);
    /*
     * 恢复池只**修复残血**，不再复活已击坠的小怪。
     *
     * 旧版 `this.destroyed.delete(peg.id)` 会把倒掉的五行小怪整批拉回来。
     * 那是「五行归位」在 Boss 速通版本里的合理设计——小怪只扣分，复活不碍事。
     * 但现在清场是通关条件，恢复池就成了无限循环的发动机：球每路过两三次
     * 攒满 100 点，一攒满就把清场进度倒回去，「清空才能收工」变成一句空话。
     *
     * 保留「修复」而不是直接删掉这个机制，是因为它仍然制造真实的取舍：
     * 你必须一口气把小怪打掉，打成消耗战它会慢慢回血。
     * `healRatio` 封顶、且只作用于**还活着**的敌人，所以总工作量仍然有界。
     */
    const hurt = this.stage.pegs.filter(
      (p) => p.kind === 'enemy' && p.wuxing && !this.destroyed.has(p.id)
        && (this.enemyHp.get(p.id) ?? p.hp ?? 0) < (p.hp ?? 0),
    );
    if (this.recoveryCharge < rule.threshold || hurt.length === 0) {
      return [{ t: 'fx', fx: 'recoveryCharge', x, y, text: `恢复池 ${Math.round(this.recoveryCharge)}/${rule.threshold}`, color: '#7bf3d4' }];
    }
    const cmds: SimCommand[] = [];
    for (const peg of hurt) {
      const max = peg.hp ?? 0;
      const next = Math.min(max, Math.round((this.enemyHp.get(peg.id) ?? max) + max * rule.healRatio));
      this.enemyHp.set(peg.id, next);
      cmds.push({ t: 'enemyHp', pegId: peg.id, ratio: max > 0 ? next / max : 0 });
    }
    this.recoveryCharge -= rule.threshold;
    this.recoveries++;
    this.recoveryPulse = 1;
    this.pushLog(`恢复池修复 ${hurt.length} 个五行靶点`);
    cmds.push({
      t: 'fx',
      fx: 'recoveryBurst',
      x: rule.x,
      y: rule.y,
      text: `五行归位 · 修复 ${hurt.length} 点`,
      color: '#8bffdf',
      scale: 1.4,
    });
    cmds.push({ t: 'sound', name: 'charge' });
    return cmds;
  }

  private resolveRun(): SimCommand[] {
    if (this.phase !== 'playing') return [];
    /*
     * 通关条件：Boss 倒下 **且** 小怪清空。
     *
     * 旧版只要 `bossHp <= 0` 就赢，小怪只是扣分。那样清场根本不是选择而是加分项：
     * 无视小怪照样通关，满清倍率 ×2.2 只是白给的一份糖。
     * 于是 `perSweep` 无论怎么配都不影响“能不能赢”，满清倍率也就不再是
     * 一条跨关恒定的交易——玩家最优解永远是「先打 Boss」，小怪只是回合结束前的垃圾清理。
     *
     * 改成清场才算赢之后：
     *  · 清场从“加分项”变成通关前提，清场倍率才是真的在定价；
     *  · Boss 倒下但没清场时不结算，球照旧能打，专门补刀（`bossDownAt` 只做提示）；
     *  · 球打完了还没清完 = 输，这条失败条件现在有了真实的触发场景。
     */
    if (this.bossHp <= 0 && this.minionsAlive > 0) {
      if (!this.cleansingAnnounced) {
        this.cleansingAnnounced = true;
        this.pushLog('Boss 已倒，小怪还剩 ' + this.minionsAlive + ' 枚 —— 清空才能收工！');
      }
      // 不结算：球还在，`ballsLeft` 还够就继续打；不够则由下面的判负接手
      return [];
    }
    if (this.bossHp <= 0) {
      this.phase = 'victory';
      this.pushLog('Boss 已被击破！');
      // fx: 'victory' 是**结算信号**，不是特效。BattleScene.exec 靠它 case 到
      // onSettled() → onFinish() → ui.showResult()。少了这一条，Boss 死了画面
      // 也会永远停在战斗里（sim 内部 phase 已经是 victory，smoke 读 phase 看不出来）。
      return [{ t: 'fx', fx: 'victory', x: 0, y: 0 }, ...this.minionLeftoverPenalty()];
    }
    if (!this.ballInPlay && this.ballsLeft <= 0) {
      this.phase = 'defeat';
      const left = this.minionsAlive;
      this.pushLog(left > 0 ? `击射次数用尽，小怪还剩 ${left} 枚 —— 收工不了` : '击射次数用尽，挑战失败');
      return [{ t: 'fx', fx: 'defeat', x: 0, y: 0 }, ...this.minionLeftoverPenalty()];
    }
    return [];
  }

  /**
   * 收尾扣分：按「还剩几枚小怪没清」扣最终得分。
   *
   * **它只负责扣分，不负责结算。** 结算信号由 resolveRun() 里的 fx:'victory' /
   * fx:'defeat' 发出。这里曾经把整段 return 顶替掉过（commit 902714c 小怪改造），
   * 结果两条路径——清空了返回 []、没清空返回一条飘字——都不发结算信号，
   * 于是打完 Boss 永远进不了结算界面。
   *
   * 判负已经交给 `resolveRun()`（清场才算赢），这里剩下的场景只有一种：
   * **清了场但没打完 Boss**（球先耗尽）。那种情况下玩家的主观体验就是
   * 「我清干净了却还是输了」，一句「小怪未清」反而是在说假话；
   * 所以此时只报「清场达成」这个客观事实，并把剩余扣分说清楚。
   */
  private minionLeftoverPenalty(): SimCommand[] {
    const left = this.minionsAlive;
    if (left <= 0) return [];
    const e = this.stage.rules.enemy;
    const cut = Math.round(this.score * e.leftoverPenalty * left);
    this.score = Math.max(0, this.score - cut);
    this.pushLog(`小怪未清 ×${left}　结算 -${cut}`);
    return [{
      t: 'fx',
      fx: 'renda',
      x: 0,
      y: 0,
      text: `小怪未清 ×${left}　得分 -${cut}`,
      color: '#ff9a7a',
      scale: 1.5,
    }];
  }

  /* ----------------------------------------------------------- 玩家操作 */

  /** 释放角色技能：改写物理规则，而不是单纯加 buff。 */
  releaseSkill(charId: string, x: number, y: number, aimDeg = 90): SimCommand[] {
    const c = this.charById(charId);
    const g = this.gauges.find((v) => v.charId === charId);
    // `g.max <= 0` 是被动角色（见 canRelease 的注释）。挡在这里而不是只靠
    // BattleScene，是因为探针和 smoke 都可能绕过 UI 直接调它。
    if (!c || !g || g.max <= 0 || g.value < g.max || this.phase !== 'playing') {
      return [{ t: 'sound', name: 'deny' }];
    }
    g.value = 0;
    this.pushLog(`${c.name} · ${c.skill.name}`);

    const cmds: SimCommand[] = [{ t: 'fx', fx: 'skillCast', x, y, text: c.skill.name, color: c.color, scale: 1.8 }];
    cmds.push({ t: 'sound', name: 'skill' });
    cmds.push({ t: 'shake', amount: 0.4, duration: 0.4 });
    cmds.push({ t: 'flash', color: c.color, duration: 0.25 });
    cmds.push(...this.applyRecipe(c.id, c.color, x, y, aimDeg));
    cmds.push(...this.tryLinks(x, y));
    return cmds;
  }

  /**
   * 组合技：能量满时**自动**打出的三段连击。
   *
   * 旧版这里是个玩家按 Q 触发的「聚气冲击」——给球一记向上的推力。
   * 这次改造把它整个换掉，理由有两条：
   *
   * 1. **它和翻板抢同一个定位**。翻板（Z / X）也是「给球一次额外的力」，
   *    两件事只能留一个。能瞄准、能预判、有失误的那个才是弹珠游戏的操作，
   *    而「攒到能量再按一下」不是——它是把已经攒够的东西再花一次。
   * 2. **它抢了 Q 这个键**。Q 在别的系统里还要留给别的用途，
   *    而弹板占了 Z / X 之后，玩家手上的三个键正好是「三个技能 + 两块板」，
   *    不再多一个「攒满了才能按」的按钮。
   *
   * 所以能量不再是一个**可消耗资源**，而是一个**进度条**：
   * 攒满就自动结算三段，玩家全程不用管它，只需要知道「快满了，去拿那几枚小怪」。
   *
   * 三段是自动的，所以它必须自己打满节奏——`tick` 按 `comboHitGap`
   * 逐段释放，玩家看到的是三下连击，而不是一瞬间糊上去一个大数字。
   */
  private startCombo(out: SimCommand[]): void {
    if (this.phase !== 'playing' || this.comboLeft > 0) return;
    this.comboLeft = COMBAT.comboHits;
    this.comboSeqTimer = 0;
    this.comboFired = 0;
    this.energy = 0;
    this.pushLog('聚气 · 三段连击');
    out.push({ t: 'fx', fx: 'comboStart', x: this.lastBallX, y: this.lastBallY, text: '聚 气', color: '#49e6ff', scale: 2.2 });
    out.push({ t: 'flash', color: '#49e6ff', duration: 0.3 });
    out.push({ t: 'sound', name: 'charge' });
  }

  /** 逐段推进。由 `update` 驱动，玩家不参与。 */
  private tickCombo(dt: number, out: SimCommand[]): void {
    if (this.comboLeft <= 0) return;
    this.comboSeqTimer -= dt;
    if (this.comboSeqTimer > 0) return;
    out.push(...this.comboStep());
    this.comboFired += 1;
    this.comboLeft -= 1;
    this.comboSeqTimer = COMBAT.comboHitGap;
  }

  private comboStep(): SimCommand[] {
    const i = this.comboFired;
    const base = this.stage.boss.maxHp * COMBAT.comboBaseRatio * (1 + i * COMBAT.comboHitStep);
    const cmds: SimCommand[] = this.applyBossDamage(base);
    const labels = ['一 段', '二 段', '三 段'];
    const kick = COMBAT.comboKick[i] ?? COMBAT.comboKick[COMBAT.comboKick.length - 1]!;
    cmds.unshift(
      { t: 'fx', fx: 'comboHit', x: this.lastBallX, y: this.lastBallY, text: labels[i] ?? `${i + 1} 段`, color: '#49e6ff', scale: 1.5 },
      { t: 'sound', name: 'comboHit', value: i },
      { t: 'shake', amount: 0.3 + i * 0.06, duration: 0.2 },
    );
    // 推球方向朝上，**三段递减**：最后一段是收势，不该把球又打飞。
    cmds.push({ t: 'boostBall', dirX: 0, dirY: 1, impulse: kick });
    return cmds;
  }

  /**
   * 能量唯一入口。所有加能量的地方（落槽 / 路过聚气带 / 技能旋钮）都必须走这里。
   *
   * 为什么必须收口：`满能量 → 自动放组合技` 是一条**跨系统**的规则，
   * 以前有三处各自 `Math.min(energyMax, ...)`，谁也不知道满格之后会发生什么。
   * 收在一处之后，「满格」这件事只有一个定义，也不会漏掉某一处通道。
   */
  private addEnergy(n: number, out: SimCommand[]): void {
    if (n <= 0) return;
    const before = this.energy;
    this.energy = Math.min(COMBAT.energyMax, this.energy + n);
    if (before < COMBAT.energyMax && this.energy >= COMBAT.energyMax) this.startCombo(out);
  }

  /* ------------------------------------------------- 技能：物理旋钮解释器 */

  /**
   * 读某个旋钮当前的合成值。
   *
   * 乘区相乘，加区相加。传 base 拿的是"没有这个旋钮时"的默认值，
   * 所以调用点全部写成 `this.mod('slot', 1)` 这样的形式——
   * 结算代码完全不知道技能存不存在，没上 buff 时行为和原来一模一样。
   */
  private mod(key: PhysKey, base: number): number {
    let out = ADDITIVE_KEYS.has(key) ? 0 : 1;
    let hit = false;
    for (const m of this.mods.values()) {
      if (m.key !== key) continue;
      hit = true;
      if (ADDITIVE_KEYS.has(key)) out += m.value;
      else out *= m.value;
    }
    return hit ? out : base;
  }

  /** Forecast casting refreshes the caster's existing channels; it does not stack them twice. */
  private modAfterCast(key: PhysKey, base: number, caster: CharacterDef): number {
    const own = caster.skill.mods.filter((m) => m.key === key);
    if (!own.length) return this.mod(key, base);
    const values = [...this.mods.values()].filter((m) => m.key === key && m.charId !== caster.id).map((m) => m.value);
    values.push(...own.map((m) => m.value));
    return ADDITIVE_KEYS.has(key) ? values.reduce((a, b) => a + b, 0) : values.reduce((a, b) => a * b, 1);
  }

  previewSkill(charId: string, x: number, y: number, aimDeg = 90): StrikePreview | null {
    const caster = this.charById(charId);
    if (!caster?.skill.strike || !this.canRelease(charId)) return null;
    return this.buildSkillPreview(caster, x, y, aimDeg);
  }

  private buildSkillPreview(caster: CharacterDef, x: number, y: number, aimDeg: number): StrikePreview {
    const spec = caster.skill.strike!;
    const r = this.stage.rules.enemy;
    const burst = this.modAfterCast('burst', 1, caster);
    const targets = pegsInStrike(spec, this.stage.pegs, x, y, aimDeg)
      .filter((p) => p.kind === 'enemy' && p.hp !== undefined && !this.destroyed.has(p.id))
      .map((p) => {
        const tier = p.wuxing ? wuxingTier(caster.wuxing, p.wuxing).tier : 'same';
        const attr = tier === 'win' ? this.modAfterCast('attrWin', r.attrWin, caster)
          : tier === 'gen' ? this.modAfterCast('attrGen', r.attrGen, caster)
          : tier === 'lose' ? this.modAfterCast('attrLose', r.attrLose, caster) : 1;
        const hp = this.enemyHp.get(p.id) ?? p.hp!;
        const damage = Math.min(hp, Math.max(0, Math.round(spec.damage * burst * attr)));
        return { pegId: p.id, x: p.x, y: p.y, r: p.r, hp, damage, kill: damage >= hp };
      });
    return { charId: caster.id, name: caster.skill.name, color: caster.accent,
      x, y, angleDeg: aimDeg, primitives: buildStrikePrimitives(spec, x, y, aimDeg), targets,
      totalDamage: targets.reduce((sum, p) => sum + p.damage, 0), totalKills: targets.filter((p) => p.kill).length };
  }

  /** 事件驱动叠加：给所有 stackOn 命中该事件的旋钮加一格。 */
  private stackMods(on: StackEvent): void {
    for (const m of this.mods.values()) {
      if (m.stackOn !== on || m.perEvent <= 0) continue;
      m.value = Math.min(m.maxValue, m.value + m.perEvent);
    }
  }

  /** 把某个角色的某个旋钮按当前值重新下发到物理层。 */
  private pushChannel(id: string, key: PhysKey, value: number, duration: number): SimCommand[] {
    switch (key) {
      case 'gravity':
        return [{ t: 'setGravityScale', channel: id, scale: value, duration }];
      case 'speed':
        return [{ t: 'setSpeedScale', channel: id, scale: value, duration }];
      case 'bounce':
        return [{ t: 'setBounceScale', channel: id, scale: value, duration }];
      case 'damping':
        return [{ t: 'setDampingScale', channel: id, scale: value, duration }];
      case 'speedFloor':
        return [{ t: 'setSpeedFloor', channel: id, floor: value, duration }];
      default:
        return [];
    }
  }

  /** 旋钮到期：把该频道从物理层摘掉。 */
  private resetChannel(id: string, key: PhysKey): SimCommand[] {
    if (key === 'speedFloor') return [{ t: 'setSpeedFloor', channel: id, floor: 0, duration: 0 }];
    return [{ t: 'setGravityScale', channel: id, scale: 1, duration: 0 }, ...this.pushChannel(id, key, 1, 0)];
  }

  /** 重新计算所有穿透技能的可穿过钉板并下发。 */
  private refreshGhosts(): SimCommand[] {
    const kinds = new Set<PegKind>();
    for (const p of this.pierces.values()) for (const k of p.kinds) kinds.add(k);
    return [{ t: 'setGhostKinds', channel: 'pierce', kinds: [...kinds], duration: 999 }];
  }

  /** 穿透了某枚钉板时结算伤害。多张卡同时开穿透则伤害相加。 */
  private pierceDamageFor(pegKind: PegKind): number {
    let dmg = 0;
    for (const p of this.pierces.values()) {
      if (p.kinds.includes(pegKind)) dmg += p.damagePerPeg;
    }
    return dmg * this.mod('burst', 1);
  }

  /**
   * 释放技能 = 把一份 JSON 配方翻译成旋钮注册 + 一次性效果。
   *
   * 这里没有任何 `if (技能名 === ...)`：mods / pierce / destroy / chain / force
   * 各自独立解释，加新角色只是多一份 JSON。
   */
  private applyRecipe(charId: string, color: string, x: number, y: number, aimDeg = 90): SimCommand[] {
    const s = this.charById(charId);
    if (!s) return [];
    const cmds: SimCommand[] = [];

    for (const m of s.skill.mods) {
      const id = `${charId}:${m.key}`;
      if (ADDITIVE_KEYS.has(m.key)) {
        if (m.key === 'energy') this.addEnergy(m.value, cmds);
        // critChance 这类加法旋钮只是把加值累进下面的会心判定，不进 mods 通道
        if (m.key !== 'energy') this.mods.set(id, { ...this.newMod(charId, m) });
        continue;
      }
      this.mods.set(id, this.newMod(charId, m));
      cmds.push(...this.pushChannel(id, m.key, m.value, m.duration));
    }

    if (s.skill.strike) {
      const preview = this.buildSkillPreview(s, x, y, aimDeg);
      cmds.push({ t: 'strike', preview });
      this.weapon.casts++;
      this.weapon.hits += preview.targets.length;
      this.weapon.damage += preview.totalDamage;
      const beforeKills = this.enemiesKilled, beforeBoss = this.bossHp;
      for (const target of preview.targets) {
        const peg = this.stage.pegs.find((p) => p.id === target.pegId)!;
        cmds.push(...this.damageEnemy(peg, target.damage, false, 1, peg.x, peg.y, '', true));
      }
      this.weapon.kills += this.enemiesKilled - beforeKills;
      this.weapon.bossDamage += beforeBoss - this.bossHp;
    }

    if (s.skill.pierce) {
      this.pierces.set(charId, {
        charId,
        left: s.skill.pierce.damagePerPeg > 0 ? 99 : 0,
        duration: 0,
        damagePerPeg: s.skill.pierce.damagePerPeg,
        kinds: s.skill.pierce.kinds,
      });
      // 穿透时长跟着同 id 的 speed 旋钮走；没配 speed 就给一个默认窗口
      const speed = s.skill.mods.find((m) => m.key === 'speed');
      const dur = speed?.duration && speed.duration > 0 ? speed.duration : 4;
      this.pierces.get(charId)!.left = dur;
      this.pierces.get(charId)!.duration = dur;
      cmds.push(...this.refreshGhosts());
    }

    if (s.skill.destroy) {
      const ids = this.pegsInRadius(null, x, y, s.skill.destroy.radius, false, s.skill.destroy.kinds);
      if (ids.length) {
        ids.forEach((id) => this.destroyed.add(id));
        cmds.push({ t: 'destroyPegs', pegIds: ids, reason: 'skill' });
      }
      const dmg = s.skill.destroy.damage * this.mod('burst', 1);
      this.score += dmg;
      cmds.push(...this.applyBossDamage(dmg));
      cmds.push({ t: 'fx', fx: 'shockRing', x, y, color, scale: s.skill.destroy.radius / 3 });
      cmds.push({ t: 'shake', amount: 0.75, duration: 0.6 });
    }

    if (s.skill.chain) {
      this.chains.set(charId, {
        charId,
        left: s.skill.mods.find((m) => m.key === 'bounce')?.duration || 5,
        radius: s.skill.chain.radius,
        damage: s.skill.chain.damage,
        wuxing: s.skill.chain.wuxing,
      });
    }

    if (s.skill.force) {
      cmds.push({
        t: 'setForce',
        channel: `force_${charId}`,
        ax: s.skill.force.ax,
        ay: s.skill.force.ay,
        duration: s.skill.mods.find((m) => m.duration > 0)?.duration ?? 4,
      });
    }

    if (s.skill.impulse) {
      const len = Math.hypot(s.skill.impulse.dx, s.skill.impulse.dy) || 1;
      cmds.push({ t: 'boostBall', dirX: s.skill.impulse.dx / len, dirY: s.skill.impulse.dy / len, impulse: s.skill.impulse.power });
    }

    if (s.skill.bossVuln) {
      this.bossVulnLeft = Math.max(this.bossVulnLeft, s.skill.bossVuln.duration);
      this.bossVulnFactor = s.skill.bossVuln.factor;
    }

    if (s.skill.bonusBalls) {
      this.ballsLeft += s.skill.bonusBalls;
      cmds.push({ t: 'fx', fx: 'feverGate', x, y: 20, text: `追加 ${s.skill.bonusBalls} 球`, color, scale: 1.3 });
    }

    if (s.skill.wuxingShift) {
      this.ballWuxingOverride = s.skill.wuxingShift;
      cmds.push({ t: 'fx', fx: 'attrTag', x, y: y + 2, text: `化 ${WUXING_LABEL[s.skill.wuxingShift]}`, color: WUXING_HEX[s.skill.wuxingShift], scale: 1.4 });
    }

    return cmds;
  }

  private newMod(charId: string, m: CharacterDef['skill']['mods'][number]): ActiveMod {
    return {
      charId,
      key: m.key,
      value: m.value,
      perEvent: m.perEvent ?? 0,
      maxValue: m.maxValue ?? m.value,
      stackOn: m.stackOn ?? null,
      left: m.duration,
      duration: m.duration,
    };
  }

  /* ---------------------------------------------------------------- 连携 */

  private tryLinks(x: number, y: number): SimCommand[] {
    const cmds: SimCommand[] = [];
    // 三卡连携优先级最高：玩家锁定双卡来攒终极技时不会被抢触发
    const ordered = [...this.links].sort((a, b) => rank(b) - rank(a));
    for (const link of ordered) {
      if (this.lockedLinks.has(link.id)) continue;
      if (this.active.has(link.id) || (this.linkCooldown.get(link.id) ?? 0) > 0) continue;
      if (this.energy < link.require.energy) continue;
      if (!link.require.conditions.every((c) => this.testCondition(c))) {
        if (link.require.mode !== 'any') continue;
        if (!link.require.conditions.some((c) => this.testCondition(c))) continue;
      }
      cmds.push(...this.triggerLink(link, x, y));
    }
    return cmds;
  }

  /** 锁定/解锁连携。锁定后条件满足也不会自动触发。 */
  toggleLinkLock(linkId: string): boolean {
    if (this.lockedLinks.has(linkId)) {
      this.lockedLinks.delete(linkId);
      return false;
    }
    this.lockedLinks.add(linkId);
    return true;
  }

  isLinkLocked(linkId: string): boolean {
    return this.lockedLinks.has(linkId);
  }

  private testCondition(cond: LinkCondition): boolean {
    switch (cond.c) {
      case 'gaugeFull': {
        const g = this.gauges.find((x2) => x2.charId === cond.charId);
        return !!g && g.value >= g.max;
      }
      case 'modActive':
        for (const m of this.mods.values()) {
          if (m.key === cond.key && m.left > 0) return true;
        }
        return false;
      case 'comboAtLeast':
        return this.combo >= cond.value;
      case 'slotsHitAtLeast':
        return this.slotsHit >= cond.value;
    }
  }

  /**
   * 连携干了什么的**人话摘要**。
   *
   * 摘要直接从 LinkEffect 的数字里长出来，而不是另写一句文案——
   * 策划把 slotFactor 从 2.2 调到 2.4 时，屏幕上那句话自动跟着变，
   * 不会出现「说一套做一套」。这是「盘面自解释」能不能长期成立的关键。
   */
  private linkSummary(e: LinkEffect): string {
    const parts: string[] = [];
    if (e.ghostDuration > 0) parts.push(`钉阵全失效 ${e.ghostDuration}s`);
    if (e.slotFactor !== 1) parts.push(`落槽 ×${e.slotFactor}`);
    if (e.bossVulnFactor > 1) parts.push(`Boss 承伤 ×${e.bossVulnFactor}`);
    if (e.destroyRadius > 0) parts.push(`拔钉 r${e.destroyRadius}`);
    if (e.detonateDamage > 0) parts.push(`连锁引爆 ${e.detonateDamage}`);
    if (e.speedScale !== 1) parts.push(`球速 ×${e.speedScale}`);
    if (e.impulse > 0) parts.push(`推力 ${e.impulse}`);
    return parts.slice(0, 3).join('　') || `持续 ${e.duration}s`;
  }

  private triggerLink(link: LinkDef, x: number, y: number): SimCommand[] {
    const e = link.effect;
    this.energy = Math.max(0, this.energy - link.require.energy);
    // 条件里涉及的充能被消耗掉，让连携形成资源循环
    for (const cond of link.require.conditions) {
      if (cond.c === 'gaugeFull') {
        const g = this.gauges.find((v) => v.charId === cond.charId);
        if (g) g.value = 0;
      }
    }

    this.active.set(link.id, {
      left: e.duration,
      duration: e.duration,
      slotFactor: e.slotFactor,
      chainDetonate: e.chainDetonate,
      detonateDamage: e.detonateDamage,
      destroyRadius: e.destroyRadius,
    });

    const cmds: SimCommand[] = [
      { t: 'fx', fx: e.fx, x, y, text: link.name, color: link.color, scale: 2.2 },
      // 连携名只是标签，不是解释。玩家看到「倒拔擎天柱」五个字，
      // 既不知道它干了什么，也不知道下一次该怎么攒——摘要必须挂在名字下面。
      { t: 'fx', fx: 'linkSummary', x, y: y - 1.8, text: this.linkSummary(e), color: link.color, scale: 1.15 },
      { t: 'flash', color: link.color, duration: 0.45 },
      { t: 'shake', amount: 0.85, duration: 0.7 },
      { t: 'sound', name: 'link' },
    ];
    this.pushLog(`连携 · ${link.name}`);

    if (e.ghostDuration > 0) {
      cmds.push({
        t: 'setGhostKinds',
        channel: `link_${link.id}`,
        kinds: ['normal', 'destructible', 'golden'],
        duration: e.ghostDuration,
      });
    }
    if (e.destroyRadius > 0) {
      const ids = this.pegsInRadius(null, x, y, e.destroyRadius, false);
      if (ids.length) {
        ids.forEach((id) => this.destroyed.add(id));
        cmds.push({ t: 'destroyPegs', pegIds: ids, reason: 'link' });
      }
    }
    if (e.speedScale !== 1) {
      cmds.push({ t: 'setSpeedScale', channel: `link_${link.id}`, scale: e.speedScale, duration: e.duration });
    }
    if (e.impulse > 0) cmds.push({ t: 'boostBall', dirX: 0, dirY: 1, impulse: e.impulse });
    if (e.bossVulnFactor > 1) {
      this.bossVulnLeft = Math.max(this.bossVulnLeft, e.bossVulnDuration);
      this.bossVulnFactor = e.bossVulnFactor;
    }
    return cmds;
  }

  private linkSlotFactor(): number {
    let f = 1;
    for (const l of this.active.values()) f *= l.slotFactor;
    return f;
  }

  /* ---------------------------------------------------------------- Boss */

  /** 当前生效的相位定义（phaseIndex = -1 时是 null）。 */
  private phaseDef(): BossPhaseDef | null {
    return this.phaseIndex >= 0 ? this.stage.boss.phases[this.phaseIndex] ?? null : null;
  }

  /**
   * 把一条相位的 `over` 和 `PHASE` 的默认值合并成一份可执行的档位。
   *
   * 合并在 sim 里而不是物理层：sim 已经知道当前吃哪几个维度，
   * 让 PhysicsBoard 再去读一遍 stage 数据、算一遍合并，就是两处真相。
   */
  static knobsFor(phase: BossPhaseDef | null): PhaseKnobs {
    const out: PhaseKnobs = {};
    for (const d of phase?.deprive ?? []) {
      out[d] = { ...PHASE[d], ...(phase?.over?.[d] ?? {}) } as AimKnobs & AmmoKnobs & TimeKnobs;
    }
    return out;
  }

  /** 快照里那份「Boss 现在拿走了什么」。HUD 与物理层都以它为准。 */
  private phaseDeprivationState(): BattleSnapshot['phaseDeprivation'] {
    const phase = this.phaseDef();
    const knobs = BattleSim.knobsFor(phase);
    return {
      list: phase?.deprive ?? [],
      ballScale: knobs.ammo?.ballScale ?? 1,
      weakScale: knobs.aim?.weakScale ?? 1,
      noRescue: knobs.ammo?.noRescue === true,
      lateralG: knobs.time?.lateralG ?? 0,
    };
  }

  private effectiveArmor(): number {
    // 旧版这里会按 'shield' 相位把护甲硬拉到 35%：那是个**读不出来**的难度旋钮
    // （11 关的护甲在 0.2~0.36 之间抖动，玩家看不出差别，只会觉得「这关莫名打不动」）。
    // 现在护甲只由关卡数据决定，剥夺全部走 aim / ammo / time 三个看得见的维度。
    const base = this.stage.boss.armor;
    // 確変期间减伤打折：这是「口开着的时候 Boss 挡不住」的手感来源
    if (this.feverLeft > 0) return base * (1 - this.stage.rules.fever.armorRelief);
    return base;
  }

  /* ------------------------------------------------------------- 確変 */

  /** 確変期间的落槽倍率：基础值每多一档连打多叠一档 */
  private feverMult(): number {
    const f = this.stage.rules.fever;
    if (this.feverLeft <= 0) return 1;
    return f.slotFactor * (1 + this.feverChain * f.chainStep);
  }

  private startFever(x: number, y: number): SimCommand[] {
    const f = this.stage.rules.fever;
    const fresh = this.feverLeft <= 0;
    this.feverLeft = f.duration;
    this.feverRenda = fresh ? 0 : this.feverRenda;
    if (fresh) {
      this.feverTimes++;
      this.feverChain = 0;
    }
    this.feverRenda++;
    this.feverBest = Math.max(this.feverBest, this.feverRenda);
    // 追加球只在本局第一次確変时给。
    // 触发槽 slot_weak 本身就是打 Boss 的槽——如果每次確変都补球，
    // 「补球 → 多打 → 再打中触发槽 → 再补球」会自喂成一局 27 球 / 99 秒，
    // 预算彻底作废。第一次是仪式感，之后的確変靠開闸 + 連打倍率兑现刺激。
    // 注意：不能用 feverTimes === 1 来判断「第一次」——首次確変的 14 秒窗口内
    // 每打一次破绽口都会再次走 startFever，那段时间里 feverTimes 一直是 1。
    let grantedBonus = false;
    if (!this.feverBonusGiven) {
      this.feverBonusGiven = true;
      this.ballsLeft += f.bonusBalls;
      grantedBonus = true;
    }
    this.pushLog(`確変 ${f.duration.toFixed(0)}s · 连打 ${this.feverRenda}`);

    const cmds: SimCommand[] = [{ t: 'feverGate', on: true }];
    if (fresh) {
      // 入场才给整套大演出：闪光 + 震屏 + 役物点亮，一局最多来一次，不能滥用
      cmds.push({ t: 'flash', color: f.palette.accent, duration: 0.5 });
      cmds.push({ t: 'shake', amount: 0.55, duration: 0.5 });
      cmds.push({ t: 'sound', name: 'link' });
      cmds.push({ t: 'fx', fx: 'feverStart', x, y, text: '確 変', color: f.palette.accent, scale: 2 });
      if (grantedBonus) {
        cmds.push({ t: 'fx', fx: 'feverGate', x, y: this.stage.weakPoint.y, text: `追加 ${f.bonusBalls} 球`, color: f.palette.led, scale: 1.3 });
      }
    }
    cmds.push({ t: 'fx', fx: 'renda', x, y, text: `${this.feverRenda} 連打 ×${this.feverMult().toFixed(2)}`, color: f.palette.led, scale: 1.2 });
    return cmds;
  }

  private endFever(): SimCommand[] {
    this.feverLeft = 0;
    this.feverChain = 0;
    this.pushLog('確変 结束');
    return [
      { t: 'feverGate', on: false },
      { t: 'fx', fx: 'feverEnd', x: 0, y: 0, text: `最高 ${this.feverBest} 連打`, color: '#c9ae92', scale: 1.2 },
    ];
  }

  private applyBossDamage(dmg: number): SimCommand[] {
    if (dmg <= 0 || this.phase !== 'playing') return [];
    const vuln = this.bossVulnLeft > 0 ? this.bossVulnFactor : 1;
    // 清空小怪的加成走这里，所以五处打 Boss 的通道（破绽口 / 连锁 / 落槽 /
    // 武器摧毁 / 击坠）自动统一，玩家看到的是同一个倍率。
    const applied = Math.max(1, Math.round(dmg * (1 - this.effectiveArmor()) * vuln * this.sweepMult()));
    this.totalDamage += applied;
    this.bossHp = Math.max(0, this.bossHp - applied);
    return this.checkPhase();
  }

  private checkPhase(): SimCommand[] {
    const ratio = this.bossHp / this.stage.boss.maxHp;
    const cmds: SimCommand[] = [];
    for (let i = this.phaseIndex + 1; i < this.stage.boss.phases.length; i++) {
      const p = this.stage.boss.phases[i]!;
      if (ratio > p.at) continue;
      this.phaseIndex = i;
      this.phaseName = p.name;
      this.pushLog(`Boss 阶段 · ${p.name}`);
      cmds.push({ t: 'bossPhase', index: i, name: p.name, deprive: p.deprive, knobs: BattleSim.knobsFor(p) });
      cmds.push({ t: 'fx', fx: `bossPhase_${p.deprive[0] ?? 'none'}`, x: 0, y: 0, text: p.name, color: this.stage.boss.colors.glow });
      cmds.push({ t: 'flash', color: this.stage.boss.colors.glow, duration: 0.5 });
      cmds.push({ t: 'shake', amount: 0.6, duration: 0.6 });
      /*
       * 剥夺必须有一句人话。盘面在动、倒计时在缩，这些都是「看得见但说不清」的，
       * 不印出来玩家只会当成 bug——尤其是救球窗口突然没了。
       * 印的是「拿走了什么」而不是数值（数值在 HUD 的倒计时和相位条上）。
       */
      for (const d of p.deprive) {
        cmds.push({
          t: 'fx',
          fx: 'deprivation',
          x: 0,
          y: 0,
          text: `${DEPRIVATION_LABEL[d]}　${DEPRIVATION_HINT[d]}`,
          color: this.stage.boss.colors.glow,
          scale: 1.15,
        });
      }
    }
    return cmds;
  }

  /* --------------------------------------------------------------- 工具 */

  private comboMult(): number {
    return Math.min(COMBAT.comboMaxMult, 1 + this.combo * COMBAT.comboStep);
  }

  /**
   * 小怪清空进度。**由存活数反推，不累加**——
   * 恢复池会复活已打倒的五行靶点，累加的话进度会越打越多，玩家能靠反复复活
   * 把清空倍率堆到满还不用真打。反推则天然跟着盘面走。
   */
  get minionTotal(): number {
    return this.stage.pegs.filter((p) => p.kind === 'enemy').length;
  }

  get sweptCount(): number {
    return this.minionTotal - this.minionsAlive;
  }

  get minionsAlive(): number {
    return this.stage.pegs.filter((p) => p.kind === 'enemy' && !this.destroyed.has(p.id)).length;
  }

  /**
   * 收工时还站着的���怪坐标。
   *
   * 清场是通关条件，所以「一局打不完」有两种完全不同的修法：
   *  · 小怪只是很难碰到（盘面不够密 / 球道不对）——加钉、挪落点；
   *  · 小怪根本**碰不到**（被封在缝里）——那是生成契约的漏洞，加多少球都没用。
   * 报出坐标才能分辨，否则两种都只能靠「多加几个球」碰运气。
   */
  aliveMinionSpots(): { x: number; y: number }[] {
    return this.stage.pegs
      .filter((p) => p.kind === 'enemy' && !this.destroyed.has(p.id))
      .map((p) => ({ x: p.x, y: p.y }));
  }

  /**
   * 清空进度换来的 Boss 伤害倍率。
   *
   * 刻意**乘在 `applyBossDamage` 里面**而不是各调用点分别乘：现在有五处会打 Boss
   * （破绽口直击、连锁引爆、落槽、武器摧毁、击坠），漏一处玩家就会看到「同一波
   * 操作，清空前后伤害对不上」。集中在一处改，才对得起「一个数字只有一处定义」。
   */
  sweepMult(): number {
    return 1 + this.sweptCount * this.stage.rules.enemy.perSweep;
  }

  private pegsInRadius(
    excludeId: string | null,
    x: number,
    y: number,
    radius: number,
    includeArmored: boolean,
    only?: PegKind[],
  ): string[] {
    const r2 = radius * radius;
    const out: string[] = [];
    for (const p of this.stage.pegs) {
      if (p.id === excludeId || this.destroyed.has(p.id)) continue;
      if (!includeArmored && p.kind === 'armored') continue;
      if (only && !only.includes(p.kind)) continue;
      const dx = p.x - x;
      const dy = p.y - y;
      if (dx * dx + dy * dy <= r2) out.push(p.id);
    }
    return out;
  }

  /**
   * 活跃 buff 列表。直接由旋钮表生成——
   * 玩家看到的每一个 buff 条背后都是一个物理通道，UI 不需要认识技能。
   */
  private buffList() {
    const out: { key: string; label: string; color: string; left: number; duration: number; mult: number }[] = [];
    for (const [id, m] of this.mods) {
      if (m.left <= 0) continue;
      out.push({
        key: id,
        label: PHYS_KEY_LABEL[m.key],
        color: this.charById(m.charId)?.color ?? '#ffb454',
        left: m.left,
        duration: Math.max(m.duration, 0.01),
        mult: m.value,
      });
    }
    for (const [id, p] of this.pierces) {
      if (p.left <= 0) continue;
      out.push({
        key: `pierce_${id}`,
        label: '贯穿',
        color: this.charById(id)?.color ?? '#7ad7ff',
        left: p.left,
        duration: Math.max(p.duration, 0.01),
        mult: p.damagePerPeg,
      });
    }
    if (this.bossVulnLeft > 0) {
      out.push({
        key: 'bossVuln',
        label: 'Boss 破防',
        color: '#ff5470',
        left: this.bossVulnLeft,
        duration: this.bossVulnLeft,
        mult: this.bossVulnFactor,
      });
    }
    return out;
  }

  private linkList(): LinkState[] {
    return this.links.map((l) => {
      const a = this.active.get(l.id);
      const armed = l.require.conditions.some((c) => this.testCondition(c));
      return {
        linkId: l.id,
        name: l.name,
        color: l.color,
        active: !!a,
        left: a?.left ?? 0,
        duration: a?.duration ?? 1,
        cooldown: this.linkCooldown.get(l.id) ?? 0,
        locked: this.lockedLinks.has(l.id),
        armed,
      };
    });
  }

  private pushLog(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }
}
