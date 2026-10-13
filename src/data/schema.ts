/**
 * 数据驱动 Schema（规划 §11）。
 * 角色、技能、连携、关卡、卡牌全部走 JSON，Runtime 只解释数据。
 * 任何战斗平衡参数都必须能在这几个文件里改，禁止硬编码到场景。
 */

export type Rarity = 'R' | 'SR' | 'SSR' | 'UR';

export type PegKind = 'normal' | 'spear' | 'destructible' | 'armored' | 'weak' | 'golden' | 'enemy';

/* ------------------------------------------------------------------ 五行 */

/**
 * 五行：金木水火土。
 *
 * 为什么是五行而不是「光/闇」那类二元对立：柏青哥一局要同时挂十几个敌人钉，
 * 玩家得在**队形**层面就想清楚「我这队打谁好打」。二元对立只能分两拨，
 * 五行则让每一行都同时有克它的和被它克的，选择才是真选择。
 */
export type Wuxing = 'metal' | 'wood' | 'water' | 'fire' | 'earth';

/** 相克：金克木、木克土、土克水、水克火、火克金。查表而不是写 if。 */
export const WUXING_BEATS: Record<Wuxing, Wuxing> = {
  metal: 'wood',
  wood: 'earth',
  earth: 'water',
  water: 'fire',
  fire: 'metal',
};

/**
 * 相生：金生水、水生木、木生火、火生土、土生金。
 *
 * 相生不是"平局"，是**助长**：我这一行生对方，对方被打得更疼，我也跟着吃收益。
 * 系数比相克低一档，位置放在"打不克我但我也不克他"的中间档，
 * 逼玩家在克制链上找断点，而不是无脑堆同一个属性。
 */
export const WUXING_GENERATES: Record<Wuxing, Wuxing> = {
  metal: 'water',
  water: 'wood',
  wood: 'fire',
  fire: 'earth',
  earth: 'metal',
};

export const WUXING_LABEL: Record<Wuxing, string> = {
  metal: '金',
  wood: '木',
  water: '水',
  fire: '火',
  earth: '土',
};

/** attr → 灯色。敌人钉的本体、LED 与伤害数字共用这一套，看起来才像一家人。 */
export const WUXING_HEX: Record<Wuxing, string> = {
  metal: '#e8d9a0',
  wood: '#7de08a',
  water: '#4fc3ff',
  fire: '#ff7a45',
  earth: '#c98a5b',
};

/**
 * 攻方对守方的相性档位。返回 { tier, mult }。
 * tier 供 UI 飘字用（「克制」/「相生」/「同属」/「逆势」）。
 *
 * 判定顺序有讲究：先判克制，再判相生，最后才是逆势。
 * 五行环上「克我」和「我生」对同一行是同时成立的（比如水既被金克、也生木），
 * 必须让克制优先，否则金打水会被算成相生，白送一个正收益。
 *
 * 「同属」必须单独一档：五行一共围出 5 种关系——我克、我生、同属、克我、生我，
 * 只给三档的话同属会掉进 else 变成「逆势 ×0.7」，等于无缘无故罚玩家用顺手的队形。
 * 它是中立，倍率为 1，飘字写「同属」。
 *
 * 最后一档为什么叫「逆势」而不是「被克」：火打水是真正的被克（水克火），
 * 但火打木同样落进这一档——因为木生火，打的是自己的源头。
 * 严格拆开需要五档，而五档意味着要为「生我」单开一个属性维度，那正是这次删掉的
 * 东西。所以这里刻意把「克我」和「生我」合成一档：两者在弹珠的伤害循环里读起来是
 * 同一句话——**这颗钉不是你的猎物**。倍率给 attrLose，飘字写「逆势」，不撒谎。
 */
export function wuxingTier(attacker: Wuxing, defender: Wuxing): { tier: 'win' | 'gen' | 'same' | 'lose'; mult: number } {
  if (attacker === defender) return { tier: 'same', mult: 0 };
  if (WUXING_BEATS[attacker] === defender) return { tier: 'win', mult: 1 };
  if (WUXING_GENERATES[attacker] === defender) return { tier: 'gen', mult: 0.5 };
  return { tier: 'lose', mult: -1 };
}


/**
 * 敌人钉战斗参数。抄《怪物弹珠》的核心公式：
 * 「速度越快，反弹次数越多，能造成的伤害就越大」——所以伤害是**撞击次数**的函数，
 * 不是弹丸初始速度的函数。这正是「打得准不如打得久」那种手感的来源。
 */
export interface EnemyRules {
  /** 基础伤害 */
  baseDamage: number;
  /** 每多一次反弹加多少伤害 */
  perBounce: number;
  /** 反弹加成最多叠到第几次 */
  bounceMax: number;
  /** 相克倍率 */
  attrWin: number;
  /** 相生倍率（1.0 表示相生不吃亏也没好处，>1 才是"助长"） */
  attrGen: number;
  /** 逆势倍率（既不克它也不生它的那一档，含"克我"与"生我"，见 wuxingTier） */
  attrLose: number;
  /** 会心概率 */
  critChance: number;
  /** 会心倍率 */
  critMult: number;
  /** 击坠敌人后球的加速（沿碰撞反方向推），让连续击杀能一路滚下去 */
  killBoost: number;
  /**
   * **每清空一枚小怪**，之后对 Boss 的伤害 +这么多（1 = +100%，0.5 = +50%）。
   *
   * 取代旧版的 `killDamage`（击坠一枚直接扣 110 点 Boss 血）。旧版的问题不是数值
   * 大小，是**角色定位错了**：击坠是「清场进度」，不是「伤害来源」。小怪自己就有独立
   * 血条，玩家在清它们；只有清空之后，Boss 才进入「被打得动」的阶段。两者混成
   * 一件事的直接后果是——玩家跳过大怪只打小怪也能赢，而跳过小怪直接打大怪的
   * 「专精路线」完全没有回报，那条路线就不存在了。
   *
   * 叠成加法而不是相乘：五枚小怪对应一个线性区间，玩家能一眼看出还剩几枚能换
   * 多少伤害，不用心算 `1.3^3`。
   */
  perSweep: number;
  /**
   * 全部清空时，在逐枚加成之外**再**给的一次 Boss 伤害，直接扣血。
   * 没有这条的话，最后一枚小怪和第一枚给的好处完全一样，「打完一整轮」这个
   * 时刻就没有单独的仪式感，而那正是小怪系统存在的意义。
   */
  fullSweepDamage: number;
  /**
   * 击射预算用完时，**每剩一枚**小怪从最终得分里扣的比例。
   *
   * 为什么是扣分不是判负：小怪总数和血量都随关卡变，硬判负会让「打得慢但打得准」
   * 和「打得快但漏了几枚」之间没有回旋余地。扣分保住了压力，也保住了翻盘。
   */
  leftoverPenalty: number;
}

export type ZoneKind = 'normal' | 'energy' | 'combo' | 'skill' | 'multiplier' | 'boss';

export type SlotKind = 'normal' | 'energy' | 'combo' | 'skill' | 'multiplier' | 'boss';

/* ------------------------------------------------------------------ 技能 */

/**
 * 技能 = 一份**物理配方**，不是一个 if 分支。
 *
 * 为什么要这么设计：早期版本给武松/林冲/鲁智深各写了一个 `SkillEffect` 子类型
 * （berserk / pierce / shockwave），Runtime 里对应三个 switch 分支。
 * 看起来很干净，但加第 4 个角色就意味着再加一个子类型、再加一个分支——
 * "扩到第 108 将不改核心代码"这条硬约束当场就破了。
 *
 * 现在 Runtime 只实现下面这些**原子旋钮**，每个角色的技能是 JSON 里的一份配方。
 * 旋钮之间可组合、可叠加、顺序无关，加角色只加数据。
 * 代价是失去了"每个技能一段专属演出"的写法——用 fx 字段补回来。
 */
export type SkillTriggerEvent =
  | 'pegImpact'
  | 'spearHit'
  | 'heavyImpact'
  | 'enemyKill'
  | 'slotEnter'
  | 'zoneSkill'
  | 'none';

export interface SkillTrigger {
  /** 充能所依据的物理事件 */
  on: SkillTriggerEvent;
  /** 判定为有效一次充能所需的最小冲击强度（0..1） */
  minIntensity: number;
  /** 充满所需的有效次数 */
  charges: number;
  /** 每次充能获得的进度（默认 1） */
  perHit: number;
  /**
   * 被动技能：战斗一开始旋钮就常驻生效，不充能、不占 Digit 键位。
   *
   * **只给「没有决策成分」的技能开**——判据是 `SkillRecipe` 里除 `mods` 外
   * 一件都没有（没有 strike / pierce / destroy / chain / force / impulse /
   * bossVuln / extraBalls）。理由和删掉 Q 键聚气是同一条：
   * 一个不能瞄准、不能选目标、不能预判时机的技能，按键只是在「想起来的时候」
   * 按一下，那不叫操作；而公孙胜这类改天气的旋钮，理想状态本就是「她在那儿就生效」。
   *
   * 全 36 将实测分类：15 个纯旋钮（候选），21 个有决策成分（必须留在主动）。
   * 被动化实测（12 关 × 8 种子）不会把数值抬高——重力 ×0.55 让球飘着反而少撞钉，
   * 钉击中位 366→360、落槽 15.1→14.8，是收敛而非膨胀。
   *
   * 注意 mods 的 `duration` 仍要写 0（整局常驻），这里只表达「不靠按键触发」。
   */
  auto?: boolean;
}

/** 技能能改写的物理量。Runtime 里每个 key 对应一处真实生效点。 */
export type PhysKey =
  /** 全局重力倍率。>1 加速下落，0..1 减缓下落 */
  | 'gravity'
  /** 球速倍率 */
  | 'speed'
  /** 球速下限（bu/s）。球在阵型死角快停住时兜底 */
  | 'speedFloor'
  /** 碰撞恢复系数倍率 → 直接改反弹次数，怪物弹珠伤害公式的主变量 */
  | 'bounce'
  /** 线性阻尼倍率。<1 = 球不容易被磨停 */
  | 'damping'
  /** 落槽伤害倍率。配 perEvent + maxValue + stackOn 就能做「越撞越贵」的叠增 */
  | 'slot'
  /** 即时伤害倍率（贯穿、连锁引爆、震荡） */
  | 'burst'
  /** 每次反弹的伤害加成倍率 */
  | 'bounceDamage'
  /** 相克倍率 */
  | 'attrWin'
  /** 相生倍率 */
  | 'attrGen'
  /** 被克倍率 */
  | 'attrLose'
  /** 会心率加成（加算） */
  | 'critChance'
  /** 会心倍率 */
  | 'critMult'
  /** 共享能量（释放瞬间一次性结算，不参与叠乘） */
  | 'energy';

/** 叠加计数的触发时机。写进 PhysMod，Runtime 按事件给同类 mod 累加。 */
export type StackEvent = 'pegHit' | 'enemyKill' | 'slotEnter';

/**
 * 旋钮的中文名。Sim 的 buff 条和 UI 的连携条件提示共用这一份。
 *
 * 这张表同时是「旋钮是否真被 Runtime 读了」的清单：往里加一个 key 而没有
 * 对应的 mod() 调用点，就是往数据层塞一个永远不生效的假旋钮——
 * skills 不报错、buff 条照常显示、战斗毫无变化，最难查的一类坑。
 * comboRamp 就是这么被删掉的：它和「slot + perEvent + maxValue + stackOn」
 * 是同一件事，两条路留给数据只会挑错。
 */
export const PHYS_KEY_LABEL: Record<PhysKey, string> = {
  gravity: '重力',
  speed: '球速',
  speedFloor: '速度下限',
  bounce: '弹性',
  damping: '阻尼',
  slot: '落槽',
  burst: '爆伤',
  bounceDamage: '弹伤',
  attrWin: '克制',
  attrGen: '相生',
  attrLose: '抗逆势',
  critChance: '会心',
  critMult: '会心倍率',
  energy: '能量',
};

export interface PhysMod {
  key: PhysKey;
  /** 绝对倍率：存在时替代默认值，同类跨卡相乘；critChance 为加算增量 */
  value: number;
  /** 持续秒数。0 = 整局常驻 */
  duration: number;
  /** 每次 stackOn 事件额外叠加多少 */
  perEvent?: number;
  /** 叠加上限值 */
  maxValue?: number;
  /** 叠加以什么为触发 */
  stackOn?: StackEvent;
}

/** 穿透：球可以无视这些类型的钉板，每穿过一枚即时结算伤害。 */
export interface PierceSpec {
  kinds: PegKind[];
  /** 每穿过一枚钉板造成的即时伤害 */
  damagePerPeg: number;
}

/** 盘面改写：半径内的钉板直接消失，同时结算一次伤害。 */
export interface DestroySpec {
  radius: number;
  kinds: PegKind[];
  damage: number;
}

/** 从弹珠位置施放的武器范围。重复线为同时平行条带，单个目标只伤害一次。 */
export interface StrikeSpec {
  shape: 'line' | 'circle';
  /** 线半长 / 圆半径，世界单位 */
  radius: number;
  halfWidth?: number;
  /** 基准瞄准90°时的世界方向；实际方向为此值 + aimDeg - 90 */
  angleDeg?: number;
  repeat?: { times: number; offset: number };
  origin: 'ball';
  kinds: PegKind[];
  /** 敌人HP伤害，吃共享burst和施法者五行，不直接扣Boss */
  damage: number;
}

/** 连锁：命中任意钉板时，把伤害弹给半径内其它敌人。 */
export interface ChainSpec {
  radius: number;
  damage: number;
  /** 连锁伤害带哪个属性，吃五行相生相克 */
  wuxing: Wuxing;
}

/** 持续外力：给球施加一个恒定加速度，用来"推"而不是"改"。 */
export interface ForceSpec {
  ax: number;
  ay: number;
}

export interface SkillRecipe {
  /** 一句话说明它改了哪条物理规则 */
  rule: string;
  desc: string;
  trigger: SkillTrigger;
  /** 乘区 / 加区旋钮 */
  mods: PhysMod[];
  strike?: StrikeSpec;
  pierce?: PierceSpec;
  destroy?: DestroySpec;
  chain?: ChainSpec;
  force?: ForceSpec;
  /** 追加弹珠数 */
  bonusBalls?: number;
  /** 释放瞬间把球的五行临时改成这个值 */
  wuxingShift?: Wuxing;
  /** Boss 破防：持续期间 Boss 受到的伤害乘这个 */
  bossVuln?: { factor: number; duration: number };
  /** 给当前弹珠一记冲量 */
  impulse?: { dx: number; dy: number; power: number };
  fx: string;
}

export interface SkillDef extends SkillRecipe {
  id: string;
  name: string;
}

/* ------------------------------------------------------------------ 角色 */

/**
 * 立绘的视觉方向。只被生图管线（scripts/genart.ts）消费，不参与任何战斗逻辑。
 *
 * 为什么要单独一块：共用一套「性感剪裁」描述会让所有角色收敛成同一个模板——
 * 同样的脸、同样的丸子头、同样的束带紧身衣，只换颜色。差异化必须逐角色写死：
 * 原型对应的性转设定、脸、体型、发型剪影、道具、姿势各给各的。
 */
export interface ArtBrief {
  /** 原型 → 性转的转换说明，例如「头陀短寸 + 虎皮围腰」 */
  archetype: string;
  /** 脸：年龄感、轮廓、眼神、气质 */
  face: string;
  /** 体型：高矮胖瘦、肩宽腰胯比例 */
  body: string;
  /** 发型（必须与其他角色明显不同） */
  hair: string;
  /** 服装剪裁：仍然性感、但靠结构与织物张力表现，不裸露 */
  costume: string;
  /** 剪影标识：一眼认出这个角色的道具或轮廓特征 */
  silhouette: string;
  /** 姿势与镜头 */
  pose: string;
  /** 该角色专属的避雷项 */
  avoid?: string;
}

/**
 * 卡面闪卡样式。数据驱动——同一套 shader 按这个开关走不同分支，
 * 加第 108 将时只改 JSON，不动核心代码。
 *
 * - `none` 普通卡：没有全息层，稀有度只体现在外框颜色上
 *               （UR 彩虹 / SSR 银 / SR 紫 / R 蓝）。
 * - `gold` 金闪卡：一个大圆形金色光斑跟着鼠标走，圆心在指针、半径 50% 卡面，
 *               中间最亮、向外渐暗。
 * - `auto` 游走闪卡：斜向扫光带自动来回巡游，不用鼠标也一直亮着。
 */
export type HoloMode = 'none' | 'gold' | 'auto';

export interface CharacterDef {
  id: string;
  number: number;
  name: string;
  title: string;
  rarity: Rarity;
  /** 五行。全局只有这一个属性维度，敌人钉、队形克制、技能改写共用它 */
  wuxing: Wuxing;
  role: string;
  color: string;
  accent: string;
  tagline: string;
  lore: string;
  base: { hp: number; atk: number; def: number; speed: number };
  skill: SkillDef;
  card: { rarity: Rarity; holo: HoloMode; motif: string };
  /** 立绘视觉方向；缺省时生图管线退回到通用描述 */
  art?: ArtBrief;
  /** 可搭配的角色 id，用于图鉴羁绊展示 */
  bonds: string[];
}

/* ------------------------------------------------------------------ 连携 */

/**
 * 连携触发条件。
 *
 * 刻意不给 `berserkActive` / `pierceActive` 这类"某某技能开着"的条件：
 * 技能已经改成数据配方的写法，Runtime 不知道"狂暴"是什么，只知道"bounce 旋钮是开的"。
 * 写死技能名等于把数据模型又绑回代码，加角色时又得动 switch。
 */
export type LinkCondition =
  | { c: 'gaugeFull'; charId: string }
  /** 任意一枚 PhysMod 旋钮处于激活状态（按 key 判定，不认技能名） */
  | { c: 'modActive'; key: PhysKey }
  | { c: 'comboAtLeast'; value: number }
  | { c: 'slotsHitAtLeast'; value: number };

export interface LinkRequire {
  mode: 'all' | 'any';
  conditions: LinkCondition[];
  /** 需要扣除的共享能量 */
  energy: number;
}

/**
 * 连携效果。字段全部可选，按 kind 取用。
 * 硬性要求（规划 §5 验收 4）：连携必须改盘面 / 改弹珠 / 改战斗状态三者之一，
 * 这里 ghostDuration / speedScale / slotFactor / destroyRadius / bossVuln 共同保证这一点。
 */
export interface LinkEffect {
  kind: 'formationBreak' | 'boardBurst' | 'chainDetonate' | 'ultimateWipe';
  duration: number;
  /** 盘面上所有普通钉板变为可穿过状态的持续时间 */
  ghostDuration: number;
  speedScale: number;
  /** 持续期间落槽伤害倍率 */
  slotFactor: number;
  /** 半径内钉板直接摧毁 */
  destroyRadius: number;
  /** 给当前弹珠的推力 */
  impulse: number;
  /** Boss 破防倍率与时长 */
  bossVulnFactor: number;
  bossVulnDuration: number;
  /** 连锁引爆：贯穿中触碰钉板会引爆其周围钉板 */
  chainDetonate: boolean;
  /** 每引爆一枚钉板的即时伤害 */
  detonateDamage: number;
  fx: string;
}

export interface LinkDef {
  id: string;
  name: string;
  tier: 'dual' | 'triple';
  members: string[];
  color: string;
  desc: string;
  require: LinkRequire;
  effect: LinkEffect;
}

/* ------------------------------------------------------------------ 关卡 */

export interface WallDef {
  id: string;
  x: number;
  y: number;
  /** 半宽 / 半高 */
  w: number;
  h: number;
  rotDeg: number;
  role: 'wall' | 'deflector';
  /**
   * 标了这两个值，这面墙就**不是墙，是玩家能按的翻板**。
   *
   * 为什么写在 `WallDef` 上而不是新开一个 `flippers` 数组：翻板的静止姿态
   * 就是原来那两根静态斜条（horn_l / horn_r），它们本来就在 `deflectors` 里
   * 参与球道整形。标一个字段等于「原地升级成可操作件」，
   * 关卡的板位、板长、静止角仍然只有 `x/y/w/rotDeg` 这一处定义。
   *
   * 'left' / 'right' 指的是**枢轴在哪一侧**，决定板往哪个方向弹：
   * 左板枢轴在左端、往内上弹；右板反之。核心代码只读这个字段，
   * 不知道哪根叫 horn_l。
   */
  flip?: 'left' | 'right';
}

export interface PegDef {
  id: string;
  /** Presentation identity assigned during stage expansion; persists across restoration. */
  enemyId?: string;
  x: number;
  y: number;
  r: number;
  kind: PegKind;
  value: number;
  /** 仅敌人钉：血量，归零即击坠 */
  hp?: number;
  /** 仅敌人钉：五行，决定相生相克倍率 */
  wuxing?: Wuxing;
}

export interface PegRowDef {
  y: number;
  step: number;
  fromX: number;
  toX: number;
  r: number;
  kind: PegKind;
  /** 隔行错位（柏青哥钉阵的基本节奏） */
  stagger: boolean;
  /** 挖洞：这些 x 附近不生成钉板，用来开通道 */
  gaps: { x: number; r: number }[];
}

/**
 * 阵型几何。全部在 `src/sim/board.ts` 里展开成具体钉位。
 *
 * 每加一种形状都必须同时守住两条硬约束，否则盘面会出现「球停得住的死角」：
 *
 *  1. **相邻钉的空隙 ≥ 0.5r**。`CELL = 2.55` 就是按这条定的：中心距 2.55r 时
 *     两钉表面还剩 0.55r 的缝，球径必须小于它才穿得过去。
 *  2. **不要在凹形底部留钉**。三角形的下尖、漏斗的收口、菱形的四个角，
 *     球落进去就正好被左右两颗钉的接触法线夹住，任何侧向冲量都只会原路弹回。
 *     所以所有 V / 收口形状都**故意留空**，让球自己滚下去。
 *
 * 违规的下场是实测出来的：十字阵曾经在盘心形成完美局部极小值，21% 的球卡死。
 */
export type PegFormationShape =
  | 'diamond'
  | 'triangle'
  | 'cross'
  | 'ring'
  | 'wall'
  | 'chevron'
  | 'funnel'
  | 'spiral'
  | 'hex'
  | 'wave'
  | 'stair'
  | 'lattice';

export interface PegFormationDef {
  id: string;
  shape: PegFormationShape;
  cx: number;
  cy: number;
  r: number;
  kind: PegKind;
  /** shape 专用参数（每个形状只读自己那几个，见 board.ts 的注释） */
  rings?: number;
  arms?: number;
  count?: number;
  /**
   * 臂钉起始角（弧度）。默认 0 表示臂钉落在坐标轴上；
   * 斜向排布时请保持顶部两颗臂钉之间足够开敞，否则会形成球停不下来的 V 形凹坑。
   */
  phase?: number;
  span?: number;
  /** chevron：单臂钉数。funnel：每侧层数。stair：台阶数。lattice：列数 */
  count2?: number;
  /** chevron / funnel：臂与竖直方向的夹角（弧度），默认 55° */
  angleDeg?: number;
  /** spiral：圈数，默认 2 */
  turns?: number;
  /** hex / lattice：行数 */
  rows?: number;
  /** wave：振幅（世界单位） */
  amp?: number;
  /** wave / waveband：波长（钉距的倍数） */
  waveLen?: number;
  /** wave：相位偏移（弧度） */
  wavePhase?: number;
  /** stair：每级台阶的钉数 */
  perStep?: number;
  label: string;
  /** 仅 kind = 'enemy'：血量。归零即击坠，尸体旋转飞离盘面 */
  hp?: number;
  /** 仅 kind = 'enemy'：属性，决定相生相克倍率 */
  wuxing?: Wuxing;
  /** 仅 kind = 'enemy'：每个给多少分 */
  score?: number;
}

export interface ZoneDef {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: ZoneKind;
  label: string;
}

export interface SlotDef {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: SlotKind;
  label: string;
  value: number;
  /**
   * 槽口铭牌第二行：**这个槽给我什么**，一句人话，直接印在盘面上。
   *
   * 玩家判断「这一颗该往哪打」只能看盘面，不能读说明书。
   * 之前这里印的是 '+70'，一个无量纲数字——玩家根本不知道那是分数、是能量还是倍率，
   * 于是凭印象往看着顺眼的槽里送球，白扔掉一次击破机会。
   * 「扣 Boss 血」这种话必须常驻在槽口上，而不是写在关卡说明里等人去读。
   */
  role: string;
}

/**
 * Boss 相位剥夺的三个维度。
 *
 * 旧版是 `none / shield / frenzy`：两个纯数值档位，而且都不给反馈。
 * 现在每个维度剥夺**一样**玩家能读出来的东西（见 constants 的 PHASE）：
 * aim 剥夺落槽确定性、ammo 剥夺弹药与救球、time 剥夺时间与球路。
 */
export type PhaseDeprivation = 'aim' | 'ammo' | 'time';

/** aim 的档位。省略的字段回落到 `PHASE.aim`。 */
export interface AimKnobs {
  /** 落槽整排漂移的幅度倍率 / 周期倍率（>1 = 更远更快） */
  driftMult?: number;
  driftSpeed?: number;
  /** 破绽判定半径倍率（相对 `boss.weakPoint.r`） */
  weakScale?: number;
}

/** ammo 的档位。省略的字段回落到 `PHASE.ammo`。 */
export interface AmmoKnobs {
  /** 本球球时倍率（0..1，越小越紧） */
  ballScale?: number;
  /** 是否关掉追打救球窗口 */
  noRescue?: boolean;
}

/** time 的档位。省略的字段回落到 `PHASE.time`。 */
export interface TimeKnobs {
  /** 横向重力振幅（bu/s²） */
  lateralG?: number;
  /** 横向重力往复频率（Hz） */
  lateralHz?: number;
  /** 镜头摇晃倍率（0 = 不晃） */
  cameraShake?: number;
}

/**
 * 解算后的档位。**只在相位确实剥夺的维度上出现**：
 * sim 已经合并过 `over` 与 `PHASE` 默认值，物理层照着执行即可，
 * 不该再去读 stage 数据算第二遍。
 */
export interface PhaseKnobs {
  aim?: AimKnobs;
  ammo?: AmmoKnobs;
  time?: TimeKnobs;
}

export interface BossPhaseDef {
  /** 血量比例阈值（降到该值以下触发） */
  at: number;
  name: string;
  desc: string;
  /**
   * 这条相位剥夺哪几个维度。**空数组 = 只改文案不改规则**（第一关）。
   *
   * 用数组而不是单值，是因为同一关的后一条相位必须是前一条的超集：
   * 玩家在同一局里不应该出现「打完更难的东西，剥夺反而少了一项」。
   */
  deprive: PhaseDeprivation[];
  /** 档位覆盖。绝大多数相位不需要写，需要时才写（换手感，不是换规则） */
  over?: PhaseKnobs;
}

/**
 * 剥夺维度的中文名。HUD 的相位条与日志共用这一份。
 *
 * 写「落槽漂移」而不是「aim」：玩家读的是盘面，不是字段名。
 */
export const DEPRIVATION_LABEL: Record<PhaseDeprivation, string> = {
  aim: '落槽漂移',
  ammo: '球时 · 关救球',
  time: '盘面横摇',
};

/** 一句话说明这个维度到底拿走了什么。相位弹出时印在相位条上。 */
export const DEPRIVATION_HINT: Record<PhaseDeprivation, string> = {
  aim: '破绽口跟着槽排跑，落进正中更难',
  ammo: '本球时间更短，追打救球窗口关闭',
  time: '整盘横向推球，球路不再由你决定',
};

export interface BossDef {
  id: string;
  name: string;
  title: string;
  maxHp: number;
  armor: number;
  weakPoint: { x: number; y: number; r: number };
  phases: BossPhaseDef[];
  colors: { body: string; trim: string; glow: string };
}

export interface StageBoardDef {
  width: number;
  height: number;
  gravity: number;
  /**
   * 盘面内容占位。**不含弹射道**。
   *
   * 弹射道是机台硬件，几何在 `expandStage` 里按 `PLUNGER` 全局常量
   * 叠在这份内容的包围盒右侧，所以它不归每关数据管——12 关盘宽从 12 到 28
   * 差一倍多，但球道必须每关一模一样，否则玩家每换一关要重新适应弹射手感。
   *
   * `width` 记的也只是主盘宽度。运行时真正生效的宽度是
   * `ExpandedStage.width`，它 = 主盘右缘 + 球道 + 外框，比这里大。
   */
  walls: WallDef[];
  deflectors: WallDef[];
  pegRows: PegRowDef[];
  pegFormations: PegFormationDef[];
  zones: ZoneDef[];
  slots: SlotDef[];
}

/**
 * 確変（fever）。真柏青哥的刺激核心不是「中一次」，而是**確変中中奖口持续敞开**：
 * 一次吃球之后进入高概率状态，接下来十几到几十秒里每颗球都有机会被吃进去，
 * 边吃边把倍率往上叠。查得到实测数字：通常时 1/26.99，確変时 1/16.28——
 * 概率大约翻倍，而「持续连打」才是玩家真正在追的东西。
 *
 * 全部数值进 JSON：换关卡换手感不该动代码。
 */
export interface FeverDef {
  /** 触发確変的落槽 id（真机台就是中央的チャッカー，即本项目的「破绽」口） */
  triggerSlot: string;
  /** 持续秒数 */
  duration: number;
  /** 期間内追加的球数（相当于 payout / 续关） */
  bonusBalls: number;
  /** 基础落槽倍率。確変中所有落槽吃这个底座倍率 */
  slotFactor: number;
  /** 每多一次连打，倍率在基础值上多叠一档 */
  chainStep: number;
  /** 连打叠到第几档封顶 */
  chainMax: number;
  /** 確変中把口开大：这是「中奖口敞开」在物理层的落法 */
  gate: { w: number; h: number; y: number };
  /** Boss 减伤在確変期间按 (1 - x) 放宽 */
  armorRelief: number;
  /** 机台配色：確変期间 LED 与役物切到这一套 */
  palette: { led: string; yakumono: string; accent: string };
  /** 役物中央的字 */
  glyph: string;
}

export interface RecoveryRules {
  x: number; y: number; width: number; height: number;
  threshold: number; perEntry: number;
  /**
   * 一次恢复把**存活且已被打残**的五行小怪补回多少比例的血。
   *
   * 旧版这里没有这个字段，因为旧版恢复池是「复活已击坠的小怪」。
   * 清场成为通关条件之后那就是个无限循环：球每路过恢复池两三次就攒满
   * 100 点，一攒满就把倒掉的敌人整批拉回来，「清空才能收工」永远做不到
   * （400 球探针里 stage_06/09/12 各撞了小怪 480~600 次，最后还是剩 9~13 枚）。
   * 现在恢复只补残血、不复活，比例封顶所以不会把进度往回拽。
   */
  healRatio: number;
}

export interface StageDef {
  id: string;
  name: string;
  subtitle: string;
  /** 关卡选择屏展示的剧情段，《水浒传》对应回目 */
  story: string;
  /** 这关的钉阵布局说明——玩家选关时要知道换的是什么盘 */
  layoutNote: string;
  board: StageBoardDef;
  boss: BossDef;
  rules: {
    recovery?: Partial<RecoveryRules>;
    balls: number;
    comboWindow: number;
    startingEnergy: number;
    /**
     * 单颗球在盘上的时间预算（秒），也就是 HUD 上那个倒计时的满格。
     * 省略时用 `PHYSICS.ballMaxAge`。
     *
     * 为什么它是每关一份数据而不是一个全局常数：盘面密度差得很远
     * （stage_02 是 14 宽塞 89 枚钉，stage_01 是 28 宽只有 50 枚），
     * 同一颗球在前者要弹的次数是后者的三倍多。
     * 用同一条线去卡，结果就是最密的那几关有 16% 的球是被倒计时判死的，
     * 而 smoke 会把它记成「关卡布局缺陷」——于是所有人去调布局，
     * 而问题只是这一关的球本来就该多给几秒。
     *
     * 有了翻板之后这条线的性质也变了：它不再是「球飞太久就强制结束」的死线，
     * 而是**玩家用来买时间的预算**（每打中一次翻板还回 `FLIPPER.timeRefund` 秒）。
     * 预算越紧，按板的价值越高——所以它必须按关卡给，不能一刀切。
     */
    ballSeconds?: number;
    /** 教学关降低技能所需触发次数；省略时沿用角色原配方。 */
    skillChargeScale?: number;
    reward: { silver: number; stones: number; shards: number };
    fever: FeverDef;
    enemy: EnemyRules;
  };
}

export interface GameDataBundle {
  characters: CharacterDef[];
  links: LinkDef[];
  stages: StageDef[];
  gacha: GachaDef;
  /** 剧情章节，走 public/data/story.json。章节顺序即关卡顺序。 */
  story: StoryChapter[];
}

export interface StoryLine {
  speaker: string;
  text: string;
}

/**
 * 一个关卡对应一段剧情。
 *
 * 为什么必须是数据而不是代码：这一版的章节表原本整份写死在 src/story/storyData.ts，
 * 违反「加关卡只加数据」这条硬约束——放进 stage_13.json、登记进 stages.json 之后，
 * 新关在剧情模式里没有任何入口，而唯一能发现这件事的还是一条和 stages.json
 * 双向深比较、同样写死在测试里的断言。
 */
export interface StoryChapter {
  stageId: string;
  title: string;
  summary: string;
  motif: string;
  cast: readonly [string, string];
  before: StoryLine[];
  after: StoryLine[];
}

export interface GachaDef {
  costStones: number;
  pity: number;
  rates: { R: number; SR: number; SSR: number; UR: number };
  firstOfKind: boolean;
  /** 分解与灵宝兑换。抄《炉石传说》：重复卡可以碎成灵宝，灵宝再换回卡。 */
  melt?: MeltDef;
}

export interface MeltDef {
  /** 碎一张卡能拿到多少灵宝，按稀有度定价 */
  shardsByRarity: Record<string, number>;
  /**
   * 灵宝兑换档位。玩家花 shards 换一张指定稀有度的卡。
   * 刻意不给「指定武将」——108 将的兑换必须继续保持随机，
   * 否则玩家会把它当成第二个抽卡而不是资源回收。
   */
  exchange: { id: string; shards: number; rarities: string[]; label: string }[];
}
