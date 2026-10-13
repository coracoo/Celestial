import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadBundle } from '../src/data/GameData.ts';
import type { Wuxing } from '../src/data/schema.ts';
import { BattleSim } from '../src/sim/BattleSim.ts';
import { expandStage } from '../src/sim/board.ts';

const bundle = await loadBundle(async (p) => JSON.parse(await readFile(join(import.meta.dirname, '../public', p), 'utf8')));
const source = expandStage(bundle.stages[0]!);

// A 100 HP hit before affinity/critical scaling, with no bounce growth or kills.
// Real recipes and public events exercise the multiplier consumers, not private mod().
function fixture(ids: string[], wuxing: Wuxing = 'fire', critChance = 0): BattleSim {
  const stage = {
    ...source,
    boss: { ...source.boss, maxHp: 100000, armor: 0, phases: [] },
    pegs: [{ id: 'target', x: 0, y: 15, r: 0.55, kind: 'enemy' as const, hp: 100000, value: 2, wuxing }],
    rules: { ...source.rules, enemy: { ...source.rules.enemy, baseDamage: 100, perBounce: 0, critChance, critMult: 2.2, attrLose: 0.7 } },
  };
  const sim = new BattleSim(stage, ids.map((id) => bundle.characters.find((c) => c.id === id)!), []);
  sim.handle({ t: 'launch', power: 17, angleDeg: 90, x: 0, y: 25 });
  for (let i = 0; i < 20; i++) sim.handle({ t: 'zoneEnter', zoneId: 'charge', kind: 'skill', x: 0, y: 25 });
  return sim;
}

function hitDamage(sim: BattleSim): number {
  const result = sim.handle({ t: 'pegHit', pegId: 'target', pegKind: 'enemy', intensity: 0.5, x: 0, y: 15 });
  const damage = result.find((c) => c.t === 'fx' && (c.fx === 'enemyHit' || c.fx === 'crit'));
  assert.ok(damage?.t === 'fx' && typeof damage.value === 'number');
  return damage.value;
}

function release(sim: BattleSim, id: string): void {
  assert.equal(sim.canRelease(id), true, `${id} charged through skill-zone events`);
  sim.releaseSkill(id, 0, 15);
}

test('李应消除逆势惩罚：默认70伤害，开技100，到期回70', () => {
  const sim = fixture(['liying']);
  assert.equal(hitDamage(sim), 70);
  release(sim, 'liying');
  assert.equal(hitDamage(sim), 100, 'attrLose=1 replaces the default 0.7 rather than multiplying it');
  sim.update(6.01);
  assert.equal(hitDamage(sim), 70);
});

test('会心倍率是绝对值：阮小五从默认220伤害改为120而非264', () => {
  const sim = fixture(['ruanxiaowu'], 'fire', 0.95);
  assert.equal(hitDamage(sim), 220);
  release(sim, 'ruanxiaowu');
  assert.equal(hitDamage(sim), 120);
  sim.update(3.01);
  assert.equal(hitDamage(sim), 220);
});

test('跨卡同key叠乘：阮小五与花荣会心伤害150，短增益到期后只剩125', () => {
  const sim = fixture(['ruanxiaowu', 'huarong'], 'fire', 0.95);
  release(sim, 'ruanxiaowu');
  release(sim, 'huarong');
  assert.equal(hitDamage(sim), 150, '100 × 1.2 × 1.25, excluding the fallback 2.2');
  // 阮小五 3 秒到期、花荣 5 秒还在：不是回到默认 2.2，而是只剩 ×1.25。
  sim.update(3.01);
  assert.equal(hitDamage(sim), 125);
  sim.update(2.01);
  assert.equal(hitDamage(sim), 220, '两张都到期后才回到默认会心倍率 2.2');
});

test('会心率增量跨卡相加：单张 +14%/+16% 都不够，两张合计才触发', () => {
  // 队长必须恒为阮小五（火）：target 的五行跟着 fixture 的 wuxing 参数走，
  // 一旦单测里让花荣（木）当队长，木生火会先乘进 1.2，damage 里就混进了属性倍率，
  // 验的就不是会心加算了。
  const firstRoll = 0.892883;

  const a = fixture(['ruanxiaowu'], 'fire', 0.70);
  release(a, 'ruanxiaowu');
  assert.ok(0.70 + 0.14 < firstRoll, '阮小五单张 0.84 应低于首摇');
  assert.equal(hitDamage(a), 100, '阮小五单张 +14% 不足以触发');

  const b = fixture(['ruanxiaowu', 'huarong'], 'fire', 0.70);
  release(b, 'huarong');
  assert.ok(0.70 + 0.16 < firstRoll, '花荣单张 0.86 应低于首摇');
  assert.equal(hitDamage(b), 100, '花荣单张 +16% 不足以触发');

  const both = fixture(['ruanxiaowu', 'huarong'], 'fire', 0.70);
  release(both, 'ruanxiaowu');
  release(both, 'huarong');
  assert.equal(hitDamage(both), 150, '两张合计 0.95（被封顶）才触发，100 × 1.2 × 1.25');
});

test('卢俊义的共享burst由关胜消费：原始即时伤害180变252', () => {
  const plain = fixture(['guansheng']);
  release(plain, 'guansheng');
  assert.equal(plain.snapshot().score, 180);
  assert.equal(plain.snapshot().totalDamage, 180);

  const shared = fixture(['lujunyi', 'guansheng']);
  release(shared, 'lujunyi');
  assert.equal(shared.snapshot().totalDamage, 0, 'support skill alone does not create an instant hit');
  release(shared, 'guansheng');
  assert.equal(shared.snapshot().score, 252, '180 × 1.4 burst is shared across cards');
  assert.equal(shared.snapshot().totalDamage, 353, 'Boss vulnerability is a separate 1.4 multiplier');
});
