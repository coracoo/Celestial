/** Deterministic full-match comparison; measurements, not a claim of human win rate. */
import { readFile, writeFile } from 'node:fs/promises';
import { loadBundle } from '../src/data/GameData.ts';
import type { CharacterDef, StageDef } from '../src/data/schema.ts';
import { initPhysics, Physics } from '../src/core/Physics.ts';
import { PHYSICS } from '../src/core/constants.ts';
import { Rng } from '../src/core/Rng.ts';
import { BattleSim } from '../src/sim/BattleSim.ts';
import { PhysicsBoard } from '../src/sim/PhysicsBoard.ts';
import { expandStage } from '../src/sim/board.ts';
import type { SimCommand } from '../src/sim/types.ts';

const bundle = await loadBundle(async (p) => JSON.parse(await readFile(new URL(`../public/${p}`, import.meta.url), 'utf8')));
const ids = ['wusong', 'linchong', 'luzhishen'];
const squad = ids.map((id) => bundle.characters.find((c) => c.id === id)!);
const baseline = await Promise.all(ids.map(async (id) => JSON.parse(await readFile(
  new URL(`../.repair-backup/2026-10-05/public/data/characters/${id}.json`, import.meta.url), 'utf8')) as CharacterDef));
await initPhysics();

function run(def: StageDef, team: CharacterDef[], seed: number, aim: boolean) {
  const stage = expandStage(def), rng = new Rng(seed), physics = new Physics(stage.gravity);
  const sim = new BattleSim(stage, team, bundle.links);
  let launches = 0, elapsed = 0;
  const apply = (commands: SimCommand[]) => { for (const c of commands) board.apply(c); };
  const board = new PhysicsBoard(physics, stage, {
    canLaunch: () => sim.snapshot().ballsLeft > 0 && sim.snapshot().phase === 'playing',
    onEvent: (event) => { if (event.t === 'launch') launches++; apply(sim.handle(event)); },
  });
  // 首发和救球是两条路：首发只给力度（随机入口），救球才给角度。
  const plunge = () => board.plunge(rng.range(stage.plunger.minPower, stage.plunger.maxPower));
  const rescue = () => board.shoot(rng.range(17, 30), rng.range(42, 138));
  try {
    board.armLauncher(); plunge();
    for (let tick = 0; tick < 120 * 400 && sim.snapshot().phase === 'playing'; tick++) {
      elapsed += PHYSICS.fixedDt;
      if (board.state === 'live') {
        if (tick % 12 === 0 && board.ballY < stage.height - 4) {
          const ready = team.filter((c) => sim.canRelease(c.id));
          const c = ready.length ? rng.pick(ready) : undefined;
          if (c) {
            let angle = 90, hit = true;
            if (aim && c.skill.strike) {
              const options = Array.from({ length: 12 }, (_, i) => sim.previewSkill(c.id, board.ballX, board.ballY, i * 15)!);
              const best = options.sort((a, b) => b.totalDamage - a.totalDamage)[0]!;
              angle = best.angleDeg; hit = best.targets.length > 0;
            }
            if (hit) apply(sim.releaseSkill(c.id, board.ballX, board.ballY, angle));
          }
        }
        // 翻板：球掉到底部就按离它更近的那一块（和 smoke 的 bot 同一套读法）。
        if (board.ballY < 8 && tick % 4 === 0) board.pressFlipper(board.ballX <= 0 ? 'left' : 'right', true);
        else if (tick % 4 === 1) board.pressFlipper('left', false), board.pressFlipper('right', false);
        if (board.isReady && board.canShoot) rescue();
      }
      board.step(PHYSICS.fixedDt); apply(sim.update(PHYSICS.fixedDt));
      if (board.state === 'done' && sim.snapshot().phase === 'playing' && sim.snapshot().ballsLeft > 0) {
        board.armLauncher(); plunge();
      }
    }
    const snapshot = sim.snapshot();
    return { stage: def.id, seed, mode: aim ? 'aimed-prototype' : 'before-prototype', phase: snapshot.phase,
      seconds: +elapsed.toFixed(2), shots: launches, bossHp: snapshot.bossHp,
      bossDamage: def.boss.maxHp - snapshot.bossHp, pegHits: snapshot.pegHits, killed: snapshot.enemy.killed,
      restorations: snapshot.recovery.restorations, weapon: snapshot.weapon };
  } finally { board.dispose(); physics.dispose(); }
}

const rows = bundle.stages.flatMap((stage) => [19, 73, 241].flatMap((seed) => [run(stage, baseline, seed, false), run(stage, squad, seed, true)]));
await writeFile(new URL('../shots/weapon-probe.json', import.meta.url), JSON.stringify(rows, null, 2) + '\n');
for (const stage of bundle.stages) {
  const data = rows.filter((r) => r.stage === stage.id);
  const old = data.filter((r) => r.mode === 'before-prototype'), now = data.filter((r) => r.mode === 'aimed-prototype');
  const mean = (values: number[]) => +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1);
  console.log(`${stage.id} 胜局 ${old.filter((r) => r.phase === 'victory').length}/3 → ${now.filter((r) => r.phase === 'victory').length}/3` +
    `  用球 ${mean(old.map((r) => r.shots))} → ${mean(now.map((r) => r.shots))}` +
    `  武器命中 ${mean(now.map((r) => r.weapon.hits))}  武器击破 ${mean(now.map((r) => r.weapon.kills))}` +
    `  武器击坠Boss伤 ${mean(now.map((r) => r.weapon.bossDamage))}  恢复 ${mean(now.map((r) => r.restorations))}`);
}
if (rows.some((r) => r.phase === 'playing')) throw new Error('Probe exceeded time budget');
