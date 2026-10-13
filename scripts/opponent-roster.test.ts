import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { ENEMY_CARD_LIST, ENEMIES_BY_ELEMENT, enemyCardFor } from '../src/data/EnemyCards.ts';
import { BOSS_CARD_LIST, bossCardFor } from '../src/data/BossCards.ts';
import { loadBundle } from '../src/data/GameData.ts';
import { expandStage } from '../src/sim/board.ts';
import { initPhysics, Physics } from '../src/core/Physics.ts';
import { PhysicsBoard } from '../src/sim/PhysicsBoard.ts';

const bundle = await loadBundle(async (p) => JSON.parse(await readFile(new URL(`../public/${p}`,import.meta.url),'utf8')));

test('30 unique opponents, six per element, twelve matched bosses; all separate from heroes', () => {
  assert.equal(ENEMY_CARD_LIST.length, 30);
  assert.equal(new Set(ENEMY_CARD_LIST.map((d) => d.id)).size, 30);
  for (const group of Object.values(ENEMIES_BY_ELEMENT)) assert.equal(group.length, 6);
  assert.ok(ENEMY_CARD_LIST.every((d) => !bundle.characters.some((c) => c.id === d.id)));
  assert.equal(BOSS_CARD_LIST.length, 12);
  for (const stage of bundle.stages) {
    assert.equal(bossCardFor(stage.boss.id)?.name, stage.boss.name);
    assert.equal(bossCardFor(stage.boss.id)?.stageId, stage.id);
  }
});

test('every enemy identity is reachable in stable stage expansion without changing physical targets', () => {
  const reachable = new Set<string>();
  /*
   * 每关的小怪枚数是**落点算法的产物**，不是手写常量：
   * `placeEnemies()` 按实际可放位置挑落点，窄盘（stage_07 盘宽只有 12）就少几枚。
   * 满清倍率由 `perSweep = (SWEEP_MAX - 1) / 实际枚数` 反推，所以枚数变化
   * 不会改难度——正因如此这里可以把它写成固定数组当成回归快照，
   * 枚数一变就说明落点算法动了，那是需要主动审的改动。
   *
   * 2026-10：落点从写死的 `ENEMY_SLOTS` 换成「按真实占位自由挑」，排除了
   * 盘顶无结构区与球进不去的袋位，于是 stage_02 12→9、stage_09 16→15、
   * stage_11 13→12。掉的都是洪泛判「通」但实际很难打到的位置；
   * 跨关难度曲线没动（smoke 的用球率 50%、理论最少球仍单调递增）。
   */
  const expected = [5,9,12,13,13,14,7,15,15,16,12,14];
  bundle.stages.forEach((definition, i) => {
    const a = expandStage(definition), b = expandStage(definition);
    assert.deepEqual(a.pegs, b.pegs);
    const enemies = a.pegs.filter((p) => p.kind === 'enemy');
    assert.equal(enemies.length, expected[i]);
    for (const p of enemies) {
      assert.ok(p.enemyId);
      const art = enemyCardFor(p.wuxing, p.enemyId);
      assert.equal(art.wuxing, p.wuxing);
      assert.equal(art.id, p.enemyId);
      reachable.add(art.id);
    }
  });
  assert.equal(reachable.size, 30);
});

test('restoration keeps assigned enemy identity, coordinates and radius', async () => {
  await initPhysics();
  const stage = expandStage(bundle.stages[1]!);
  const physics = new Physics(stage.gravity);
  const board = new PhysicsBoard(physics, stage);
  try {
    const target = board.pegs.find((p) => p.kind === 'enemy')!;
    const before = { enemyId: target.enemyId, x: target.x, y: target.y, r: target.r };
    assert.ok(before.enemyId);
    board.apply({ t:'destroyPegs', pegIds:[target.id], reason:'test' });
    board.apply({ t:'restorePegs', pegIds:[target.id] });
    assert.deepEqual({ enemyId: target.enemyId, x: target.x, y: target.y, r: target.r }, before);
    assert.equal(target.alive,true);
  } finally { board.dispose(); physics.dispose(); }
});
