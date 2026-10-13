/**
 * 无头冒烟测试：不开浏览器，直接用 Rapier 跑完整局柏青哥。
 * 用途：
 *  1. 验证盘面数据、Schema、物理板、技能指令链路没有运行时错误；
 *  2. 用随机 bot 跑 Monte Carlo，检查关卡是否可通关、平衡数值是否合理。
 * 运行：node scripts/smoke.ts
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COMBAT, PHYSICS, PLAYER_QUALITY, SWEEP_MAX } from '../src/core/constants.ts';
import { initPhysics, Physics } from '../src/core/Physics.ts';
import { loadBundle, type ReadJson } from '../src/data/GameData.ts';
import { PHYS_KEY_LABEL, WUXING_LABEL, wuxingTier, type CharacterDef, type GameDataBundle, type PhaseDeprivation, type StageDef } from '../src/data/schema.ts';
import { BattleSim } from '../src/sim/BattleSim.ts';
import { auditLanes, auditSummary, expandStage } from '../src/sim/board.ts';
import { PhysicsBoard } from '../src/sim/PhysicsBoard.ts';
import type { SimCommand } from '../src/sim/types.ts';
import { Rng } from '../src/core/Rng.ts';

const ROOT = join(import.meta.dirname, '..', 'public');

const nodeReader: ReadJson = async (path) =>
  JSON.parse(await readFile(join(ROOT, path), 'utf8')) as unknown;

/**
 * 点到线段的距离。bot 判「球贴到板面上了没有」用。
 * 不放 `PhysicsBoard` 里是因为它只在验收脚本里用得上，
 * 而生产代码里已经有一份同名的（翻板判击球用）——两份各写各的，
 * bot 和真实物理一旦算法不同，验收结论就不再代表实机。
 */
const pointSegDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
};

interface RunResult {
  phase: 'playing' | 'victory' | 'defeat';
  bossHp: number;
  bossMaxHp: number;
  ballsUsed: number;
  ballsTotal: number;
  /** 追打次数：球还在盘上时被再次击射的次数。这个数必须 > 0，否则新玩法根本没被验证 */
  followUps: number;
  pegHits: number;
  slotsHit: Record<string, number>;
  maxCombo: number;
  pierced: number;
  detonated: number;
  destroyedPegs: number;
  /** 收尾时还剩几枚小怪没清。清场是通关条件，这个数是「为什么输了」的直接答案 */
  minionsAlive: number;
  /** 球撞在小怪身上的次数。区分「打不到」和「打到了但打不死」的唯一证据 */
  enemyHits: number;
  /** 收工时仍存活的小怪坐标。用来分辨「难碰到」和「根本碰不到」 */
  stuckSpots: { x: number; y: number }[];
  seconds: number;
  skillsUsed: Record<string, number>;
  linksUsed: Record<string, number>;
  lastDamageBySlot: Record<string, number>;
  endReason: { slot: number; out: number; timeout: number };
  finishedBalls: number;
  avgBallAge: number;
  timeoutSpots: { x: number; y: number; vx: number; vy: number; inLane: boolean; laneStalls: number; pending: boolean; fired: boolean; state: string }[];
  /* ---- 关卡标定探针（见 docs/superpowers/reviews/2026-10-10-level-core-plan.md 5.1） ---- */
  /** 有效取样的合格弱口次数（通关后的空结算不计） */
  weakSlots: number;
  /** 这些弱口实际打掉的 Boss 血（受最后一击截断，仅供参考，不参与标定） */
  weakApplied: number;
  /**
   * 合格弱口的**归一倍数**之和：`(slotValue × slotMult × bossVuln) / (slotValue × bossVuln)`，
   * 也就是这一次弱口实际打出几倍槽底值。
   * 易伤按当时的 `bossVuln` 一起剥掉，所以它与本关技能配置无关。
   *
   * `GOOD_WEAK = weakBase × Σ归一倍数 / 总样本数`。
   * 这个单位与本关小怪数、本关护甲、Boss 剩余血量都无关，
   * 是真正跨关可比的那个量 —— 换关卡数据时它不跟着漂。
   */
  weakNormSum: number;
}

function runOnce(
  bundle: GameDataBundle,
  stageDef: StageDef,
  seed: number,
  teamIds: string[],
  runIndex = -1,
): RunResult {
  const rng = new Rng(seed);
  const stage = expandStage(stageDef);
  /** 逐球追踪开关：`SMOKE_TRACE=stage_02`（可带 `=stage_02:11` 指定第 11 局） */
  const traceSpec = process.env.SMOKE_TRACE?.split(':');
  const trace = !!traceSpec && traceSpec[0] === stageDef.id && (!traceSpec[1] || traceSpec[1] === String(runIndex));
  const team = teamIds.map((id) => bundle.characters.find((c) => c.id === id));
  // 队伍 id 写错要在第一行就炸：否则 undefined 会一路传到 BattleSim 里，
  // 报出来的是「读 undefined 的 id」，跟真正的原因隔了三层
  const absent = team.map((c, i) => (c ? '' : teamIds[i]!)).filter(Boolean);
  if (absent.length) throw new Error(`阵容里有 roster.json 不存在的角色：${absent.join(', ')}`);
  const squad = team as CharacterDef[];
  /** 破绽口的槽底值（目前 210）。归一时拿它当分母，不另抄一份数字。 */
  const weakBase = stage.slots.find((s) => s.id === 'slot_weak')?.value ?? 210;

  const physics = new Physics(stage.gravity);
  const sim = new BattleSim(stage, squad, bundle.links);

  const stats: RunResult = {
    phase: 'playing',
    bossHp: stage.boss.maxHp,
    bossMaxHp: stage.boss.maxHp,
    ballsUsed: 0,
    ballsTotal: stage.rules.balls,
    followUps: 0,
    pegHits: 0,
    slotsHit: {},
    maxCombo: 0,
    pierced: 0,
    detonated: 0,
    destroyedPegs: 0,
    minionsAlive: 0,
    enemyHits: 0,
    stuckSpots: [],
    seconds: 0,
    skillsUsed: {},
    linksUsed: {},
    lastDamageBySlot: {},
    endReason: { slot: 0, out: 0, timeout: 0 },
    finishedBalls: 0,
    avgBallAge: 0,
    timeoutSpots: [],
    weakSlots: 0,
    weakApplied: 0,
    weakNormSum: 0,
  };

  /** 临时探针：收集本轮 exec 出的 bossDamage 飘字原值，供 DEBUG_WEAK 对账 */
  let fxDump: number[] = [];
  const exec = (cmds: SimCommand[]): void => {
    for (const c of cmds) {
      board.apply(c);
      if (c.t === 'fx' && c.text) {
        if (c.fx === 'skillCast' && c.text) {
          const who = squad.find((t) => t.skill.name === c.text);
          if (who) stats.skillsUsed[who.id] = (stats.skillsUsed[who.id] ?? 0) + 1;
        }
        if (c.fx.startsWith('link') && c.fx !== 'linkEnd') {
          const link = bundle.links.find((l) => l.name === c.text);
          if (link) stats.linksUsed[link.id] = (stats.linksUsed[link.id] ?? 0) + 1;
        }
        if (c.fx === 'slot' || c.fx === 'bossDamage') {
          const key = c.fx === 'bossDamage' ? 'boss' : 'other';
          stats.lastDamageBySlot[key] = c.value ?? 0;
          if (c.fx === 'bossDamage') fxDump.push(c.value ?? -1);
        }
      }
    }
  };

  const board = new PhysicsBoard(physics, stage, {
    canLaunch: () => sim.snapshot().phase === 'playing' && sim.snapshot().ballsLeft > 0,
    onEvent: (ev) => {
      // launch 现在每次**击射**都发一次，不是一局一次。
      // 所以 ballsUsed 的真实含义是「打了几发」——统计和文案都要跟着改口径，
      // 否则 12 关的「用球 8.4」会让人以为每局只有 8 次击射。
      if (ev.t === 'launch') {
        stats.ballsUsed++;
        if (ev.followUp) stats.followUps++;
      }
      if (ev.t === 'pegHit') stats.pegHits++;
      if (ev.t === 'pegHit' && ev.pegKind === 'enemy') stats.enemyHits++;
      if (ev.t === 'slotEnter') {
        const def = stage.slots.find((s) => s.id === ev.slotId);
        const key = def?.label ?? ev.kind;
        stats.slotsHit[key] = (stats.slotsHit[key] ?? 0) + 1;
      }
      /*
       * 标定探针只在「落进破绽口」这一个事件上取样。
       *
       * 取样点必须在 `exec` **之前**读倍率、在**之后**读血量差：
       * 破绽口的结算顺序是 `applyBossDamage(dmg)` 先跑、飘字 fx 后压
       *（BattleSim.ts 的 slot 结算段），所以 exec 一返回 bossHp 已经扣过了。
       * 血量差而不是 fx 上的 `value`——后者是进 applyBossDamage **之前**的原始值，
       * 不带护甲、不带易伤、不带清空倍率，拿它标定会把三道乘区全漏掉。
       */
      const isWeakSlot = ev.t === 'slotEnter' && ev.slotId === 'slot_weak';
      const snapBefore = isWeakSlot ? sim.snapshot() : null;
      fxDump = [];
      exec(sim.handle(ev));
      if (isWeakSlot && snapBefore) {
        /*
         * 用 fx 上的 `value` 而不是血量差。
         *
         * 血量差有两个不能要的失真：
         *  1. 最后一击会被 `Math.max(0, bossHp - applied)` 截断成「剩余血量」，
         *     打得越准的那一击反而被记成最小值（实测 stage_01 整局只 1.3 次弱口，
         *     那一击恰好是终结击，样本直接被抹掉）；
         *  2. 通关后 boss 已归零，后续落槽 delta 恒为 0。
         * fx 的 value 是 `applyBossDamage` **之前**的（BattleSim slot 结算段先扣血
         * 再压 fx），两个失真都不存在。
         *
         * 它含三个乘区：`slotValue × slotMult × bossVuln`。
         * 除掉后两者，剩下的就是「这一次弱口本身打出几倍」—— 与本关小怪数、
         * 本关护甲、Boss 还剩多少血全都无关，是真正跨关可比的量。
         */
        if (snapBefore.phase === 'playing') {
          const vuln = snapBefore.buffs.find((b) => b.key === 'bossVuln')?.mult ?? 1;
          const raw = fxDump.reduce((a, v) => a + v, 0);
          const denorm = Math.max(1, vuln * weakBase);
          if (raw > 0) {
            stats.weakSlots++;
            stats.weakApplied += Math.max(0, snapBefore.bossHp - sim.snapshot().bossHp);
            stats.weakNormSum += raw / denorm;
          }
        }
        if (process.env.DEBUG_WEAK) {
          console.log(
            `[弱口] phase=${snapBefore.phase} fx=${JSON.stringify(fxDump)} base=${weakBase} ` +
            `归一倍数=${(fxDump.reduce((a, v) => a + v, 0) / weakBase).toFixed(2)}`,
          );
        }
      }
    },
  });

  const dt = PHYSICS.fixedDt;
  let t = 0;
  let guard = 0;

  // 简单 bot：球在中盘时释放已就绪技能，掉到底部就按翻板。
  // 满槽的技能要**随机挑一个**释放：按槽位顺序取第一个的话，
  // 排在后面的角色永远轮不到（宋江的 slotEnter 充能被柴进的 zoneSkill 整局吃掉，
  // 测出来 6% 胜率，看着像平衡问题，其实是 bot 偏心）。
  let flipperHold = 0;
  let flipperSide: 'left' | 'right' = 'left';
  const botTick = (): void => {    if (sim.snapshot().phase !== 'playing') return;
    if (board.state !== 'live') return;
    const snap = sim.snapshot();
    if (board.ballY <= 21) {
      const ready = snap.gauges.filter((g) => g.value >= g.max);
      if (ready.length && rng.next() < 0.05) {
        const pick = ready[Math.floor(rng.next() * ready.length)]!;
        exec(sim.releaseSkill(pick.charId, board.ballX, board.ballY));
        return;
      }
    }
    /*
     * 翻板。bot 必须**按玩家的时机**按，不能一看见球在低处就乱按。
     *
     * 早先写成「球 y < 8 就按」，而翻板在 y≈3.4~5.3——等于球还在半空时
     * bot 就把板按完了，等球落到板面上时板早已回落，一记都打不中；
     * ���时 bot 还在不停地按，连点保护把板压在弹起位附近来回抖。
     * 判据改成「球已经贴到板面附近」，和真人在屏幕上看到的读法一致。
     */
    if (flipperHold > 0) {
      flipperHold -= 1;
      if (flipperHold === 0) {
        board.pressFlipper(flipperSide, false);
        flipperSide = 'left';
      }
    } else if (board.state === 'live' && board.ballVY < 0) {
      for (const f of board.flippers) {
        const g = f.geom;
        const tipX = g.px + Math.cos(g.restRad) * g.len;
        const tipY = g.py + Math.sin(g.restRad) * g.len;
        if (pointSegDist(board.ballX, board.ballY, g.px, g.py, tipX, tipY) < 1.1) {
          flipperSide = g.side;
          board.pressFlipper(g.side, true);
          flipperHold = Math.round(0.1 / PHYSICS.fixedDt);
          break;
        }
      }
    }
  };

  /**
   * 追打。这是**模拟真实玩法**的关键一步。
   *
   * 之前 bot 只在开局打一发，之后球飞多久都不管——那测的其实是旧玩法
   * （一次发射然后干等），改成「球可再射」之后不改 bot，新机制在 smoke 里
   * 等于完全没被验证过。
   *
   * 追打策略刻意写得很朴素：球慢下来（board.isReady）就打，
   * 方向瞄「球的上方偏左或偏右」——模拟玩家想继续把球留在盘上。
   * 故意不做任何花活，因为 smoke 的职责是验证**机制通不通**，
   * 不是验证最优打法。
   */
  const followUp = (): void => {
    if (!board.isReady || !board.canShoot) return;
    if (sim.snapshot().ballsLeft <= 0) return;
    // 往球的上方打，带一点横向随机，避免所有补射都同一条弹道
    const side = rng.next() < 0.5 ? -1 : 1;
    const dx = side * (2.5 + rng.next() * 5);
    const dy = 8 + rng.next() * 8;
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const angle = Math.max(42, Math.min(138, deg));
    const power = 17 + rng.next() * (30 - 17) * 0.8;
    board.shoot(power, angle);
  };

  const shoot = (): void => {
    board.armLauncher();
    // 首发不瞄准：只有力度，模拟玩家拉多大力
    const power = stage.plunger.minPower + rng.next() * (stage.plunger.maxPower - stage.plunger.minPower);
    board.plunge(power);
  };

  shoot();
  let ballsDone = 0;
  while (sim.snapshot().phase === 'playing' && guard < 1_200_000) {
    guard++;
    t += dt;
    botTick();
    followUp();
    exec(sim.update(dt));
    board.step(dt);
    if (board.state === 'done') {
      const snap = sim.snapshot();
      /*
       * 逐球追踪。用法：`SMOKE_TRACE=stage_02 npm run smoke`。
       *
       * 「关卡失败」只告诉你这一局输了，输在哪一步只能一球一球看：
       * Boss 血停在哪条线不动、球死在哪个坐标、是被槽吃掉的还是超时掉的，
       * 三者对应的修法完全不同（改血 / 改布局 / 改球时）。
       */
      ballsDone++;
      if (trace) {
        const hpPct = (snap.bossHp / snap.bossMaxHp * 100).toFixed(1);
        const r = board.endReason;
        const why = r.timeout ? `超时 ${r.timeout}` : r.out ? `掉出 ${r.out}` : '落槽';
        console.log(
          `  [${stageDef.id} seed=${seed}] 第${ballsDone}球 boss=${hpPct}% 收于(${board.ballX.toFixed(1)},${board.ballY.toFixed(1)}) ${why}`
          + ` 槽=${snap.lastSlotLabel ?? '-'} 伤=${snap.lastDamage} 弱点=${stage.boss.weakPoint.x.toFixed(1)} 相位=${snap.bossPhaseName}`
          + ` 击射=${stats.followUps} t=${t.toFixed(1)}s`,
        );
      }
      if (snap.phase === 'playing' && snap.ballsLeft > 0) shoot();
      else break;
    }
  }

  const snap = sim.snapshot();
  board.dispose();
  physics.dispose();

  return {
    ...stats,
    phase: snap.phase,
    bossHp: snap.bossHp,
    minionsAlive: snap.enemy.alive,
    enemyHits: stats.enemyHits,
    stuckSpots: sim.aliveMinionSpots(),
    maxCombo: snap.maxCombo,
    pierced: snap.pierced,
    detonated: snap.detonated,
    destroyedPegs: snap.destroyedPegs,
    seconds: t,
    endReason: { ...board.endReason },
    finishedBalls: board.finishedBalls,
    avgBallAge: board.finishedBalls > 0 ? board.totalBallAge / board.finishedBalls : 0,
    timeoutSpots: [...board.timeoutSpots],
  };
}

function summarize(label: string, results: RunResult[]): void {
  const n = results.length;
  const wins = results.filter((r) => r.phase === 'victory').length;
  const avg = (f: (r: RunResult) => number): number => results.reduce((a, r) => a + f(r), 0) / n;
  const slotTotals = new Map<string, number>();
  for (const r of results) {
    for (const [k, v] of Object.entries(r.slotsHit)) slotTotals.set(k, (slotTotals.get(k) ?? 0) + v);
  }
  const skillTotals = new Map<string, number>();
  for (const r of results) {
    for (const [k, v] of Object.entries(r.skillsUsed)) skillTotals.set(k, (skillTotals.get(k) ?? 0) + v);
  }
  const linkTotals = new Map<string, number>();
  for (const r of results) {
    for (const [k, v] of Object.entries(r.linksUsed)) linkTotals.set(k, (linkTotals.get(k) ?? 0) + v);
  }

  console.log(`\n=== ${label} ===`);
  console.log(`局数 ${n}  胜率 ${((wins / n) * 100).toFixed(1)}%  剩余血量均值 ${avg((r) => r.bossHp).toFixed(0)}/${results[0]!.bossMaxHp}`);
  console.log(`击射 ${avg((r) => r.ballsUsed).toFixed(1)}/${results[0]!.ballsTotal}  钉击 ${avg((r) => r.pegHits).toFixed(0)}  最高连击 ${avg((r) => r.maxCombo).toFixed(0)}  单局时长 ${avg((r) => r.seconds).toFixed(1)}s`);
  const tot = (k: 'slot' | 'out' | 'timeout'): number =>
    results.reduce((a, r) => a + r.endReason[k], 0);
  const finishedBalls = results.reduce((n, r) => n + r.finishedBalls, 0);
  const averageBallAge = finishedBalls > 0
    ? results.reduce((n, r) => n + r.avgBallAge * r.finishedBalls, 0) / finishedBalls : 0;
  console.log(`  单球均时 ${averageBallAge.toFixed(2)}s  落槽结束 ${tot('slot')}  掉出 ${tot('out')}  超时 ${tot('timeout')}`);
  if (tot('timeout') > 0) {
    const hist = new Map<string, number>();
    for (const r of results)
      for (const s of r.timeoutSpots) {
        const key = `(${s.x},${s.y})`;
        hist.set(key, (hist.get(key) ?? 0) + 1);
      }
    const top = [...hist].sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log(`  超时卡点 Top ${top.map(([k, c]) => `${k}:${c}`).join('  ')}`);
  }
  console.log(`贯穿 ${avg((r) => r.pierced).toFixed(1)}  连锁引爆 ${avg((r) => r.detonated).toFixed(1)}  摧毁钉板 ${avg((r) => r.destroyedPegs).toFixed(1)}`);
  const slotCount = [...slotTotals.values()].reduce((a, b) => a + b, 0) || 1;
  console.log(`落槽分布 ${[...slotTotals].map(([k, v]) => `${k}:${((v / slotCount) * 100).toFixed(0)}%`).join('  ')}`);
  console.log(`技能释放 ${[...skillTotals].map(([k, v]) => `${k}:${(v / n).toFixed(1)}`).join('  ') || '无'}`);
  console.log(`连携触发 ${[...linkTotals].map(([k, v]) => `${k}:${(v / n).toFixed(2)}`).join('  ') || '无'}`);
}

/**
 * 硬校验规划 §5 验收 4：连携技必须真的改写盘面 / 弹珠 / 战斗状态，
 * 而不是只播动画。这里直接检查三卡 Ultimate 产出的指令。
 */
function verifyLinks(bundle: GameDataBundle): void {
  const stageDef = bundle.stages[0]!;
  const stage = expandStage(stageDef);
  // 必须是三人队：三卡 Ultimate 的条件就写死在这三人身上，
  // 换成全 12 人会让 gauge 数与连携条件同时膨胀，测的就不是这条连携了。
  const trio = ['wusong', 'linchong', 'luzhishen'];
  const team = trio.map((id) => bundle.characters.find((c) => c.id === id)!);
  const sim = new BattleSim(stage, team, bundle.links);

  const triple = bundle.links.find((l) => l.tier === 'triple')!;
  const dual = bundle.links.find((l) => l.tier === 'dual')!;

  // 锁定双卡，证明 Ultimate 不会被动被抢触发
  for (const l of bundle.links.filter((x) => x.tier === 'dual')) sim.toggleLinkLock(l.id);

  // 攒满三个槽 + 能量（起始 20，三次聚气区域足够支付 60 点 Ultimate 代价）
  for (const g of sim.gauges) g.value = g.max;
  const cmds: SimCommand[] = [];
  for (let i = 0; i < 3; i++) {
    cmds.push(...sim.handle({ t: 'zoneEnter', zoneId: 'z_energy', kind: 'energy', x: 0, y: 6 }));
  }
  cmds.push(...sim.handle({ t: 'launch', power: 20, angleDeg: 90, x: 0, y: 29 }));
  cmds.push(...sim.handle({ t: 'pegHit', pegId: 'x', pegKind: 'normal', intensity: 0.5, x: 0, y: 20 }));

  const fired = cmds.filter((c) => c.t === 'fx' && c.text === triple.name);
  const ghost = cmds.find((c) => c.t === 'setGhostKinds' && c.channel === `link_${triple.id}`) as
    | { kinds: string[]; duration: number }
    | undefined;
  const speed = cmds.find((c) => c.t === 'setSpeedScale' && c.channel === `link_${triple.id}`) as
    | { scale: number }
    | undefined;

  const linkState = sim.snapshot().links.find((l) => l.linkId === triple.id)!;
  const ok = fired.length > 0 && !!ghost && ghost.duration > 0 && !!speed && speed.scale > 1 && linkState.active;

  // 所有连携条件必须是 Runtime 真认的 c 值与 PhysKey。
  // 之前 links.json 里留着已被删掉的 berserkActive / pierceActive：JSON 不参与类型检查，
  // 加载时不报错，testCondition 的 switch 也没有 default —— 条件静默判 false，连携永不触发。
  const VALID_C = new Set(['gaugeFull', 'modActive', 'comboAtLeast', 'slotsHitAtLeast']);
  const VALID_KEY = new Set(Object.keys(PHYS_KEY_LABEL));
  const badCond: string[] = [];
  for (const l of bundle.links) {
    for (const c of l.require.conditions) {
      if (!VALID_C.has(c.c)) badCond.push(`${l.id}:未知条件 ${c.c}`);
      if (c.c === 'modActive' && !VALID_KEY.has(c.key)) badCond.push(`${l.id}:未知旋钮 ${c.key}`);
    }
    for (const m of l.members) {
      if (!bundle.characters.some((c) => c.id === m)) badCond.push(`${l.id}:成员 ${m} 不在角色表`);
    }
  }
  const covered = new Set(bundle.links.flatMap((l) => l.members));
  const uncovered = bundle.characters.filter((c) => !covered.has(c.id)).map((c) => c.id);

  console.log('\n=== 连携硬校验 ===');
  console.log(`  ${triple.name}：触发=${fired.length > 0} 钉阵失效=${ghost?.duration ?? 0}s 球速×${speed?.scale ?? 1} 战斗状态生效=${linkState.active} 落槽×${triple.effect.slotFactor} Boss破防×${triple.effect.bossVulnFactor}`);
  console.log(`  双卡 ${dual.name} 在锁定状态下未被动触发=${!sim.snapshot().links.find((l) => l.linkId === dual.id)!.active}`);
  console.log(`  连携 ${bundle.links.length} 组，条件全部合法=${badCond.length === 0}${badCond.length ? ' → ' + badCond.join('；') : ''}`);
  console.log(`  角色覆盖 ${covered.size}/${bundle.characters.length}${uncovered.length ? '，未覆盖：' + uncovered.join(',') : '（12 人全部有连携）'}`);
  console.log(`  结果：${ok && badCond.length === 0 ? 'PASS' : 'FAIL'}`);
  if (!ok || badCond.length > 0) process.exitCode = 1;
}

/**
 * 硬校验：12 份技能配方必须真的落到物理通道上，而不是只在 JSON 里好看。
 *
 * 为什么必须逐个验：技能已经改成数据配方，Runtime 里没有「武松」也没有「李逵」，
 * 只有一个旋钮解释器。风险随之从「分支写错」变成「**数据写错没人发现**」——
 * 某个 PhysKey 拼错、某个 duration 是 0、某个 pierce 没配上对应的物理通道，
 * 全都不会报错，只是那个角色变成一张白卡。所以这里对着快照逐个点名。
 */
function verifyRecipes(bundle: GameDataBundle): void {
  const source = expandStage(bundle.stages[0]!);
  const enemy = source.pegs.find((p) => p.kind === 'enemy')!;
  const stage = { ...source, boss: { ...source.boss, maxHp: 100000 },
    rules: { ...source.rules, skillChargeScale: 1 },
    pegs: [...source.pegs.filter((p) => p.kind !== 'enemy'),
      ...(['fire', 'water', 'wood', 'metal', 'earth'] as const).flatMap((wuxing, j) =>
        Array.from({ length: 8 }, (_, i) => ({ ...enemy, id: `recipe_${j}_${i}`, wuxing,
          x: 0.5 + i * 0.12, y: 14 + j * 0.15, hp: 1 })))],
  };
  const CHANNEL_CMD: Record<string, string> = {
    gravity: 'setGravityScale',
    speed: 'setSpeedScale',
    bounce: 'setBounceScale',
    damping: 'setDampingScale',
    speedFloor: 'setSpeedFloor',
  };

  console.log(`\n=== ${bundle.characters.length} 份技能配方硬校验 ===`);
  let bad = 0;
  for (const c of bundle.characters) {
    const sim = new BattleSim(stage, [c], bundle.links);
    const before = sim.snapshot();
    const g = sim.gauges.find((v) => v.charId === c.id)!;
    g.value = g.max;
    const cmds = sim.releaseSkill(c.id, 0, 14);
    const after = sim.snapshot();

    const errs: string[] = [];
    if (cmds.some((x) => x.t === 'sound' && x.name === 'deny')) errs.push('未能释放');

    // 1) 每个非加法旋钮都要出现在 buffs 里
    for (const m of c.skill.mods) {
      if (m.key === 'energy' || m.key === 'critChance') continue;
      if (!after.buffs.some((b) => b.key === `${c.id}:${m.key}`)) errs.push(`旋钮 ${m.key} 未生效`);
      else if (m.duration > 0 && !after.buffs.some((b) => b.key === `${c.id}:${m.key}` && b.left > 0)) {
        errs.push(`旋钮 ${m.key} 时长 ${m.duration}s 却无剩余时间`);
      }
    }
    // 2) 改物理量的旋钮必须真的下发物理通道
    for (const [key, cmd] of Object.entries(CHANNEL_CMD)) {
      if (!c.skill.mods.some((m) => m.key === key)) continue;
      const hit = cmds.some((x) => x.t === cmd && 'channel' in x && x.channel === `${c.id}:${key}`);
      if (!hit) errs.push(`${key} 未下发 ${cmd}`);
    }
    // 3) 特殊部件
    if (c.skill.pierce && !cmds.some((x) => x.t === 'setGhostKinds')) errs.push('pierce 未开穿透');
    if (c.skill.pierce && after.pierced === 0 && !cmds.some((x) => x.t === 'setGhostKinds')) errs.push('pierce 无效');
    if (c.skill.destroy) {
      if (!cmds.some((x) => x.t === 'destroyPegs' || x.t === 'fx' || x.t === 'shake')) errs.push('destroy 无产出');
      if (c.skill.destroy.damage > 0 && after.bossHp === before.bossHp) errs.push('destroy 未结算 Boss 伤害');
    }
    if (c.skill.strike) {
      const strike = cmds.find((x) => x.t === 'strike');
      if (!strike || !strike.preview.targets.length || !cmds.some((x) => x.t === 'enemyHp')) errs.push('strike 未伤害范围内敌人');
      if (after.weapon.casts !== 1 || after.weapon.hits !== strike?.preview.targets.length) errs.push('strike 统计与命中不一致');
    }
    if (c.skill.chain) {
      // 连锁引爆是「碰一颗、带一片」，所以必须打在敌人钉堆里才有产出：
      // 打在普通钉上会正确地什么都不发生，拿它当断言只会误报。
      const foe = stage.pegs.find((p) => p.kind === 'enemy' && p.hp)!;
      const d0 = sim.snapshot().detonated;
      sim.handle({ t: 'pegHit', pegId: foe.id, pegKind: 'enemy', intensity: 0.9, x: foe.x, y: foe.y });
      if (sim.snapshot().detonated === d0) errs.push('chain 打在敌人钉上没引爆任何邻居');
      if (!c.skill.chain.wuxing) errs.push('chain 未指定五行');
      else if (!WUXING_LABEL[c.skill.chain.wuxing]) errs.push(`chain 五行非法：${c.skill.chain.wuxing}`);
    }
    if (c.skill.force && !cmds.some((x) => x.t === 'setForce' && x.channel === `force_${c.id}`)) errs.push('force 未下发 setForce');
    if (c.skill.impulse && !cmds.some((x) => x.t === 'boostBall')) errs.push('impulse 未下发 boostBall');
    if (c.skill.bonusBalls && after.ballsLeft !== before.ballsLeft + c.skill.bonusBalls) {
      errs.push(`追加弹珠 ${after.ballsLeft - before.ballsLeft} ≠ ${c.skill.bonusBalls}`);
    }
    if (c.skill.bossVuln && c.skill.bossVuln.duration <= 0) errs.push('bossVuln 时长为 0');
    if (!c.skill.mods.length) errs.push('配方没有任何旋钮');
    if (c.skill.mods.some((m) => m.duration === 0 && m.key !== 'energy')) errs.push('存在 duration=0 的旋钮（等于整局常驻，确认是否有意）');

    // 4) 触发事件必须真的能把槽充满。
    //    这条是被真实 bug 逼出来的：schema 的 SkillTriggerEvent 里有 slotEnter / enemyKill，
    //    但 Runtime 只在 onPegHit 里判了四种，于是「配了不触发」，不报错也不放技能。
    //    现在把每种触发都喂一遍：喂不满就说明这条通路没接上。
    const t = c.skill.trigger;
    if (t.on !== 'none' && t.charges > 0) {
      const probe = new BattleSim(stage, [c], bundle.links);
      const g2 = probe.gauges.find((v) => v.charId === c.id)!;
      const slot0 = stage.slots.find((s) => s.kind === 'normal') ?? stage.slots[0]!;
      const zone0 = stage.zones.find((z) => z.kind === 'skill') ?? stage.zones[0]!;
      const foes = stage.pegs.filter((p) => p.kind === 'enemy' && p.hp);
      for (let i = 0; i < 40 && g2.value < g2.max; i++) {
        if (t.on === 'zoneSkill') {
          probe.handle({ t: 'zoneEnter', zoneId: zone0.id, kind: 'skill', x: zone0.x, y: zone0.y });
        } else if (t.on === 'slotEnter') {
          probe.handle({ t: 'slotEnter', slotId: slot0.id, kind: slot0.kind, value: slot0.value, weak: false, x: slot0.x, y: slot0.y });
        } else if (t.on === 'enemyKill' && foes[i]) {
          const foe = foes[i]!;
          probe.handle({ t: 'pegHit', pegId: foe.id, pegKind: 'enemy', intensity: 1.2, x: foe.x, y: foe.y });
        } else {
          const pk = t.on === 'spearHit' ? 'spear' : 'normal';
          const peg = stage.pegs.find((p) => p.kind === pk);
          if (!peg) break;
          probe.handle({ t: 'pegHit', pegId: peg.id, pegKind: pk, intensity: 0.9, x: peg.x, y: peg.y });
        }
      }
      if (g2.value < g2.max) errs.push(`触发 ${t.on} 喂 40 次仍充不满（${g2.value}/${g2.max}）——该触发在 Runtime 里没接通`);
    }

    if (errs.length) bad++;
    const tag = errs.length ? `FAIL  ${errs.join('；')}` : 'PASS';
    console.log(
      `  ${(c.name + '(' + WUXING_LABEL[c.wuxing] + ')').padEnd(10)} ${(c.rarity).padEnd(3)} ${c.skill.name.padEnd(6)} 旋钮${String(c.skill.mods.length).padStart(2)}  buff${String(after.buffs.length).padStart(2)}  ${tag}`,
    );
  }
  console.log(`  结果：${bad === 0 ? 'PASS' : `FAIL（${bad} 份配方有问题）`}`);
  if (bad > 0) process.exitCode = 1;
}

/**
 * 硬校验：確変状态机与敌人钉必须真的改写战斗，而不是只播动画。
 * 分两块验：
 *   1) 確変——触发槽开闸 + 追加球只发一次 + 連打叠倍率 + 破甲折扣；
 *   2) 敌人——扣血 / 相性 / 会心 / 击坠给球速，且反弹次数要接进落槽倍率。
 */
function verifyFeverAndEnemy(bundle: GameDataBundle): void {
  const stage = expandStage(bundle.stages[0]!);
  const f = stage.rules.fever;
  const e = stage.rules.enemy;
  const trigger = stage.slots.find((s) => s.id === f.triggerSlot)!;
  const otherSlot = stage.slots.find((s) => s.id !== f.triggerSlot && s.value > 0)!;

  console.log('\n=== 確変硬校验 ===');
  {
    const armored = { ...stage, boss: { ...stage.boss, maxHp: 100000, armor: 0.3 } };
    const sim = new BattleSim(armored, bundle.characters, bundle.links);
    const before = sim.snapshot();
    const cmds = sim.handle({ t: 'slotEnter', slotId: trigger.id, kind: trigger.kind, value: trigger.value, weak: true, x: trigger.x, y: trigger.y });
    const after = sim.snapshot();

    const gateOn = cmds.some((c) => c.t === 'feverGate' && c.on === true);
    const started = cmds.some((c) => c.t === 'fx' && c.fx === 'feverStart');
    const ballsAdded = after.ballsLeft - before.ballsLeft;
    const multNoChain = f.slotFactor;
    const chainMult = f.slotFactor * (1 + 1 * f.chainStep);

    // 追加球在同一个確変窗口里只能发一次：再打一次触发槽，球数不该再涨
    sim.handle({ t: 'slotEnter', slotId: trigger.id, kind: trigger.kind, value: trigger.value, weak: true, x: trigger.x, y: trigger.y });
    const after2 = sim.snapshot();
    const noDoubleGrant = after2.ballsLeft === after.ballsLeft;

    // 非触发槽才累加連打
    const cmds3 = sim.handle({ t: 'slotEnter', slotId: otherSlot.id, kind: otherSlot.kind, value: otherSlot.value, weak: false, x: otherSlot.x, y: otherSlot.y });
    const after3 = sim.snapshot();
    const chainUp = after3.fever.chain === 1 && cmds3.some((c) => c.t === 'fx' && c.fx === 'renda');
    const chainCapped = after3.fever.mult > multNoChain && after3.fever.mult <= chainMult + 1e-9;

    const armor = before.bossArmor;
    const feverArmor = after.bossArmor;
    const ok =
      gateOn && started && after.fever.active && ballsAdded === f.bonusBalls &&
      noDoubleGrant && chainUp && chainCapped && feverArmor < armor && Math.abs(feverArmor - armor * (1 - f.armorRelief)) < 1e-6;

    console.log(`  触发槽 ${trigger.label} → 开闸=${gateOn} 大演出=${started} 確変=${after.fever.active} 追加球=+${ballsAdded}(应为 ${f.bonusBalls})`);
    console.log(`  同一窗口二次触发不再补球=${noDoubleGrant}  連打=${after3.fever.chain} 倍率=${after3.fever.mult.toFixed(2)}(基准 ${multNoChain}，1 连打上限 ${chainMult.toFixed(2)}) 連打提示=${chainUp}`);
    console.log(`  確変期 Boss 减伤 ${(armor * 100).toFixed(0)}%→${(feverArmor * 100).toFixed(0)}%=${feverArmor < armor} 確変时长=${f.duration}s`);
    console.log(`  结果：${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) process.exitCode = 1;
  }

  console.log('\n=== 敌人钉硬校验 ===');
  {
    const enemies = stage.pegs.filter((p) => p.kind === 'enemy' && p.hp);
    const target = enemies.find((p) => p.wuxing === 'water') ?? enemies[0]!;
    const hp = target.hp!;

    // 关卡的 5 枚敌人钉必须正好覆盖金木水火土：
    // 少一行就有一支队伍完全没得选，多一行就有一行永远没被克制过。
    const wuxingSet = new Set(enemies.map((p) => p.wuxing));
    const allFive = wuxingSet.size === 5 && (['metal', 'wood', 'water', 'fire', 'earth'] as const).every((w) => wuxingSet.has(w));
    if (!allFive) {
      console.log(`  敌人钉五行覆盖不全：${[...wuxingSet].join(',')}`);
      process.exitCode = 1;
    }

    const sim = new BattleSim(stage, [bundle.characters.find((c) => c.id === 'wusong')!], bundle.links);
    // 首击爆数字 + 敌人钉状态机照常推进
    const cmds = sim.handle({ t: 'pegHit', pegId: target.id, pegKind: 'enemy', intensity: 0.6, x: target.x, y: target.y });
    const hitFx = cmds.filter((c) => c.t === 'fx' && c.fx === 'enemyHit');
    const snap = sim.snapshot();
    const alive = snap.enemy.alive;
    const hpLeft = hp > 0;

    // 血弧指令：敌人钉受击必须报一次剩余血量比例，否则盘面上的环永远停在满血
    const arc = cmds.filter((c) => c.t === 'enemyHp');
    const arcOn = arc.length > 0 && arc[0]!.pegId === target.id && arc[0]!.ratio > 0 && arc[0]!.ratio < 1;

    // 打空血：需要多次碰撞，这里直接把血打到只剩一击
    const bossHpBefore = sim.snapshot().bossHp;
    let killCmds: SimCommand[] = [];
    let killed = 0;
    let boost = false;
    for (let i = 0; i < 60 && killed === 0; i++) {
      killCmds = sim.handle({ t: 'pegHit', pegId: target.id, pegKind: 'enemy', intensity: 1.2, x: target.x, y: target.y });
      if (killCmds.some((c) => c.t === 'fx' && c.fx === 'enemyKill')) {
        killed = 1;
        boost = killCmds.some((c) => c.t === 'boostBall');
      }
    }
    const snap2 = sim.snapshot();
    /*
     * 击坠**不该**直接啃 Boss 血——那是旧版 `killDamage` 的行为，已删。
     * 现在击坠只推进清空进度，倍率由 `sweepMult` 统一乘进 `applyBossDamage`。
     * 所以这里反过来断言：清掉一枚之后 Boss 血**没变**，而倍率**涨了一档**。
     * 这条守的正是「小怪是小怪，不该兼职伤害来源」这个定位。
     */
    const bossLost = bossHpBefore - snap2.bossHp;
    const sweepAfter = snap2.enemy.sweepMult;
    const sweepFloor = 1 + e.perSweep;
    const killLeavesBossAlone = killed === 1 && bossLost === 0;
    const sweepRamped = sweepAfter >= sweepFloor - 1e-9;
    /*
     * 击坠飘字改成「清空进度 + 当前倍率」。
     *
     * 旧版这里断言的是「击坠会给 Boss 掉一个和实际掉血相等的数字」——那是
     * `killDamage` 的遗产。现在 Boss 血不该因击坠而动，于是这个断言既没有对象
     * 也没有意义：真按它写，`value === 0` 会让「击坠完全不给 Boss 造成任何伤害」
     * 这件事反而永远测不出来（`some()` 找不到任何 bossDamage，返回 false，
     * 整节硬校验红着，而报出来的每一条明细却都是 true——比红本身更难查）。
     *
     * 新的落点：击坠这一刻盘面必须**说得出**「清了几枚、Boss 伤害现在几倍」。
     * 玩家从此处学会「打倒一枚 = 之后所有 Boss 伤害更高」，这正是新定位的教学面。
     */
    const sweepTag = killCmds.find(
      (c) => c.t === 'fx' && c.fx === 'enemyHitRing' && (c.text ?? '').startsWith('清空 '),
    ) as { text?: string } | undefined;
    // 飘字里的进度和倍率必须**和 snapshot 对得上**，不能只是句安慰话。
    const killTag =
      Boolean(sweepTag) &&
      sweepAfter > 1 &&
      (sweepTag!.text ?? '').includes(`${snap2.enemy.total - snap2.enemy.alive}/${snap2.enemy.total}`) &&
      (sweepTag!.text ?? '').includes(`×${sweepAfter.toFixed(2)}`);

    // 相性：火球打 5 枚敌人钉应当分成四档，且档位高低必须与 wuxingTier 一致。
    // 会心是随机的，所以每档取 N 次里的**最小值**（会心只会把数字顶大，不会压小），
    // 最小值就是这一档的无会心伤害，可以直接比倍率。
    const wusong = bundle.characters.find((c) => c.id === 'wusong')!;
    const minDmg = (pegId: string, n: number): number => {
      let min = Infinity;
      for (let i = 0; i < n; i++) {
        const s = new BattleSim(stage, [wusong], bundle.links);
        const cs = s.handle({ t: 'pegHit', pegId, pegKind: 'enemy', intensity: 0.6, x: 0, y: 20 });
        // 读 value，不读 text。text 是给人看的话（「3弹 154」），
        // 从里面抠数字在文案一改就会静默算错——这是之前踩过的坑。
        const fx = cs.find((c) => c.t === 'fx' && c.fx === 'enemyHit') as { value?: number } | undefined;
        const d = fx?.value ?? 0;
        if (d > 0 && d < min) min = d;
      }
      return min === Infinity ? 0 : min;
    };
    // 一个 formation 会展开成十几枚敌人钉，这里每种五行只取一枚，
    // 否则五行覆盖校验会把同一行重复打二十遍，报告读不出来
    const one = new Map<string, (typeof enemies)[number]>();
    for (const p of enemies) if (p.wuxing && !one.has(p.wuxing)) one.set(p.wuxing, p);
    const tierRows = [...one.values()]
      .map((p) => {
        const tier = wuxingTier(wusong.wuxing, p.wuxing!);
        const expect = tier.tier === 'win' ? e.attrWin : tier.tier === 'gen' ? e.attrGen : tier.tier === 'same' ? 1 : e.attrLose;
        return { id: p.id, wx: p.wuxing!, tier: tier.tier, expect, dmg: minDmg(p.id, 6) };
      })
      .sort((a, b) => b.dmg - a.dmg);

    // 基线：同属那一档倍率恒为 1，用它当分母把其它档归一化回来
    const base = tierRows.find((r) => r.tier === 'same')!;
    const normalized = tierRows.map((r) => ({ ...r, real: base.dmg > 0 ? r.dmg / base.dmg : 0 }));
    // 容差 ±8%：伤害公式里还有 (0.7 + intensity*0.6) 和 Math.round，比例会有取整误差
    const ratioOk = normalized.every((r) => Math.abs(r.real - r.expect) / r.expect < 0.08);
    const allTiers = new Set(normalized.map((r) => r.tier));
    const fourTiers = allTiers.size === 4;
    const attrWorks = fourTiers && ratioOk && normalized.every((r) => r.dmg > 0);

    // 相生必须真的比同属高：这是"多一档"的卖点，不能是个摆设
    const gen = normalized.find((r) => r.tier === 'gen')!;
    const genHelps = gen.real > 1;
    const same = normalized.find((r) => r.tier === 'same')!;

    // 反弹次数要接进落槽：多弹一次，落槽数字必须更大
    // 注意要取 bossDamage / slot 那一发的 value，不能取 cmds[0]——
    // 触发槽的落槽会先产出一条 feverStart 演出，它的 text 是「確 変」没有数值。
    const slotDamage = (s: BattleSim): number => {
      const cs = s.handle({ t: 'slotEnter', slotId: trigger.id, kind: trigger.kind, value: trigger.value, weak: true, x: 0, y: 2 });
      const fx = cs.find((c) => c.t === 'fx' && (c.fx === 'bossDamage' || c.fx === 'slot')) as { value?: number } | undefined;
      return fx?.value ?? 0;
    };
    const primeBounces = (s: BattleSim, n: number): void => {
      for (let i = 0; i < n; i++) {
        s.handle({ t: 'launch', power: 20, angleDeg: 90, x: 0, y: 29 });
        s.handle({ t: 'pegHit', pegId: stage.pegs[0]!.id, pegKind: stage.pegs[0]!.kind, intensity: 0.5, x: 0, y: 20 });
      }
    };
    const simR = new BattleSim(stage, bundle.characters, bundle.links);
    const n0 = slotDamage(simR);
    const simR2 = new BattleSim(stage, bundle.characters, bundle.links);
    primeBounces(simR2, 20);
    const n1 = slotDamage(simR2);
    const bounceWorks = n1 > n0;

    // 飘字文案必须把「第几弹」印出来，而且它印的那个数字要和 value 一致。
    //
    // 整个游戏的核心手感是「撞得越久打越疼」，一个光秃秃的 154 读不出这件事，
    // 玩家只会以为自己在打固定伤害。这条是它的回归保护：谁把「7弹 154」改回「154」，
    // 或者把弹数和伤害对错位，这里立刻红。text 只验格式，数值一律走 value。
    //
    // 要先攒够反弹数——第 0 弹那一发按设计只印裸数字（还没开始弹，谈不上「弹得越久」）。
    const simTag = new BattleSim(stage, bundle.characters, bundle.links);
    primeBounces(simTag, 7);
    const tagCmds = simTag.handle({ t: 'pegHit', pegId: target.id, pegKind: 'enemy', intensity: 0.6, x: 0, y: 20 });
    const tagFx = tagCmds.find((c) => c.t === 'fx' && (c.fx === 'enemyHit' || c.fx === 'crit')) as
      | { text?: string; value?: number }
      | undefined;
    const parts = (tagFx?.text ?? '').split(' ');
    const tagSaysBounce = parts.length === 2 && /^(\d+)弹$/.test(parts[0]!);
    const tagNumMatches = Number(parts[1]) === (tagFx?.value ?? -1);
    const dmgTeaches = tagSaysBounce && tagNumMatches;
    const hitDamageMatchesFormula = simTag.snapshot().enemy.hitDamage > 0;

    // 万金钉：这块以前是纯死数据——12 关每关都布了 4~8 枚，渲染是全盘第二亮，
    // 但代码里没有任何一行读 kind === 'golden'。玩家撞最扎眼的钉子，什么都不会发生。
    // 这里锁三件事：撞得到会喊、喊出来的倍率对得上、落槽数字真的变大。
    // 少任何一件都会退化成「视觉在喊、逻辑在沉默」的谜语人盘面。
    const goldPeg = stage.pegs.find((p) => p.kind === 'golden');
    let goldWorks = false;
    if (!goldPeg) {
      console.log('  万金钉：本关没有布置 golden 钉，跳过');
    } else {
      const gs = new BattleSim(stage, bundle.characters, bundle.links);
      gs.handle({ t: 'launch', power: 20, angleDeg: 90, x: 0, y: 29 });
      const gCmds = gs.handle({ t: 'pegHit', pegId: goldPeg.id, pegKind: 'golden', intensity: 0.6, x: 0, y: 20 });
      const gFx = gCmds.find((c) => c.t === 'fx' && c.fx === 'golden') as { text?: string; value?: number } | undefined;
      // 撞一颗就该是 goldenPegMult 的 1 次方，且 snapshot 的计数同步 +1
      const gVal = Math.pow(COMBAT.goldenPegMult, 1);
      const gCounted = gs.snapshot().goldHits === 1;
      const gSays = gFx?.value === gVal;

      // 再撞一颗，倍率必须真的叠上去（1.5 → 2.25），并且落槽伤害比一颗时更高
      const g2 = gs.handle({ t: 'pegHit', pegId: goldPeg.id, pegKind: 'golden', intensity: 0.6, x: 0, y: 20 });
      const g2Fx = g2.find((c) => c.t === 'fx' && c.fx === 'golden') as { value?: number } | undefined;
      const gStacks = g2Fx?.value === Math.pow(COMBAT.goldenPegMult, 2);

      const coin = stage.slots.find((s) => s.kind === 'normal') ?? stage.slots[0]!;
      const coinDmg = (s: BattleSim): number => {
        const cs = s.handle({ t: 'slotEnter', slotId: coin.id, kind: coin.kind, value: coin.value, weak: false, x: 0, y: 2 });
        const fx = cs.find((c) => c.t === 'fx' && c.fx === 'slot') as { value?: number } | undefined;
        return fx?.value ?? 0;
      };
      const noGold = new BattleSim(stage, bundle.characters, bundle.links);
      const oneGold = new BattleSim(stage, bundle.characters, bundle.links);
      oneGold.handle({ t: 'launch', power: 20, angleDeg: 90, x: 0, y: 29 });
      oneGold.handle({ t: 'pegHit', pegId: goldPeg.id, pegKind: 'golden', intensity: 0.6, x: 0, y: 20 });
      const g0 = coinDmg(noGold);
      const g1 = coinDmg(oneGold);
      const gPaysOff = g0 > 0 && g1 > g0;
      // 落槽飘字必须把这颗球吃了几枚金钉印出来，否则玩家对不上账
      const slotFx = oneGold.snapshot();
      void slotFx;

      goldWorks = gSays && gCounted && gStacks && gPaysOff;
      console.log(
        `  万金钉 ${goldPeg.id}：撞到喊话=${!!gFx} 喊的倍率=${gFx?.value}（期望 ${gVal.toFixed(2)} 对得上=${gSays}）`,
      );
      console.log(`  第二枚叠到 ×${g2Fx?.value?.toFixed(2)}（期望 ${Math.pow(COMBAT.goldenPegMult, 2).toFixed(2)} 对得上=${gStacks}） snapshot 计数=${gs.snapshot().goldHits}`);
      console.log(`  落槽铜钱：不撞=${g0} 撞一枚=${g1} 真的更疼=${gPaysOff}`);
    }

    const ok =
      hitFx.length > 0 && hpLeft && alive > 0 && killed === 1 && boost && attrWorks && genHelps &&
      bounceWorks && killLeavesBossAlone && sweepRamped && killTag && arcOn && dmgTeaches && hitDamageMatchesFormula && goldWorks;
    console.log(`  敌人 ${target.id} hp=${hp} 五行=${target.wuxing}：命中爆数字=${hitFx.length > 0} 首击后剩余敌人=${alive}`);
    console.log(`  血弧指令有发=${arcOn}（首击后剩余 ${(arc[0]?.ratio ?? 0).toFixed(2)}）`);
    console.log(`  伤害飘字带弹数=${tagSaysBounce} 文案「${tagFx?.text ?? ''}」数字对得上=${tagNumMatches}`);
    console.log(`  HUD 反弹伤读 sim 算的 hitDamage=${simTag.snapshot().enemy.hitDamage}（>0=${hitDamageMatchesFormula}）`);
    console.log(`  击坠=${killed === 1} 击坠给球速=${boost} 击坠后存活=${snap2.enemy.alive} 累计击坠=${snap2.enemy.killed}`);
    console.log(`  击坠扣 Boss 血：${bossHpBefore}→${snap2.bossHp}（击坠不该直接掉血=${killLeavesBossAlone}）清空倍率 ×${sweepAfter.toFixed(2)}（应 ≥ ×${sweepFloor.toFixed(2)}=${sweepRamped}）`);
    console.log(`  击坠报清空进度=${killTag} 飘字「${sweepTag?.text ?? '（无）'}」`);
    for (const r of normalized) {
      console.log(
        `    ${(WUXING_LABEL[r.wx] + '(' + r.wx + ')').padEnd(14)} ${r.tier.padEnd(5)} 伤害 ${String(r.dmg).padStart(4)}  归一 ×${r.real.toFixed(3)}  期望 ×${r.expect}  ${Math.abs(r.real - r.expect) / r.expect < 0.08 ? 'OK' : '偏差过大'}`,
      );
    }
    console.log(`  四档齐全=${fourTiers} 倍率对得上=${ratioOk} 相生确实强于同属=${genHelps}（同属 ${same.dmg} → 相生 ${gen.dmg}）`);
    console.log(`  反弹接落槽：0 弹 ${n0} → 20 弹 ${n1} 递增=${bounceWorks}`);
    console.log(`  会心率 ${e.critChance} / 会心倍率 ${e.critMult} / 每弹加成 ${e.perBounce}（上限 ${e.bounceMax} 弹）`);
    console.log(`  结果：${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) process.exitCode = 1;
  }
}

/**
 * 击射机制硬校验。
 *
 * 这是整个游戏**唯一的操作**，也是「弹珠游戏 vs 动画」的分界线。
 * 之前 launch 只在球落槽之后允许，于是玩家松手之后有 5~9 秒什么都做不了——
 * 那一段纯观看的空白就是「这不是弹珠游戏」的根源。
 *
 * 这里锁四件事：
 *  1. 球在盘上时（live）也能击射 —— 机制存在
 *  2. 击射从**球的当前位置**出发 —— 不是偷偷把球传送回发射器
 *  3. 击射要扣资源 —— 否则没有代价，14 发能被连点烧光
 *  4. 冷却真的挡住了连点 —— 一帧内打两次只能生效一次
 *  5. 补射**不清空反弹数** —— 清了的话「救球」反而变亏，机制和目标正好相反
 */
function verifyShots(bundle: GameDataBundle, team: string[]): void {
  console.log('\n=== 击射机制硬校验 ===');
  {
    const source = expandStage(bundle.stages[0]!);
    // 控制测试的轨迹让球向下运动后减速；金环是否出现不依赖某关的随机碰撞。
    // 各关真实钉阵/重力的可玩性已由 verifyStages 覆盖。
    //
    // 球道是机台硬件，**不受这个夹具影响**：这里测的是救球，而救球发生在球
    // 已经在盘上之后。所以仍然走 plunge 首发，只把球道缩短、重力清零，
    // 让它在几步之内就出射，不至于把 240 步的等待预算全耗在爬道上。
    const stage = { ...source, width: 40, height: 60, gravity: 0, pegs: [], zones: [], walls: [],
      plunger: { ...source.plunger, restY: 25, bendY: 55, minPower: 20, maxPower: 26 },
    };
    const waitForGolden = (b: PhysicsBoard): void => {
      b.apply({ t: 'setDampingScale', channel: 'shot_fixture', scale: 30, duration: 5 });
      for (let i = 0; i < 240 && b.state === 'live' && !b.isReady; i++) b.step(PHYSICS.fixedDt);
    };
    const squad = team.map((id) => bundle.characters.find((c) => c.id === id)!) as CharacterDef[];

    const makeBoard = (): PhysicsBoard => {
      const physics = new Physics(stage.gravity);
      const sim = new BattleSim(stage, squad, bundle.links);
      const board = new PhysicsBoard(physics, stage, {
        onEvent: (ev) => {
          void sim.handle(ev);
        },
      });
      return board;
    };

    // ---- 1 + 2：球在盘上时能打，且从当前位置出发 ----
    const b1 = makeBoard();
    b1.armLauncher();
    // 首发走 plunge（竖直弹射，不带角度）。朝上打：朝下打的话前 90 步还没上阻尼、
    // 球以满速飞出，等 waitForGolden 把阻尼加上去时球已经贴到槽口那排传感器了，
    // 一进槽 state 变 done，后面「补射 / 扣发 / followUp 标记」全跟着失效——
    // 而且报出来的是几个毫不相干的失败。
    b1.plunge(24);
    // 推进到球已经飞出去一段（离开发射器）
    for (let i = 0; i < 40; i++) b1.step(PHYSICS.fixedDt);
    const liveX = b1.ballX;
    const liveY = b1.ballY;
    const leftLauncher = Math.hypot(liveX - stage.plunger.x, liveY - stage.plunger.restY) > 1.5;
    // 等冷却过去（0.34s = 40.8 步，推 50 步留够余量）
    for (let i = 0; i < 50; i++) b1.step(PHYSICS.fixedDt);
    waitForGolden(b1);
    const wasLive = b1.state === 'live';
    const atX = b1.ballX;
    const atY = b1.ballY;
    b1.shoot(24, 90);
    // 击射后球的**新起点**应该就在击射处，不是弹回发射器
    const fromBall = Math.hypot(b1.ballX - atX, b1.ballY - atY) < 1.2;
    const canShootLive = wasLive && b1.state === 'live';
    console.log(
      `  球在盘上时能击射=${canShootLive}（击射前位置 ${atX.toFixed(1)},${atY.toFixed(1)}）`,
    );
    console.log(
      `  击射从球当前位置出发=${fromBall}（首发后已离开发射器=${leftLauncher}，首发落点 ${liveX.toFixed(1)},${liveY.toFixed(1)}）`,
    );
    b1.dispose();

    // ---- 3：击射扣资源 ----
    const physics2 = new Physics(stage.gravity);
    const sim2 = new BattleSim(stage, squad, bundle.links);
    const b2 = new PhysicsBoard(physics2, stage, { onEvent: (ev) => void sim2.handle(ev) });
    b2.armLauncher();
    const before = sim2.snapshot().ballsLeft;
    b2.plunge(24);
    const afterFirst = sim2.snapshot().ballsLeft;
    // 冷却是 0.34s = 40.8 个定步。必须推够 50 步，否则第二发会被冷却吃掉，
    // 测试就会误报「追打不扣资源」——是时序没等够，不是机制漏了扣减。
    for (let i = 0; i < 50; i++) b2.step(PHYSICS.fixedDt);
    waitForGolden(b2);
    b2.shoot(24, 90);
    const afterSecond = sim2.snapshot().ballsLeft;
    const costsOne = before - afterFirst === 1 && afterFirst - afterSecond === 1;
    console.log(
      `  每次击射扣 1 发=${costsOne}（${before} → 首发后 ${afterFirst} → 追打后 ${afterSecond}）`,
    );

    // ---- 4：冷却挡连点 ----
    const readyNow = b2.canShoot;
    b2.shoot(24, 90);
    const blockedByCd = !b2.canShoot;
    console.log(`  冷却中挡住连点=${blockedByCd}（击射前可打=${readyNow}）`);
    b2.dispose();
    physics2.dispose();

    // ---- 5：补射不清空反弹数 ----
    // 反弹数是「撞得越久打越疼」的主变量。补射顺手清零的话，
    // 救球反而变亏，玩家的最优策略就变成「别救，让它掉」——
    // 机制和目标正好相反。所以这条必须锁死。
    const physics3 = new Physics(stage.gravity);
    const sim3 = new BattleSim(stage, squad, bundle.links);
    let followUpFlags: boolean[] = [];
    const b3 = new PhysicsBoard(physics3, stage, {
      onEvent: (ev) => {
        if (ev.t === 'launch') followUpFlags.push(ev.followUp === true);
        void sim3.handle(ev);
      },
    });
    b3.armLauncher();
    b3.plunge(24);
    const peg2 = source.pegs.find((p) => p.kind === 'normal') ?? source.pegs[0]!;
    // 手动灌 6 次撞钉，把连击/反弹数攒起来（物理层不会每次都真的撞到同一颗钉，
    // 这里要验的是**逻辑层**的行为，不是碰撞概率）
    for (let i = 0; i < 6; i++) {
      sim3.handle({ t: 'pegHit', pegId: peg2.id, pegKind: peg2.kind, intensity: 0.6, x: peg2.x, y: peg2.y });
    }
    // 走一次真实的补射路径（推够 50 步等冷却过，否则这一发会被冷却吃掉）
    for (let i = 0; i < 50; i++) b3.step(PHYSICS.fixedDt);
    waitForGolden(b3);
    b3.shoot(24, 90);
    const afterSnap = sim3.snapshot();
    // maxCombo 在补射之后必须还在（>= 6，因为每次 pegHit 都会涨连击）
    const keptCombo = afterSnap.maxCombo >= 6;
    const sawFollowUp = followUpFlags.filter(Boolean).length > 0;
    console.log(
      `  补射不清空进度=${keptCombo}（连击 ${afterSnap.maxCombo} ≥ 补射前 6） 补射被标记为 followUp=${sawFollowUp}`,
    );
    b3.dispose();
    physics3.dispose();

    const ok = canShootLive && fromBall && leftLauncher && costsOne && blockedByCd && keptCombo && sawFollowUp;
    console.log(`  结果：${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) process.exitCode = 1;
  }
}

/**
 * 逐关硬校验：几何 + 可玩性。
 *
 * 分两层，因为「看起来对」和「玩得下去」是两件事：
 *
 *  1. **几何层**（`auditLanes`）：两颗钉相交是硬错，球会被分离冲量弹飞；
 *     窄巷是软警告——静止球会卡住，但高速球能穿过去，所以只报不判。
 *  2. **实测层**：真的把每一关跑 N 局，看三件事——
 *     · 至少能赢一次（关卡不是死局）
 *     · 超时率不能高（球挂盘上 = 玩家在等）
 *     · 单一坐标不能反复成为超时热点（那就是阵型死角，几何层看不出来的）
 *
 * 第二层是几何层做不到的：两枚钉净缝 0.30 的窄巷，低重力关的球飞得高、擦过去；
 * 同一道缝在高重力关球速慢，就会真的卡死。判据必须由实际的关卡参数来定。
 */
/** 一关的标定结果。`goodWeak` 是该关 12 局合计的合格弱口归一伤害均值。 */
interface CalibrationRow {
  id: string;
  weakSlots: number;
  weakApplied: number;
  goodWeak: number;
  sweepMax: number;
  enemyCount: number;
  minBalls: number;
  budgetUsed: number;
}

/**
 * 关卡标定报表。
 *
 * 关卡规划的公式是 `boss.maxHp = pull × GOOD_WEAK × (1 - armor)`
 * （见 docs/superpowers/reviews/2026-10-10-level-core-plan.md 第 3 节），
 * 而 `GOOD_WEAK` 必须是**量出来的**，不能拍。量法：
 * 每落进一次「破绽」槽，取当次结算实际打掉的 Boss 血，
 * 除以当时的 `sweepMult × (1 - armor)`，把这两个乘区剥掉，
 * 剩下的就是「这一次弱口本身值多少」—— 与本关小怪个数、本关护甲无关。
 *
 * 取样在 `runOnce` 的 onEvent 里，回路必须每次重跑都变，
 * 因为 GOOD_WEAK 跟着技能/连携的改动会漂，固定样例会掩盖漂移。
 */
/**
 * 破绽口的槽底值。`genstages.slotsFor` 给每一关发同一个值，
 * 所以从任意一关读都一样 —— 读数据而不是写死 210，数值只有一处定义。
 */
function weakBaseOf(stage: ReturnType<typeof expandStage>): number {
  return stage.slots.find((s) => s.id === 'slot_weak')?.value ?? 210;
}

/**
 * 打印标定结果，**并把违反关卡核心契约的项作为硬失败返回**。
 *
 * 这些断言是 `docs/superpowers/reviews/2026-10-10-level-core-plan.md` 里
 * 三条核心契约的可执行形式。没有它们，那三条就只是文档里的一段话，
 * 下次谁改一下 `perSweep` 或手拉一下 `maxHp`，难度曲线又会静默垮掉：
 *  · 难度必须单调 —— 理论最少球逐关递增；
 *  · 清场必须跨关恒定 —— 满清倍率极差 ≈ 0，否则玩家学到的是“拼小怪”而不是“拼弱口”；
 *  · 球预算必须贴着盘面 —— 实测用球占预算 45%~75%，否则就是球多得用不完
 *    （旧版 42% 且失败条件形同虚设）或紧到没法玩。
 */
/** 用球量的 90 分位：预算要覆盖的是尾部，不是均值。 */
function p90(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)] ?? 0;
}

function printCalibration(rows: CalibrationRow[], weakBase: number): string[] {
  const sum = (k: keyof CalibrationRow) => rows.reduce((a, r) => a + (r[k] as number), 0);
  const goodWeak = sum('goodWeak') / rows.length;
  const budgetUsed = sum('budgetUsed') / rows.length;
  const minBalls = rows.map((r) => r.minBalls);
  const mults = rows.map((r) => r.goodWeak);
  const sweeps = rows.map((r) => r.sweepMax);
  const spread = Math.max(...sweeps) - Math.min(...sweeps);
  /*
   * 单调性检查允许 25% 的单关回落。
   *
   * 严格递增的前提是「盘面不影响 Boss 强度」，而实测否定了这个前提：
   * 同样吃 3 次破绽口，第 11 关的 funnel/spiral 阵型靠连锁引爆收工，
   * 第 9 关的 chevron/hex 只能靠破绽口硬磨——所以 genstages 给第 9 关挂了
   * LAYOUT_BOSS_FACTOR 做**显式补偿**，那一关的 boss.maxHp 反而低于同拉力关。
   *
   * 容忍的是「有据可查的补偿」，不是失控：25% 足以抓住之前清场倍率失控
   * （实测 ×2.50~×11.20）和球预算失效那两类问题。
   */
  const MONOTONIC_SLACK = 0.25;
  const monotonic = minBalls.every((v, i) => i === 0 || v >= minBalls[i - 1]! * (1 - MONOTONIC_SLACK));

  console.log('\n=== 关卡标定 ===');
  console.log(`  GOOD_WEAK（单次合格弱口伤害）      ${weakBase.toFixed(0)} × ${goodWeak.toFixed(2)} = ${(weakBase * goodWeak).toFixed(0)}`);
  console.log(`  合格弱口归一倍数                  ${goodWeak.toFixed(2)}  （${Math.min(...mults).toFixed(2)} ~ ${Math.max(...mults).toFixed(2)}，槽底 ${weakBase} × 上限 ${COMBAT.slotMultCap}）`);
  console.log(`  平均满清倍率                      ×${(sum('sweepMax') / rows.length).toFixed(2)}` +
    `  （${Math.min(...sweeps).toFixed(2)} ~ ${Math.max(...sweeps).toFixed(2)}）`);
  console.log(`  平均击射 / 球预算                 ${(budgetUsed * 100).toFixed(0)}%`);
  console.log(`  平均每局合格弱口                  ${(sum('weakSlots') / rows.length).toFixed(1)} 次`);
  console.log(`  理论最少球                        ${minBalls.map((v) => v.toFixed(1)).join(' ')}`);
  console.log(`  理论最少球单调递增                ${monotonic ? '是' : '否 ← 难度曲线非单调'}`);
  console.log(`  满清倍率极差                      ×${spread.toFixed(2)}  跨关强度差 ${(Math.max(...sweeps) / Math.min(...sweeps)).toFixed(1)}×`);
  console.log(`  一次合格弱口伤害                 ${weakBase} × ${goodWeak.toFixed(2)} = ${(weakBase * goodWeak).toFixed(0)}`
    + `    ——这只是 smoke 的实测读数；genstages 里 boss.maxHp 用的是`
    + ` pull × 210 × ${COMBAT.slotMultCap} × ${SWEEP_MAX} × ${PLAYER_QUALITY} × layout × (1 - armor)，`
    + `两者不是同一个数，别拿这行去反推。`);

  const problems: string[] = [];
  if (!monotonic) {
    problems.push(`理论最少球回落超过 ${(MONOTONIC_SLACK * 100).toFixed(0)}%：${minBalls.map((v, i) => (i === 0 || v >= minBalls[i - 1]! * (1 - MONOTONIC_SLACK) ? '' : `#${i + 1} `) + v.toFixed(1)).join(' ')}`);
  }
  if (spread > 0.05) {
    problems.push(`满清倍率跨关不恒定，极差 ×${spread.toFixed(2)}（${Math.min(...sweeps).toFixed(2)}~${Math.max(...sweeps).toFixed(2)}）：perSweep 必须由实际枚数反推，不能定值`);
  }
  if (budgetUsed < 0.45 || budgetUsed > 0.75) {
    problems.push(`实测用球/球预算 = ${(budgetUsed * 100).toFixed(0)}%，超出 45%~75%：球预算应 = 实测用球 x 1.6（见 genstages.SHOT_BUDGET_SLACK）`);
  }
  if (goodWeak < 1.5) {
    problems.push(`合格弱口归一倍数只有 ${goodWeak.toFixed(2)}，弱口探针多半已失效（曾经 4.14，贴着 slotMultCap ${COMBAT.slotMultCap}）`);
  }
  return problems;
}

function verifyStages(bundle: GameDataBundle, team: string[]): void {
  const N = 12;
  console.log(`\n=== ${bundle.stages.length} 关逐关校验（每关 ${N} 局）===`);
  const problems: string[] = [];
  /**
   * 每关一行标定，最后汇总成 GOOD_WEAK。
   * 类型与 `printCalibration` 的入参保持一致 —— 那是同一条数据链的两头，
   * 改字段时漏改一处会在合计那行报 undefined，比静默算错好。
   */
  const calib: CalibrationRow[] = [];

  bundle.stages.forEach((def, idx) => {
    const stage = expandStage(def);
    const audit = auditLanes(stage.pegs, PHYSICS.ballRadius);
    if (audit.overlaps.length) {
      problems.push(`${def.id} 有 ${audit.overlaps.length} 对相交钉：${auditSummary(audit, 2)}`);
    }

    const runs: RunResult[] = [];
    for (let i = 0; i < N; i++) runs.push(runOnce(bundle, def, 7000 + idx * 104729 + i * 7919, team, i));

    const wins = runs.filter((r) => r.phase === 'victory').length;
    const balls = runs.reduce((n, r) => n + r.ballsUsed, 0) / runs.length;
    const timeouts = runs.reduce((n, r) => n + r.endReason.timeout, 0);
    const totalEnds = runs.reduce((n, r) => n + r.finishedBalls, 0) || 1;
    const timeoutRate = timeouts / totalEnds;

    // 超时热点：同一坐标（取 1 位小数）反复卡，说明那儿有个几何层看不出来的死角
    const spots = new Map<string, number>();
    for (const r of runs) {
      for (const s of r.timeoutSpots) {
        const k = `${s.x.toFixed(1)},${s.y.toFixed(1)}`;
        spots.set(k, (spots.get(k) ?? 0) + 1);
      }
    }
    const hot = [...spots.entries()].sort((a, b) => b[1] - a[1])[0];

    const shapes = [...new Set(def.board.pegFormations.map((f) => f.shape))].join('/');
    /*
     * 标定：把三个乘区（清空倍率 sweep、护甲 armor）之外的部分单独摘出来，
     * 得到的才是跨关可比的「一次合格弱口伤害」。
     * 理论最少球用的破绽口上限直接读盘面数据（`slot_weak` 的 value），
     * 不另抄一份 210 —— 数值只有一处定义，改 genstages 时这里自动跟着走。
     */
    const weakSlots = runs.reduce((n, r) => n + r.weakSlots, 0);
    const weakApplied = runs.reduce((n, r) => n + r.weakApplied, 0);
    const weakNormSum = runs.reduce((n, r) => n + r.weakNormSum, 0);
    const enemies = stage.pegs.filter((p) => p.kind === 'enemy');
    const enemyCount = enemies.length;
    const sweepMax = 1 + def.rules.enemy.perSweep * enemyCount;
    const weakValue = stage.slots.find((s) => s.id === 'slot_weak')?.value ?? 0;
    const onePerfect = weakValue * COMBAT.slotMultCap;
    const minBalls = def.boss.maxHp / (onePerfect * sweepMax * (1 - def.boss.armor));
    calib.push({
      id: def.id,
      weakSlots: weakSlots / N,
      weakApplied: weakApplied / N,
      goodWeak: weakSlots > 0 ? weakNormSum / weakSlots : 0,
      sweepMax,
      enemyCount,
      minBalls,
      budgetUsed: balls / def.rules.balls,
    });
    console.log(
      `  ${String(idx + 1).padStart(2)} ${def.name.padEnd(12, '　')} ` +
        `钉${String(stage.pegs.length).padStart(3)} 宽${String(def.board.width).padStart(2)} ` +
        `球${String(def.rules.balls).padStart(2)} 胜${String(Math.round((wins / N) * 100)).padStart(3)}% ` +
        `击射${balls.toFixed(1).padStart(5)} 超时${((timeoutRate * 100) | 0).toString().padStart(2)}% ` +
        `弱口${(weakSlots / N).toFixed(1).padStart(5)} 倍数${(weakSlots ? weakNormSum / weakSlots : 0).toFixed(2)} ` +
        `汇率×${sweepMax.toFixed(2)} 残怪${(runs.reduce((n, r) => n + r.minionsAlive, 0) / N).toFixed(1).padStart(4)} ` +
        `僵${runs.filter((r) => r.phase === 'playing').length} ` +
        `撞怪${(runs.reduce((n, r) => n + r.enemyHits, 0) / N).toFixed(1).padStart(6)} ` +
        // 用球量报均值不够：均值会被一两局「球在盘上磨到超时」的长尾拽偏，
        // 拿它拟预算会让整关的额度跟着离群局走。第 9 关就吃过这个亏。
        `p90${p90(runs.map((r) => r.ballsUsed)).toString().padStart(4)} ` +

        `${shapes}`,
    );

    if (wins === 0) problems.push(`${def.id} 用标准三卡队 ${N} 局一局都赢不了：死局`);
    // 「可赢」是硬标准，不是「大部分能赢」。清场是通关条件，
    // 一局收不了工就意味着这关对那个球序是死局——12 局里出现一次也要报。
    if (wins > 0 && wins < N) {
      const stuck = runs.filter((r) => r.minionsAlive > 0)
        .map((r) => `剩${r.minionsAlive}枚@${r.stuckSpots.map((p) => `(${p.x},${p.y})`).join('')}`).slice(0, 3).join('  ');
      /*
       * 把 12 局逐局读数一并打出来。只报「1 局输了」没法定位：同一句断言背后
       * 可能是「尾部局牌不够」（该加球预算）、「Boss 血差一截」（该加伤害）、
       * 「残怪收不掉」（该改落点），三者的修法完全不同。
       */
      const per = runs.map((r, i) => `${i}:${r.phase === 'victory' ? '胜' : '负'} hp${(r.bossHp / r.bossMaxHp * 100).toFixed(0)}% 射${r.ballsUsed} 余${r.ballsTotal - r.ballsUsed} 怪${r.minionsAlive} ${r.seconds.toFixed(0)}s`).join('  ');
      problems.push(`${def.id} ${N} 局只赢 ${wins} 局：收不了工的局 ${N - wins} 场（球耗尽还剩小怪）｜${stuck}｜${per}`);
    }
    if (timeoutRate > 0.12) {
      /*
       * 报出**超时球都卡在哪**。只报一个百分比的话，调参时根本不知道往哪看：
       * 同一个 15% 可能是「盘心有个死角」（改布局）也可能是
       * 「翻板附近球绕圈」（改翻板），两者的修法完全不同。
       */
      const where = [...spots.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, c]) => `${k}×${c}`).join('  ');
      /*
       * 再带上球况。只报坐标分不清「盘面死角」和「机制卡住」：
       * 同样一个 (9.9, 1.2)，可能是盘面边缘的坑，也可能是球根本没进主盘
       * 一直在弹射道里弹。两种的修法完全相反。
       */
      const detail = runs.flatMap((r) => r.timeoutSpots)
        .slice(0, 3).map((s) => `(${s.x},${s.y}) v=(${s.vx},${s.vy})${s.inLane ? '道内' : '盘上'} 重顶${s.laneStalls} 闸${s.pending?1:0}/已射${s.fired?1:0}/${s.state}`).join('  ');
      problems.push(
        `${def.id} 超时率 ${(timeoutRate * 100).toFixed(0)}% 偏高，球在盘上挂太久（${where || '无重复点'}｜${detail}）`,
      );
    }
    if (hot && hot[1] >= 4) {
      problems.push(`${def.id} 卡在同一个点 ${hot[1]} 次：(${hot[0]}) 附近有死角`);
    }
    if (audit.nests.length > 110) {
      problems.push(`${def.id} 窄巷 ${audit.nests.length} 处，钉阵过密`);
    }
  });

  // 标定即验收：把契约断言并进同一份问题清单，而不是只打印一行好看的数字
  problems.push(...printCalibration(calib, weakBaseOf(expandStage(bundle.stages[0]!))));
  problems.push(...verifyPhaseDeprivations(bundle));

  if (problems.length) {
    console.log('\n  关卡问题：');
    for (const p of problems) console.log(`    ✗ ${p}`);
    throw new Error(`${problems.length} 处关卡问题`);
  }

  console.log(`  ${bundle.stages.length} 关全部通过：可赢、不卡死、无相交钉、难度单调、清场倍率恒定`);
}

/**
 * 相位剥夺阶梯的三条硬约束。
 *
 * 「aim / ammo / time」取代旧的 none/shield/frenzy 之后，最大的风险不是数值，
 * 而是**剥夺被写乱**：某一关提前上了 time、或者局内后一条相位比前一条少一项，
 * 玩家会看到「刚打完更难的东西，限制反而松了」。
 *
 * 这三条都只能靠数据断言，靠试玩是试不出来的（12 关 × 3 相位 = 36 处）。
 */
function verifyPhaseDeprivations(bundle: GameDataBundle): string[] {
  const problems: string[] = [];
  const ORDER: PhaseDeprivation[] = ['aim', 'ammo', 'time'];
  const expectedMax = (idx: number): number => (idx < 4 ? 1 : idx < 8 ? 2 : 3);

  bundle.stages.forEach((def, idx) => {
    const phases = def.boss.phases;
    if (phases.length > 3) problems.push(`${def.id} 有 ${phases.length} 条相位，阶梯最多 3 条`);
    let prev: PhaseDeprivation[] = [];
    for (const p of phases) {
      // 1. 维度不能乱序出现（time 在 ammo 之前 = 剥夺被写反了）
      const ranks = p.deprive.map((d) => ORDER.indexOf(d));
      if (ranks.some((r) => r < 0)) problems.push(`${def.id}「${p.name}」有未知维度 ${p.deprive.join('+')}`);
      if (ranks.some((r, i) => i > 0 && r < ranks[i - 1]!)) {
        problems.push(`${def.id}「${p.name}」维度乱序：${p.deprive.join('+')}`);
      }
      // 2. 后一条必须是前一条的超集
      const missing = prev.filter((d) => !p.deprive.includes(d));
      if (missing.length) {
        problems.push(`${def.id}「${p.name}」少了上一条相位的剥夺 ${missing.join('+')}：局内不该越打越宽松`);
      }
      prev = p.deprive;
    }
    // 3. 分幕递进：前四关最多 1 维，中四关最多 2 维，后四关才允许三维齐发
    const maxDims = Math.max(0, ...phases.map((p) => p.deprive.length));
    const cap = expectedMax(idx);
    if (maxDims > cap) problems.push(`${def.id} 上到 ${maxDims} 维剥夺（这一幕上限 ${cap} 维）`);
  });
  return problems;
}

async function main(): Promise<void> {
  await initPhysics();
  const bundle = await loadBundle(nodeReader);

  const stage = expandStage(bundle.stages[0]!);
  const byKind = new Map<string, number>();
  for (const p of stage.pegs) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
  console.log('数据自检：');
  console.log(`  角色 ${bundle.characters.length} 名 / 连携 ${bundle.links.length} 组 / 关卡 ${bundle.stages.length} 个`);
  console.log(`  展开后钉板 ${stage.pegs.length} 枚 ${[...byKind].map(([k, v]) => `${k}:${v}`).join(' ')}`);
  console.log(`  区域 ${stage.zones.length} 个 / 落槽 ${stage.slots.length} 个 / 机关 ${stage.walls.length} 面`);

  // 队伍覆盖到 12 人阵容：同五行不同队形（武松+秦明都是火）要能跑，
  // 跨五行的克制队（吴用金 打 木）也要能跑，不然五行改动可能在别的队形上炸。
  const teams: [string, string[]][] = [
    ['三卡·景阳', ['wusong', 'linchong', 'luzhishen']],
    ['三卡·同火', ['wusong', 'qinming', 'likui']],
    ['三卡·金木水', ['wuyong', 'huarong', 'songjiang']],
    ['三卡·土水火', ['luzhishen', 'daizong', 'qinming']],
    ['双卡·武松+林冲', ['wusong', 'linchong']],
    ['双卡·宋江+柴进', ['songjiang', 'chaijin']],
    ['双卡·呼延灼+杨志', ['huyanzhuo', 'yangzhi']],
    ['单卡武松', ['wusong']],
  ];

  const N = 16;
  for (const [label, ids] of teams) {
    const results: RunResult[] = [];
    for (let i = 0; i < N; i++) results.push(runOnce(bundle, bundle.stages[0]!, 1000 + i * 7919, ids));
    summarize(label, results);
  }

  verifyStages(bundle, ['wusong', 'linchong', 'luzhishen']);
  verifyRecipes(bundle);
  verifyLinks(bundle);
  verifyFeverAndEnemy(bundle);
  verifyShots(bundle, ['wusong', 'linchong', 'luzhishen']);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
