/**
 * 布局探针：`node --experimental-strip-types scripts/probe.ts [stageId ...]`
 *
 * 跑**纯物理**，不建 BattleSim、不算伤害：只把球从发射器打出去，量三件事——
 *
 *   1. 落槽率：球到底能不能落到五个槽里去
 *   2. 通过时长：球从发射到结算花多久（超时上限 ballMaxAge = 7s）
 *   3. 卡死热区：哪几个坐标反复把球挂住
 *
 * 为什么单独写一个而不直接看 smoke：
 * smoke 一关要跑 12 局完整战斗（含技能/连携/会心/Boss 阶段），一分钟出结果，
 * 而且胜负受数值影响——**分不清「盘面把人卡住了」和「这一关数值太难」**。
 * 调钉阵布局时这两个必须拆开看：探针只看盘面，跑一次只要几秒。
 *
 * 判据（写在 verify 里）：
 *   落槽率 ≥ 92%      —— 否则玩家会看到大量「球从盘边掉出去」
 *   P90 时长 ≤ 4.2s   —— 7 秒是硬上限，逼近它就意味着玩家在干等
 *   单一热点 ≤ 4 次   —— 反复卡同一点 = 阵型死角，几何审计看不出、这里看得出
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PHYSICS } from '../src/core/constants.ts';
import { initPhysics, Physics } from '../src/core/Physics.ts';
import { loadBundle, type ReadJson } from '../src/data/GameData.ts';
import { Rng } from '../src/core/Rng.ts';
import { expandStage } from '../src/sim/board.ts';
import { PhysicsBoard } from '../src/sim/PhysicsBoard.ts';

const ROOT = join(import.meta.dirname, '..', 'public');
const nodeReader: ReadJson = async (p) =>
  JSON.parse(await readFile(join(ROOT, p), 'utf8')) as unknown;

const SHOTS = 60;

interface Probe {
  slot: number;
  out: number;
  timeout: number;
  times: number[];
  hot: Map<string, number>;
  /** 每 4 个世界单位一条高度带，累计球在里面待的秒数 */
  bandTime: number[];
}

async function probe(bundle: Awaited<ReturnType<typeof loadBundle>>, idx: number): Promise<Probe> {
  const def = bundle.stages[idx]!;
  const stage = expandStage(def);
  const L = stage.plunger;
  const res: Probe = {
    slot: 0,
    out: 0,
    timeout: 0,
    times: [],
    hot: new Map(),
    bandTime: new Array(Math.ceil(stage.height / 4) + 1).fill(0),
  };
  const rng = new Rng(4242 + idx * 131);

  for (let i = 0; i < SHOTS; i++) {
    const physics = new Physics();
    const board = new PhysicsBoard(physics, stage);
    // 首发只有力度，没有角度：落点由导流板和出口随机偏角决定。
    const power = L.minPower + (L.maxPower - L.minPower) * (0.25 + rng.next() * 0.75);
    // armLauncher 才会把球放回道底；不调它 plunge() 直接静默返回，
    // 球压根没出去，探针就会一路报「落槽 0% 中位 0.00s」。
    board.armLauncher();
    board.plunge(power);

    let t = 0;
    const dt = PHYSICS.fixedDt;
    let nextSample = 0.3;
    while (board.state === 'live' && t < PHYSICS.ballMaxAge + 0.5) {
      board.step(dt);
      t += dt;
      const b = Math.max(0, Math.min(res.bandTime.length - 1, Math.floor(board.ballY / 4)));
      res.bandTime[b] = (res.bandTime[b] ?? 0) + dt;
      // 每 0.3s 记一次位置：球长时间待在同一个 1 单位格 = 卡在那儿出不来。
      // 坐标取整到 1 位，够粗（同一处死角）又够细（不会把整条走廊算成一格）。
      if (t >= nextSample) {
        nextSample += 0.3;
        const k = `${board.ballX.toFixed(0)},${board.ballY.toFixed(0)}`;
        res.hot.set(k, (res.hot.get(k) ?? 0) + 1);
      }
    }
    res.slot += board.endReason.slot;
    res.out += board.endReason.out;
    res.timeout += board.endReason.timeout;
    res.times.push(Math.min(t, PHYSICS.ballMaxAge + 0.5));
  }
  return res;
}

async function main(): Promise<void> {
  await initPhysics();
  const bundle = await loadBundle(nodeReader);
  const only = process.argv.slice(2);
  const list = only.length
    ? bundle.stages.map((s, i) => ({ s, i })).filter(({ s }) => only.includes(s.id))
    : bundle.stages.map((s, i) => ({ s, i }));

  console.log(`布局探针：每关 ${SHOTS} 球，纯物理，超时上限 ${PHYSICS.ballMaxAge}s`);
  console.log('判据锚在 stage_01（已上线、实机可玩）这条基线上：落槽 ≥ 88%、超时 ≤ 9%');
  console.log('「滞留带」= 球累计耗时最多的高度带，y=0~4 是落槽区，正常应该最高。\n');

  let fail = 0;
  for (const { s, i } of list) {
    const stage = expandStage(s);
    const p = await probe(bundle, i);
    const times = [...p.times].sort((a, b) => a - b);
    const med = times[Math.floor(times.length / 2)]!;
    const p90 = times[Math.floor(times.length * 0.9)]!;
    const hot = [...p.hot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const landRate = (p.slot / SHOTS) * 100;
    const toRate = (p.timeout / SHOTS) * 100;
    // 滞留带：耗时最多的那一条（排除落槽区 0）
    const stalls = p.bandTime
      .map((v, band) => [band, v] as [number, number])
      .filter(([band]) => band >= 1)
      .sort((a, b) => b[1] - a[1])[0];
    const bad = landRate < 88 || toRate > 9;
    if (bad) fail++;
    console.log(
      `${bad ? '✗' : '✓'} ${String(i + 1).padStart(2)} ${s.name.padEnd(12, '　')} ` +
        `钉${String(stage.pegs.length).padStart(3)} ` +
        `落槽${landRate.toFixed(0).toString().padStart(3)}% 超时${toRate.toFixed(0).toString().padStart(3)}% ` +
        `中位${med.toFixed(2)}s P90${p90.toFixed(2)}s  ` +
        `滞留 y=${stalls ? `${stalls[0] * 4}~${stalls[0] * 4 + 4}` : '-'}(${stalls ? stalls[1].toFixed(0) : 0}s)  ` +
        `热点 ${hot.map(([k, n]) => `${k}×${n}`).join(' ')}`,
    );
  }
  console.log(fail ? `\n✗ ${fail} 关布局不合格` : '\n✓ 全部关卡布局合格');
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
