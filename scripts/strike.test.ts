import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadBundle } from '../src/data/GameData.ts';
import type { CharacterDef, PegDef, StrikeSpec } from '../src/data/schema.ts';
import { expandStage } from '../src/sim/board.ts';
import { BattleSim } from '../src/sim/BattleSim.ts';
import { buildStrikePrimitives, pegsInStrike } from '../src/sim/strike.ts';

const bundle = await loadBundle(async (p) => JSON.parse(await readFile(new URL(`../public/${p}`, import.meta.url), 'utf8')));
const stage = expandStage(bundle.stages[0]!);
const base = bundle.characters.find((c) => c.id === 'linchong')!;
const line: StrikeSpec = { shape: 'line', radius: 4, halfWidth: .5, angleDeg: 90, origin: 'ball', kinds: ['enemy'], damage: 100 };
const peg = (id: string, x: number, y: number, hp = 1000): PegDef => ({ id, x, y, r: .5, hp, kind: 'enemy', value: 20, wuxing: 'fire' });
function caster(strike: StrikeSpec = line): CharacterDef {
  return { ...base, wuxing: 'water', skill: { ...base.skill, mods: [], pierce: undefined, strike } };
}
function simFor(pegs: PegDef[], team = [caster()]): BattleSim {
  return new BattleSim({ ...stage, pegs, boss: { ...stage.boss, maxHp: 100000, armor: 0 },
    rules: { ...stage.rules, enemy: { ...stage.rules.enemy, critChance: 0, attrWin: 1.5 } } }, team, []);
}
const ready = (sim: BattleSim, i = 0) => { sim.gauges[i]!.value = sim.gauges[i]!.max; };

test('枪线、刀线与圆圈使用实际圆形靶体；矩形角落不按包围盒误命中', () => {
  const pegs = [peg('vertical', 0, 3), peg('horizontal', 3, 0), peg('edge', 1, 2), peg('corner-out', .9, 4.4)];
  assert.deepEqual(pegsInStrike(line, pegs, 0, 0).map((p) => p.id), ['vertical', 'edge']);
  assert.deepEqual(pegsInStrike({ ...line, angleDeg: 0 }, pegs, 0, 0).map((p) => p.id), ['horizontal']);
  assert.deepEqual(pegsInStrike({ ...line, shape: 'circle', radius: 2.5 }, pegs, 0, 0).map((p) => p.id), ['vertical', 'horizontal', 'edge']);
  assert.deepEqual(pegsInStrike(line, pegs, 0, 0, 0).map((p) => p.id), ['horizontal']);
});

test('双线重叠只返回一次敌人，旋转和平移同时作用于条带', () => {
  const twin = { ...line, repeat: { times: 2, offset: .4 } };
  const primitives = buildStrikePrimitives(twin, 7, 11, 0);
  assert.equal(primitives.length, 2);
  assert.ok(primitives.every((p) => p.shape === 'line' && p.angleDeg === 0 && p.x === 7));
  assert.deepEqual(pegsInStrike(twin, [peg('one', 7, 11)], 7, 11, 0).map((p) => p.id), ['one']);
});

test('技能预览只读；含自身和跨卡 burst/五行，施法者属性独立于队长球属性', () => {
  const character = caster({ ...line, repeat: { times: 2, offset: .4 } });
  character.skill.mods = [{ key: 'burst', value: 1.5, duration: 5 }, { key: 'attrWin', value: 2, duration: 5 }];
  const support = { ...base, id: 'support', wuxing: 'earth' as const, skill: { ...base.skill, strike: undefined,
    pierce: undefined, mods: [{ key: 'burst' as const, value: 1.4, duration: 5 }] } };
  const sim = simFor([peg('target', 0, 2)], [support, character]);
  ready(sim); sim.releaseSkill('support', 0, 0); ready(sim, 1);
  const before = sim.snapshot();
  const preview = sim.previewSkill(character.id, 0, 0)!;
  assert.equal(preview.targets.length, 1);
  assert.equal(preview.totalDamage, 420);
  assert.deepEqual(sim.previewSkill(character.id, 0, 0), preview);
  assert.deepEqual(sim.snapshot(), before, '预览不能扣充能、推进时间或消费伤害');
  const commands = sim.releaseSkill(character.id, 0, 0);
  assert.equal(commands.find((c) => c.t === 'strike')?.preview.totalDamage, 420);
  assert.equal(sim.snapshot().weapon.damage, 420);
  assert.equal(sim.snapshot().weapon.hits, 1);
  assert.equal(sim.snapshot().bossHp, before.bossHp, '未击破不扣Boss');
  ready(sim, 1);
  assert.equal(sim.previewSkill(character.id, 0, 0)!.totalDamage, 420, '重放自身buff为替换而非额外乘一次');
});

test('空目标不伪造伤害；死亡一次奖励；恢复池不再把已击坠的小怪变回新目标', () => {
  const character = caster();
  const sim = simFor([peg('target', 0, 2, 80)], [character]);
  ready(sim);
  const preview = sim.previewSkill(character.id, 0, 0)!;
  assert.equal(preview.totalDamage, 80, '汇总显示扣除的HP，不计溢出');
  assert.equal(preview.totalKills, 1);
  sim.releaseSkill(character.id, 0, 0);
  assert.equal(sim.snapshot().enemy.killed, 1);
  const damage = sim.snapshot().totalDamage;
  /*
   * 击坠不再直接扣 Boss 血（旧版这里是 `killDamage`）。这个夹具只有一枚小怪，
   * 所以打掉它同时也是「全部清空」，触发那笔一次性奖励 —— 数值因此是
   * `fullSweepDamage × 清空倍率(1 + perSweep)`，不再是个和清场无关的常数。
   */
  const fullSweep = stage.rules.enemy;
  assert.equal(
    damage,
    Math.round(fullSweep.fullSweepDamage * (1 + fullSweep.perSweep)),
    '打掉唯一的小怪 = 全清，触发一次性奖励且吃满当档清空倍率',
  );
  ready(sim);
  assert.equal(sim.previewSkill(character.id, 0, 0)!.targets.length, 0);
  sim.releaseSkill(character.id, 0, 0);
  assert.equal(sim.snapshot().totalDamage, damage);
  assert.equal(sim.snapshot().weapon.kills, 1);
  sim.handle({ t: 'launch', power: 20, angleDeg: 90, x: 0, y: 0 });
  /*
   * 旧版这里期望恢复池把击坠的那枚小怪复活，于是它又成了「新目标」。
   * 现在恢复池只修残血、不复活：清场是通关条件，能把已清掉的进度倒回去的
   * 机制和通关条件直接冲突（实测 stage_06/09/12 各撞了小怪 480~600 次仍剩 9~13 枚）。
   */
  for (let i = 0; i < 3; i++) sim.handle({ t: 'recoveryEnter', x: 0, y: 9.2 });
  ready(sim);
  assert.equal(sim.previewSkill(character.id, 0, 0)!.targets.length, 0, '已击坠的小怪不会被复活成新目标');
  assert.equal(sim.previewSkill(character.id, 0, 0)!.totalDamage, 0, '空目标不伪造伤害');
  sim.releaseSkill(character.id, 0, 0);
  assert.equal(sim.snapshot().enemy.killed, 1);
  assert.equal(sim.snapshot().totalDamage, damage);
  assert.equal(sim.snapshot().weapon.kills, 1);
});

test('鲁智深圆击空放不再直接扣Boss，原环境拔钉仍生效', () => {
  const monk = bundle.characters.find((c) => c.id === 'luzhishen')!;
  const sim = simFor([{ ...peg('normal', 0, 2), kind: 'normal', hp: undefined }], [monk]);
  ready(sim);
  const commands = sim.releaseSkill(monk.id, 0, 0);
  assert.equal(sim.snapshot().totalDamage, 0);
  assert.ok(commands.some((c) => c.t === 'destroyPegs' && c.pegIds.includes('normal')));
});

test('原型三人均可用普通碰撞充能，且有同源范围', () => {
  for (const id of ['linchong', 'wusong', 'luzhishen']) {
    const character = bundle.characters.find((c) => c.id === id)!;
    assert.ok(character.skill.strike);
    assert.notEqual(character.skill.trigger.on, 'spearHit');
    const sim = simFor([peg('target', 0, 2)], [character]); ready(sim);
    assert.ok(sim.previewSkill(id, 0, 0)!.primitives.length);
  }
});

test('全部七个武器打击角色都能在预览里真的命中靶点', () => {
  // 卢俊义(棍/circle) 花荣(弓/45°线) 刘唐(刀/横线) 阮小五(短刀/窄线)
  // 加原型三人。断言要的是「预览非空且真的算出了伤害」，
  // 纯看 strike 字段存在的话，形状写错、角度写反、半径给成 0 都能蒙混过去。
  const expected: Record<string, { shape: string; angle?: number }> = {
    lujunyi: { shape: 'circle' },
    huarong: { shape: 'line', angle: 45 },
    liutang: { shape: 'line', angle: 0 },
    ruanxiaowu: { shape: 'line', angle: 0 },
    linchong: { shape: 'line', angle: 90 },
    wusong: { shape: 'line', angle: 0 },
    luzhishen: { shape: 'circle' },
  };
  for (const [id, want] of Object.entries(expected)) {
    const character = bundle.characters.find((c) => c.id === id)!;
    const strike = character.skill.strike!;
    assert.equal(strike.shape, want.shape, `${id} 形状`);
    if (want.angle !== undefined) assert.equal(strike.angleDeg, want.angle, `${id} 角度`);
    assert.ok(strike.radius > 0, `${id} 半径必须为正`);
    assert.ok(strike.damage > 0, `${id} 伤害必须为正`);

    // 靶点沿该角色**实际**的世界角度摆：aimDeg=90 时世界角就是 spec.angleDeg ?? 90。
    // 花荣是 45° 斜线，靶点摆在正上方当然打不中——那正是斜线该有的行为。
    // 距离要跟着武器长度走：阮小五是半长 2.4 的短刀，摆在 3 就刚好够不着
    // （along 3 − 2.4 = 0.6，而靶体半径 0.5，0.36 > 0.25 判未命中）。
    const worldDeg = (strike.angleDeg ?? 90) + 90 - 90;
    const rad = (worldDeg * Math.PI) / 180;
    const d = Math.min(3, strike.radius * 0.6);
    const sim = simFor([peg('target', Math.cos(rad) * d, Math.sin(rad) * d)], [character]); ready(sim);
    const preview = sim.previewSkill(id, 0, 0, 90)!;
    assert.ok(preview, `${id} 预览为空`);
    assert.equal(preview.targets.length, 1, `${id} 没命中沿 ${worldDeg}° 方向的靶点`);
    assert.ok(preview.totalDamage > 0, `${id} 预览伤害为 0`);
  }
});

test('配了 burst 的角色必须有消费它的通道，否则该旋钮永不生效', () => {
  // burst 只被 连锁 / 贯穿 / 摧毁 / 武器打击 消费（BattleSim 里三处 burst 调用点 + strike）。
  // 只配了 burst 而四条通道都没有，技能不报错、buff 条照常显示、战斗毫无变化——
  // 曾经一次性出现 5 个这样的角色，其中一个是 UR。这条断言就是那道护栏。
  // 唯一例外是纯辅助：她的 burst 是留给队友的增益，自身不消费。
  const TEAM_BUFF_ONLY = new Set(['liying']);
  for (const c of bundle.characters) {
    if (!c.skill.mods.some((m) => m.key === 'burst')) continue;
    const channel = c.skill.strike ?? c.skill.pierce ?? c.skill.destroy ?? c.skill.chain;
    assert.ok(
      channel || TEAM_BUFF_ONLY.has(c.id),
      `${c.name}（${c.rarity}）配了 burst 却没有 strike/pierce/destroy/chain，该旋钮永不生效`,
    );
  }
});
