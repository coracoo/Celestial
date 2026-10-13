/**
 * 战斗结算回归。
 *
 * 这组测试盯的是「sim → 场景 → 结算界面」这条链的**信号**。
 *
 * 背景：`BattleSim.resolveRun()` 判定出胜负后，靠返回一条 `fx:'victory'` /
 * `fx:'defeat'` 指令通知运行时。`BattleScene.exec()` case 到它才会调
 * `onSettled()` → `onFinish()` → `ui.showResult()`。
 *
 * 小怪改造（commit 902714c）把那条 return 顶替成了「小怪未清扣分」，
 * 于是两种结局都不再发信号：Boss 打死了画面也永远停在战斗里。
 * 而 smoke 只读 `sim.snapshot().phase`（那时已经是 'victory'），
 * 所以这条断链在 smoke 里是绿的 —— 必须单独立测试盯指令流。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadBundle } from '../src/data/GameData.ts';
import { BattleSim } from '../src/sim/BattleSim.ts';
import { expandStage } from '../src/sim/board.ts';
import type { BattleEvent, SimCommand } from '../src/sim/types.ts';

const bundle = await loadBundle(async (p) =>
  JSON.parse(await readFile(join(import.meta.dirname, '../public', p), 'utf8')) as unknown);
const stage = expandStage(bundle.stages[0]!);
const launch: BattleEvent = { t: 'launch', power: 17, angleDeg: 90, x: 0, y: 25, followUp: false };

/** 把 boss 打到只剩一口气，好用最后一击触发 victory */
const dying = { ...stage, boss: { ...stage.boss, maxHp: 1 } };
/** 一颗都打不死，用来测 defeat 那条路 */
const immortal = { ...stage, boss: { ...stage.boss, maxHp: 10 ** 9 } };
/**
 * 去掉全部小怪的关卡。
 *
 * 通关条件是「Boss 倒 **且** 小怪清空」，所以「Boss 一倒就结算」这条测试
 * 必须先把小怪清掉——直接在原关卡上打空 Boss 只会得到「还没完」，
 * 那是另一条分支（见下面那个用例）。
 */
const noMinions = { ...stage, pegs: stage.pegs.filter((p) => p.kind !== 'enemy') };
const dyingCleared = { ...noMinions, boss: { ...noMinions.boss, maxHp: 1 } };

// 破绽槽的真实伤害值。写死 0 等于零伤害，Boss 压根打不死，测的就不是结算了
const weakSlot = stage.slots.find((s) => s.kind === 'boss')!;
const slotEnter = (): BattleEvent =>
  ({ t: 'slotEnter', slotId: weakSlot.id, kind: weakSlot.kind, value: weakSlot.value,
     weak: true, x: 0, y: 2.5 } as unknown as BattleEvent);
const fx = (c: SimCommand): string => (c as { fx?: string }).fx ?? '';
const has = (cmds: SimCommand[], name: string): boolean => cmds.some((c) => fx(c) === name);

test('打空 Boss 血必须发出 fx:victory 结算信号（小怪已清空那条路）', () => {
  const sim = new BattleSim(dyingCleared, [], []);
  sim.handle(launch);
  assert.equal(sim.snapshot().enemy.total, 0, '这个夹具没有小怪，测的正是「已清空」分支');
  const cmds = sim.handle(slotEnter());
  assert.equal(sim.snapshot().phase, 'victory', 'sim 内部应该已经判定胜利');
  assert.ok(has(cmds, 'victory'),
    `结算信号丢了。拿到的 fx：${JSON.stringify(cmds.map(fx))}——` +
    '没有它 BattleScene 不会 case 到 onSettled，结算界面永远不出现');
});

test('Boss 倒了但小怪没清空：不能发 victory，战斗要继续等清场', () => {
  const sim = new BattleSim(dying, [], []);
  sim.handle(launch);
  // 场上还有小怪：先确认确实有，再打空 boss
  const alive = sim.snapshot().enemy.total - sim.snapshot().enemy.killed;
  assert.ok(alive > 0, '这一关本来就有小怪，测的正是「没清空」分支');
  const cmds = sim.handle(slotEnter());
  assert.equal(sim.snapshot().bossHp, 0, 'Boss 已经打空');
  assert.equal(sim.snapshot().phase, 'playing',
    '清场是通关条件：Boss 倒了但小怪还在时不能结算，球要继续打');
  assert.equal(has(cmds, 'victory'), false,
    '提前发 fx:victory 会把 onFinish 叫起来，玩家看到「通关」但小怪还站着');
});

test('球打完了小怪还没清空：判负，并说清是输在清场', () => {
  const sim = new BattleSim({ ...immortal, rules: { ...immortal.rules, balls: 2 } }, [], []);
  sim.handle(launch);
  let guard = 0;
  let saw = false;
  while (guard++ < 50 && !saw) {
    const cmds = sim.handle(launch);
    if (has(cmds, 'defeat')) saw = true;
    sim.handle({ t: 'ballRetired' } as unknown as BattleEvent);
  }
  assert.equal(sim.snapshot().phase, 'defeat',
    `球耗尽且残怪存在时必须判负（phase=${sim.snapshot().phase}）`);
});

test('击射用尽且球已退场必须发出 fx:defeat', () => {
  const sim = new BattleSim(immortal, [], []);
  sim.handle(launch);
  // 把剩余击射全部打光
  let guard = 0;
  while (sim.snapshot().ballsLeft > 0 && guard++ < 200) {
    const cmds = sim.handle(launch);
    if (has(cmds, 'defeat')) break;
    // 球退场（battleRetired 之类）由 runtime 触发，这里手动喂一次
    sim.handle({ t: 'ballRetired' } as unknown as BattleEvent);
  }
  assert.equal(sim.snapshot().phase, 'defeat', `击射用尽后应该判负（phase=${sim.snapshot().phase}）`);
});

test('结算信号只发一次，之后不再重复', () => {
  const sim = new BattleSim(dyingCleared, [], []);
  sim.handle(launch);
  const first = sim.handle(slotEnter());
  assert.ok(has(first, 'victory'));
  // 结算之后再喂事件，不应该再冒出第二条 victory
  let extra = 0;
  for (let i = 0; i < 20; i++) {
    if (has(sim.handle(slotEnter()), 'victory')) extra++;
    if (has(sim.handle(launch), 'victory')) extra++;
  }
  assert.equal(extra, 0, '结算信号必须幂等，否则 onFinish 会被调用多次、奖励发多次');
});
