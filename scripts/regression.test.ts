import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadBundle } from '../src/data/GameData.ts';
import { BattleSim } from '../src/sim/BattleSim.ts';
import { expandStage } from '../src/sim/board.ts';
import { initPhysics, Physics } from '../src/core/Physics.ts';
import { PHYSICS } from '../src/core/constants.ts';
import { PhysicsBoard } from '../src/sim/PhysicsBoard.ts';
import { Profile } from '../src/game/Profile.ts';
import type { BattleEvent, SimCommand } from '../src/sim/types.ts';

const bundle = await loadBundle(async (p) => JSON.parse(await readFile(join(import.meta.dirname, '../public', p), 'utf8')));
const stage = expandStage(bundle.stages[0]!);
const launch: BattleEvent = { t: 'launch', power: 17, angleDeg: 90, x: 0, y: 25, followUp: false };
const qinming = bundle.characters.find((c) => c.id === 'qinming')!;
const normal = stage.pegs.find((p) => p.kind === 'normal')!;
const hit: BattleEvent = { t: 'pegHit', pegId: normal.id, pegKind: 'normal', intensity: 1, x: normal.x, y: normal.y };

test('预测曲线遇钢钉反弹，移除钢钉后沿原方向继续', async () => {
  const { predictTrajectory } = await import('../src/sim/trajectory.ts');
  const input = { x: -3, y: 0, vx: 10, vy: 0, gravity: 0, radius: 0.33,
    restitution: 0.4, damping: 0, pegs: [{ x: 0, y: 0, r: 0.5 }], walls: [] };
  const bounced = predictTrajectory(input);
  assert.ok(bounced.bounces >= 1);
  assert.ok(bounced.points.at(-1)!.x < -0.8);
  const free = predictTrajectory({ ...input, pegs: [] });
  assert.equal(free.bounces, 0);
  assert.ok(free.points.at(-1)!.x > 3);
});

test('预测曲线会反射倾斜导流板，并使用实际重力', async () => {
  const { predictTrajectory } = await import('../src/sim/trajectory.ts');
  const input = { x: 0, y: 3, vx: 0, vy: -8, gravity: 0, radius: 0.33,
    restitution: 0.4, damping: 0, pegs: [], walls: [{ x: 0, y: 0, w: 2, h: 0.2, rotDeg: 30 }] };
  const reflected = predictTrajectory(input);
  assert.ok(reflected.bounces >= 1);
  assert.ok(Math.abs(reflected.points.at(-1)!.x) > 0.4);
  const light = predictTrajectory({ ...input, walls: [], vy: 0, gravity: -20 });
  const heavy = predictTrajectory({ ...input, walls: [], vy: 0, gravity: -80 });
  assert.ok(heavy.points.at(-1)!.y < light.points.at(-1)!.y);
});

test('恢复池不再复活已击坠的小怪——清场是通关条件，复活会让关卡收不了工', () => {
  const recoveryStage = { ...stage, boss: { ...stage.boss, maxHp: 100000 } };
  const sim = new BattleSim(recoveryStage, [], []);
  const enemy = stage.pegs.find((p) => p.kind === 'enemy')!;
  sim.handle(launch);
  const originalAlive = sim.snapshot().enemy.alive;
  for (let i = 0; i < 12 && sim.snapshot().enemy.alive === originalAlive; i++) {
    sim.handle({ t: 'pegHit', pegId: enemy.id, pegKind: 'enemy', intensity: 1, x: enemy.x, y: enemy.y });
  }
  assert.equal(sim.snapshot().enemy.alive, originalAlive - 1);
  const budget = sim.snapshot().ballsLeft;
  const firstScore = sim.snapshot().score;
  const firstDamage = sim.snapshot().totalDamage;
  const firstKills = sim.snapshot().enemy.killed;
  const enter = { t: 'recoveryEnter', x: 0, y: 9.2 } as unknown as BattleEvent;
  sim.handle(enter);
  sim.handle(enter);
  assert.equal((sim.snapshot() as unknown as { recovery?: { charge: number } }).recovery?.charge, 80);
  const cmds = sim.handle(enter) ?? [];
  assert.equal(cmds.some((c) => (c as { t: string }).t === 'restorePegs'), false,
    '不得发出复活指令：恢复池会把已清掉的进度倒回去，「清空才能收工」变成一句空话');
  assert.equal(sim.snapshot().enemy.alive, originalAlive - 1,
    '已击坠的小怪不能回来。旧版这里会 restorePegs，400 球探针里 stage_06/09/12 各撞了小怪 480~600 次仍剩 9~13 枚');
  assert.equal(sim.snapshot().ballsLeft, budget, '恢复不补发射额度');
  assert.equal(sim.snapshot().score, firstScore, '恢复动作不发击杀奖励');
  assert.equal(sim.snapshot().totalDamage, firstDamage);
  assert.equal(sim.snapshot().enemy.killed, firstKills, '不能重复计一次击杀');
  // 没有可修复的残血目标时，电量保留（不再被一次「什么都没修」的动作扣掉）
  assert.equal((sim.snapshot() as unknown as { recovery: { charge: number } }).recovery.charge, 100);
});

test('恢复池修复「还活着但被打残」的五行靶点，比例由 healRatio 封顶', () => {
  const sim = new BattleSim({ ...stage, boss: { ...stage.boss, maxHp: 100000 } }, [], []);
  sim.handle(launch);
  // 挑一枚血最厚的小怪，一路打到「残血但没死」为止
  const tough = stage.pegs.filter((p) => p.kind === 'enemy').sort((a, b) => (b.hp ?? 0) - (a.hp ?? 0))[0]!;
  const strike = (): number => {
    const c = sim.handle({ t: 'pegHit', pegId: tough.id, pegKind: 'enemy', intensity: 1, x: tough.x, y: tough.y }) ?? [];
    const hp = c.filter((x) => (x as { t: string }).t === 'enemyHp').at(-1) as { ratio?: number } | undefined;
    return hp?.ratio ?? 1;
  };
  let before = 1;
  let guard = 0;
  for (; guard < 40 && before >= 0.6; guard++) before = strike();
  assert.ok(before < 0.6, `这一枚应该被打残（当前 ratio=${before}）`);
  const enter = { t: 'recoveryEnter', x: 0, y: 9.2 } as unknown as BattleEvent;
  /*
   * 修复的证据直接取恢复池自己发出的 `enemyHp` 指令——那是修复**之后**的血量。
   * 不要再补一记打击去对比：一击全额伤害（ratio -0.4 左右）比 healRatio(0.35)
   * 还大，「打完 ratio 不降」这种写法会把正常平衡误判成回归。
   */
  let repaired = before;
  for (let i = 0; i < 3; i++) {
    const hp = (sim.handle(enter) ?? [])
      .filter((x) => (x as { t: string }).t === 'enemyHp' && (x as { pegId: string }).pegId === tough.id)
      .at(-1) as { ratio?: number } | undefined;
    if (hp?.ratio !== undefined) repaired = hp.ratio;
  }
  assert.ok(repaired > before, `残血被修复（${before} -> ${repaired}）`);
  assert.ok(repaired < 1, `healRatio 封顶，不会拉满（当前 ${repaired}）——磨血仍然比硬打慢，取舍还在`);
});

test('恢复池没有损毁目标时保留满池，不重复触发演出', () => {
  const sim = new BattleSim(stage, [], []);
  sim.handle(launch);
  const cmds: SimCommand[] = [];
  for (let i = 0; i < 5; i++) cmds.push(...(sim.handle({ t: 'recoveryEnter', x: 0, y: 9.2 } as unknown as BattleEvent) ?? []));
  assert.equal((sim.snapshot() as unknown as { recovery?: { charge: number } }).recovery?.charge, 100);
  assert.equal(cmds.some((c) => (c as { t: string }).t === 'restorePegs'), false);
});

test('恢复五行碰撞体幂等，重新可碰撞且保持满血', async () => {
  await initPhysics();
  const physics = new Physics(stage.gravity);
  const board = new PhysicsBoard(physics, stage);
  try {
    const enemy = board.pegs.find((p) => p.kind === 'enemy')!;
    const count = physics.world.colliders.len();
    board.apply({ t: 'destroyPegs', pegIds: [enemy.id], reason: 'enemy' });
    assert.equal(enemy.alive, false);
    const restore = { t: 'restorePegs', pegIds: [enemy.id] } as unknown as SimCommand;
    board.apply(restore);
    assert.equal(enemy.alive, true);
    assert.equal(enemy.hp, enemy.maxHp);
    assert.equal(enemy.collider.isEnabled(), true);
    assert.equal(physics.world.colliders.len(), count);
    board.apply(restore);
    assert.equal(physics.world.colliders.len(), count);
  } finally { board.dispose(); physics.dispose(); }
});

test('技能从未满变为满时只发出一次就绪反馈', () => {
  const sim = new BattleSim(stage, [qinming], []);
  sim.handle(launch);
  const commands: SimCommand[] = [];
  for (let i = 0; i < 12; i++) commands.push(...sim.handle(hit));
  assert.equal(sim.canRelease('qinming'), true);
  assert.equal(commands.filter((c) => c.t === 'fx' && c.fx === 'gaugeFull').length, 1);
});

test('连锁移除敌人后不会再次从已消失的敌人结算伤害', () => {
  const enemy = stage.pegs.find((p) => p.kind === 'enemy')!;
  const source = { ...normal, id: 'source', x: 0, y: 14 };
  const chainStage = {
    ...stage,
    pegs: [source, ...(['metal', 'fire', 'water'] as const).map((wuxing, i) => ({
      ...enemy, id: `target${i}`, x: 0.8 + i * 0.7, y: 14, wuxing,
    }))],
  };
  const sim = new BattleSim(chainStage, [qinming], []);
  const event: BattleEvent = { t: 'pegHit', pegId: 'source', pegKind: 'normal', intensity: 1, x: 0, y: 14 };
  sim.handle(launch);
  for (let i = 0; i < 7; i++) sim.handle(event);
  sim.releaseSkill('qinming', 0, 14);
  const first = sim.handle(event);
  assert.equal(first.filter((c) => c.t === 'destroyPegs').flatMap((c) => c.pegIds).length, 3);
  assert.equal(sim.snapshot().enemy.alive, 0);
  const hp = sim.snapshot().bossHp;
  const second = sim.handle(event);
  assert.equal(second.filter((c) => c.t === 'destroyPegs').length, 0);
  assert.equal(sim.snapshot().bossHp, hp);
});

test('万金槽奖励带到下一颗球，随后消耗掉', () => {
  const sim = new BattleSim(stage, [], []);
  const gold = stage.slots.find((s) => s.kind === 'multiplier')!;
  const coin = stage.slots.find((s) => s.kind === 'normal')!;
  const enter = (s: typeof coin) => sim.handle({
    t: 'slotEnter', slotId: s.id, kind: s.kind, value: 70, weak: false, x: s.x, y: s.y,
  });
  sim.handle(launch);
  enter(gold);
  sim.handle({ t: 'ballRetired', x: gold.x, y: gold.y });
  sim.handle(launch);
  enter(coin);
  assert.equal(sim.snapshot().lastDamage, 175);
  sim.handle({ t: 'ballRetired', x: coin.x, y: coin.y });
  sim.handle(launch);
  enter(coin);
  assert.equal(sim.snapshot().lastDamage, 70);
});

test('模拟层拒绝耗尽预算后的击射事件', () => {
  const sim = new BattleSim({ ...stage, rules: { ...stage.rules, balls: 1 } }, [], []);
  sim.handle(launch);
  const commands = sim.handle({ ...launch, followUp: true });
  assert.equal(commands.some((c) => c.t === 'sound' && c.name === 'deny'), true);
  assert.equal(sim.snapshot().ballsLeft, 0);
});

test('击射预算耗尽后物理层不会改变球速或再次发射', async () => {
  await initPhysics();
  const physics = new Physics();
  const sim = new BattleSim({ ...stage, rules: { ...stage.rules, balls: 1 } }, [], []);
  let launches = 0;
  let board: PhysicsBoard;
  board = new PhysicsBoard(physics, stage, {
    canLaunch: () => sim.snapshot().ballsLeft > 0 && sim.snapshot().phase === 'playing',
    onEvent: (ev) => {
      if (ev.t === 'launch') launches++;
      for (const c of sim.handle(ev)) board.apply(c);
    },
  });
  try {
    board.armLauncher();
    board.plunge(17);
    for (let i = 0; i < 49; i++) board.step(PHYSICS.fixedDt);
    assert.equal(sim.snapshot().ballsLeft, 0);
    board.shoot(30, 90);
    assert.equal(launches, 1);
  } finally {
    board.dispose();
    physics.dispose();
  }
});

test('救球只在金环窗口开始，已按下的机会可保留至松手且仍受预算限制', async () => {
  await initPhysics();
  const physics = new Physics(0);
  /*
   * 这个夹具只关心「金环窗口」，所以球道要短到球几帧内就爬出交汇处。
   * `innerTopY` 必须跟着 `bendY` 一起给 —— 道内阻尼的判据读这两个值，
   * 夹具只改一个会让球一直享受道内低阻尼、永远慢不下来。
   *
   * 零重力是刻意的：只有零重力下球才能靠阻尼一路滑停到 `readySpeed` 以下，
   * 有重力时阻尼 4 配重力 −74 会形成 ~18bu/s 的终端速度，球永远不会慢下来。
   * 「无净下降」看门狗在零重力盘面上不启用（见 `PhysicsBoard.antiStuck`）。
   */
  const open = { ...stage, width: 40, height: 60, gravity: 0, pegs: [], zones: [], walls: [],
    plunger: { ...stage.plunger, restY: 25, bendY: 30, innerTopY: 27, minPower: 20, maxPower: 26 },
  };
  let launches = 0;
  let allowed = true;
  const board = new PhysicsBoard(physics, open, {
    canLaunch: () => allowed,
    onEvent: (ev) => { if (ev.t === 'launch') launches++; },
  });
  try {
    board.armLauncher();
    assert.equal(board.beginCharge(), true);
    board.plunge(24);
    for (let i = 0; i < 50; i++) board.step(PHYSICS.fixedDt);
    assert.equal(board.state, 'live');
    assert.equal(board.isReady, false);
    assert.equal(board.canShoot, false);
    assert.equal(board.beginCharge(), false);
    board.shoot(30, 90);
    assert.equal(launches, 1, '冷却结束后高速球仍不允许免费救球');
    board.apply({ t: 'setDampingScale', channel: 'test', scale: 30, duration: 5 });
    for (let i = 0; i < 100 && !board.isReady; i++) board.step(PHYSICS.fixedDt);
    assert.equal(board.isReady, true);
    assert.equal(board.beginCharge(), true);
    const timeBefore = board.secondsLeft;
    board.apply({ t: 'setDampingScale', channel: 'test', scale: 1, duration: 0 });
    board.apply({ t: 'boostBall', dirX: 1, dirY: -1, impulse: 5 });
    board.step(PHYSICS.fixedDt);
    assert.ok(board.ballSpeed > PHYSICS.readyRelease);
    assert.equal(board.rescueHeld, true);
    assert.equal(board.canShoot, true, '金环窗口在蓄力时保留');
    board.shoot(24, 90);
    assert.equal(launches, 2);
    assert.equal(board.rescueHeld, false);
    assert.ok(board.secondsLeft < timeBefore, '救球不会重置本球倒计时');
    board.apply({ t: 'setDampingScale', channel: 'test', scale: 30, duration: 5 });
    for (let i = 0; i < 120 && !board.isReady; i++) board.step(PHYSICS.fixedDt);
    assert.equal(board.beginCharge(), true);
    allowed = false;
    assert.equal(board.canShoot, false);
    board.shoot(24, 90);
    assert.equal(launches, 2, '即使已保留金环窗口也不能绕过击射预算');
    board.cancelCharge();
    assert.equal(board.rescueHeld, false);
  } finally {
    board.dispose();
    physics.dispose();
  }
});

test('物理读取关卡重力，技能倍率乘在该重力上', async () => {
  await initPhysics();
  const physics = new Physics(-33);
  try {
    const { body } = physics.createBall(0, 20);
    physics.step();
    assert.equal(physics.world.gravity.y, -33);
    assert.ok(body.linvel().y < 0);
    physics.gravityScale = 0.78;
    physics.step();
    assert.ok(Math.abs(physics.world.gravity.y - -33 * 0.78) < 1e-8);
  } finally { physics.dispose(); }
});

test('HUD 显示实际封顶倍率和待用下一球增益', () => {
  const sim = new BattleSim(stage, [], []);
  sim.handle(launch);
  const gold = stage.pegs.find((p) => p.kind === 'golden')!;
  for (let i = 0; i < 12; i++) sim.handle({ t: 'pegHit', pegId: gold.id, pegKind: 'golden', intensity: 1, x: gold.x, y: gold.y });
  assert.equal(sim.snapshot().slotMultiplier, 4.2);
  assert.equal(sim.snapshot().weakSlotMultiplier, 4.2);
  const slot = stage.slots.find((s) => s.kind === 'multiplier')!;
  sim.handle({ t: 'slotEnter', slotId: slot.id, kind: slot.kind, value: 70, weak: false, x: slot.x, y: slot.y });
  assert.equal(sim.snapshot().lastDamage, Math.round(70 * sim.snapshot().slotMultiplier));
  assert.equal(sim.snapshot().pendingNextMultiplier, 2.5);
  sim.handle({ t: 'ballRetired', x: slot.x, y: slot.y });
  sim.handle(launch);
  assert.equal(sim.snapshot().pendingNextMultiplier, 1);
  assert.ok(sim.snapshot().slotMultiplier >= 2.5);
});

test('教程缩短技能蓄力门槛，后续关卡保留原配方', () => {
  const trio = ['wusong', 'linchong', 'luzhishen'].map((id) => bundle.characters.find((c) => c.id === id)!);
  const tutorial = new BattleSim(stage, trio, []);
  const later = new BattleSim(expandStage(bundle.stages[1]!), trio, []);
  for (const c of trio) {
    assert.equal(tutorial.gauges.find((g) => g.charId === c.id)!.max, Math.ceil(c.skill.trigger.charges * 0.4));
    assert.equal(later.gauges.find((g) => g.charId === c.id)!.max, c.skill.trigger.charges);
  }
});

test('武松浮球重力减缓，吴用技能提高逆势输出', () => {
  const wusong = bundle.characters.find((c) => c.id === 'wusong')!;
  const ws = new BattleSim(stage, [wusong], []);
  ws.gauges[0]!.value = ws.gauges[0]!.max;
  const cast = ws.releaseSkill(wusong.id, 0, 20);
  assert.ok(cast.some((c) => c.t === 'setGravityScale' && c.scale > 0 && c.scale < 1));
  const wuyong = bundle.characters.find((c) => c.id === 'wuyong')!;
  const target = { ...stage.pegs.find((p) => p.kind === 'enemy' && p.wuxing === 'fire')!, hp: 10000 };
  const probe = { ...stage, boss: { ...stage.boss, maxHp: 100000 }, pegs: [target],
    rules: { ...stage.rules, enemy: { ...stage.rules.enemy, critChance: 0 } },
  };
  const bare = new BattleSim(probe, [wuyong], []);
  const buffed = new BattleSim(probe, [wuyong], []);
  buffed.gauges[0]!.value = buffed.gauges[0]!.max;
  buffed.releaseSkill(wuyong.id, 0, 20);
  const event: BattleEvent = { t: 'pegHit', pegId: target.id, pegKind: 'enemy', intensity: 1, x: target.x, y: target.y };
  const damage = (sim: BattleSim): number => {
    const fx = sim.handle(event).find((c) => c.t === 'fx' && c.fx === 'enemyHit');
    return fx && fx.t === 'fx' ? fx.value ?? 0 : 0;
  };
  const before = damage(bare), after = damage(buffed);
  assert.ok(after > before);
  assert.ok(after / before > 1.35, `逆势伤害 ${before}→${after} 应提升`);
});

test('球在完全无法下降的局面里，看门狗不会反复补横向冲量给球泵能量', async () => {
  await initPhysics();
  /*
   * 病根：看门狗 2（无净下降 0.8s 补一记 ±8 横向冲量）对一颗**挤不出去**的球
   * 无上限注入能量。球被横向加速后撞进钉阵被反射成上抛，越推越高
   * （实测 stage_02 盘上球速从 27 涨到 147bu/s），最后只能等 `ballSeconds` 判超时。
   * 修法：推满 `PHYSICS.descentPushLimit` 次仍不见下降就改走 `escapeTrap()`
   * ——移除约束（虚化身边钉板 + 给确定的向下初速），而不是再补一记横向冲量。
   *
   * 夹具用**封死的盒子**而不是真实关卡：四条水平/竖直板把球关在 12×3bu 的空腔里，
   * 清空钉阵与导流板。这样「球永远拿不到净下降」是几何保证的，不依赖轨迹运气——
   * 早先一版用真实 stage_02 的落点断言「5 秒内落槽」，结果会随 WASM 世界
   * 分配历史飘（同一个落点单独跑落槽、跟在别的球后面跑就落不进去），不能当回归。
   *
   * 反向对照：同样这个夹具，旧代码在沉降后的 4.5 秒里会补 5 次横向冲量
   * （0.8 秒一次），修复后 ≤ `PHYSICS.descentPushLimit` 次。这条断言是有分辨力的。
   */
  const def = bundle.stages.find((s) => s.id === 'stage_02')!;
  const boxed = expandStage({
    ...def,
    board: {
      ...def.board,
      pegRows: [],
      pegFormations: [],
      deflectors: [
        { id: 'box_top', x: 0, y: 15, w: 16, h: 0.2, rotDeg: 0, role: 'deflector' },
        { id: 'box_bot', x: 0, y: 12, w: 16, h: 0.2, rotDeg: 0, role: 'deflector' },
        { id: 'box_l', x: -6, y: 13.5, w: 3.2, h: 0.2, rotDeg: 90, role: 'deflector' },
        { id: 'box_r', x: 6, y: 13.5, w: 3.2, h: 0.2, rotDeg: 90, role: 'deflector' },
      ],
    },
    rules: { ...def.rules, ballSeconds: 999 },
  } as typeof def);
  assert.equal(boxed.pegs.length, 0, '夹具必须没有钉阵，否则球会被钉子弹出去');

  const physics = new Physics(boxed.gravity);
  try {
    const sim = new BattleSim(boxed, [], bundle.links);
    let board: PhysicsBoard;
    let measuring = false;
    let settleY = 0;
    let deepest = 0;
    let lateral = 0;
    board = new PhysicsBoard(physics, boxed, {
      canLaunch: () => true,
      onEvent: (ev) => {
        for (const c of sim.handle(ev)) board.apply(c);
      },
    });
    board.armLauncher();
    board.placeBall(0, 13.2, 6, -6);
    board.step(PHYSICS.fixedDt);
    // body 在首次 step() 时才创建，冲量探针要等球真的动起来再套
    const spy = board as unknown as {
      body: { applyImpulse: (i: { x: number; y: number }, wake: boolean) => void };
    };
    const raw = spy.body.applyImpulse.bind(spy.body);
    spy.body.applyImpulse = (imp, wake) => {
      // 开头那一下沉降本来就会刷新 bestY、把升级计数清零，算进来会掩盖后面的行为
      if (measuring && Math.abs(imp.x) >= 8) lateral++;
      raw(imp, wake);
    };
    for (let i = 0; i < Math.round(6 / PHYSICS.fixedDt); i++) {
      for (const c of sim.update(PHYSICS.fixedDt)) board.apply(c);
      board.step(PHYSICS.fixedDt);
      if (!measuring && i * PHYSICS.fixedDt > 1.5) {
        measuring = true;
        settleY = board.ballY;
        deepest = board.ballY;
      }
      if (measuring) deepest = Math.min(deepest, board.ballY);
    }
    // 先确认夹具真的成立：球必须真的下不去，否则这条断言就没有意义
    assert.ok(settleY - deepest < 0.5, `夹具失效：球在盒子里下降了 ${(settleY - deepest).toFixed(2)}bu`);
    assert.ok(
      lateral <= PHYSICS.descentPushLimit,
      `沉降后 4.5 秒里补了 ${lateral} 次横向冲量（上限 ${PHYSICS.descentPushLimit}）——看门狗在给球泵能量`,
    );
    board.dispose();
  } finally {
    physics.dispose();
  }
});

test('新存档仅有三张起手卡，旧收藏和自选队伍不会被重置', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const records = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => records.set(key, value),
  } });
  const starter = ['wusong', 'linchong', 'luzhishen'];
  try {
    const fresh = new Profile(starter);
    assert.deepEqual(fresh.team, starter);
    assert.deepEqual(fresh.ownedList(), starter);
    const owned = Object.fromEntries(bundle.characters.map((c) => [c.id, c.id === 'wuyong' ? 3 : 1]));
    const saved = { owned, team: ['songjiang', 'wuyong', 'linchong'], clears: 0, pulls: 0,
      stones: 431, silver: 81, shards: 9, currentStage: 'stage_01', clearedStages: [] };
    records.set('celestial.save.v3', JSON.stringify(saved));
    const migrated = new Profile(starter);
    assert.deepEqual(migrated.team, starter);
    assert.equal(migrated.ownedCount('wuyong'), 3);
    assert.equal(migrated.ownedList().length, bundle.characters.length);
    assert.equal(migrated.stones, 431);
    assert.equal(migrated.silver, 81);
    assert.equal(migrated.shards, 9);
    records.set('celestial.save.v3', JSON.stringify({ ...saved, team: ['qinming', 'likui', 'wusong'] }));
    const custom = new Profile(starter);
    assert.deepEqual(custom.team, ['qinming', 'likui', 'wusong']);
    records.set('celestial.save.v3', JSON.stringify({ ...saved, pulls: 1 }));
    assert.deepEqual(new Profile(starter).team, saved.team);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
