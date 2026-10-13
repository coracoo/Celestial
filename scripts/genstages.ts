/**
 * 关卡生成器：`node --experimental-strip-types scripts/genstages.ts`
 *
 * 12 关走《水浒传》正传线，每关换的是**钉阵布局**，不是换皮：
 * 横排 → 雪炮 → 蜂窝 → 漏斗 → 阶梯 → 棋盘 → 螺线 → 波带 → 内雪炮 → 三环 → 倒漏斗 → 混编。
 *
 * 为什么用生成器而不是手写 12 份 JSON：
 * 落槽、边框、发射器、確変闸这些**每关都一样**的骨架占了单关 200 行，
 * 手写 12 份就是 2400 行重复，而且改一次闸门尺寸要改 12 处——必然漏。
 * 这里把差异（钉阵 / 盘宽 / 重力 / Boss / 数值）抽成参数，骨架只写一遍。
 * 生成结果仍然是 `public/data/stages/*.json`，运行时读的只有 JSON，链路不变。
 *
 * ── 两条必须守住的红线（改参数前先读） ──
 *
 * 1. **发射力度上限由重力反推**，不能拍脑袋：
 *      `power² / (2|g|) ≤ 头部空间`，头部空间 = 盘顶 y − 发射器 y − 安全余量。
 *      盘高 32、发射器 y=25.4，头部只有 6.6；留 0.2 余量按 6.4 算。
 *      本文件用 `maxPowerFor(g)` 自动算，写死就会在低重力关砸顶。
 *
 * 2. **盘宽变了，落槽宽度、导流罩 X、钉阵范围都要跟着走**。
 *      `slotsFor(w)` 负责这件事——5 个槽各占 1/5 盘宽再内缩，
 *      超过盘宽的钉会被侧墙吞掉或卡在半空。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BOTTOM, COMBAT, PHYSICS, PLAYER_QUALITY, SHOT_BUDGET_SLACK, SWEEP_MAX } from '../src/core/constants.ts';
import type {
  BossPhaseDef,
  PegDef,
  PegFormationDef,
  PegRowDef,
  PhaseDeprivation,
  SlotDef,
  SlotKind,
  StageDef,
  WallDef,
  ZoneDef,
} from '../src/data/schema.ts';
import { auditLanes, auditSummary, expandStage } from '../src/sim/board.ts';
import type { FlipperGeom } from '../src/sim/board.ts';

/* ------------------------------------------------------------------ 骨架常量 */

const BOARD_H = 32;

/**
 * 5 个落槽等分一段**居中的内区**，整排再左右移动。
 *
 * `role` 是**印在盘面上的槽口铭牌**，写的是「这个槽给我什么」而不是一个数字。
 * 玩家判断该往哪打只能看盘面：只有「破绽」扣 Boss 血这件事必须常驻可见，
 * 不然每次落槽都是在赌，赌错就白扔一颗球。
 * 句子里的数字全部取自 COMBAT 常量——结算和铭牌读同一个定义，不会对不上。
 */
function slotsFor(w: number): SlotDef[] {
  const sw = Number((w * BOTTOM.slotWidthRatio).toFixed(3));
  const pitch = (w * BOTTOM.slotSpanRatio) / 5;
  const kinds: { id: string; kind: SlotKind; label: string; value: number; role: string }[] = [
    { id: 'slot_coin', kind: 'normal', label: '铜钱', value: 70, role: `加分 ${70}` },
    {
      id: 'slot_energy',
      kind: 'energy',
      label: '聚气',
      value: 0,
      role: `充能量 +${COMBAT.slotEnergyGain}`,
    },
    {
      id: 'slot_weak',
      kind: 'boss',
      label: '破绽',
      value: 210,
      role: `扣 Boss 血 · 正中 ×${COMBAT.weakSlotMult}　带标记 ×${COMBAT.markSlotMult}`,
    },
    { id: 'slot_combo', kind: 'combo', label: '连斩', value: 120, role: '连击不中断' },
    {
      id: 'slot_gold',
      kind: 'multiplier',
      label: '万金',
      value: 95,
      role: `下颗球 ×${COMBAT.slotNextMult}`,
    },
  ];
  return kinds.map((k, i) => ({
    id: k.id,
    x: Number(((i - 2) * pitch).toFixed(3)),
    // 高度整套读 BOTTOM：槽体压扁是为了给上方的滚落随机钉腾位置，
    // 见 constants 里 BOTTOM 那段注释的分层表。
    y: BOTTOM.slotY,
    w: sw,
    h: BOTTOM.slotHalfH * 2,
    kind: k.kind,
    label: k.label,
    value: k.value,
    role: k.role,
  }));
}

/**
 * ~~底部滚落随机钉~~ —— **已删**（本轮，见 `bottomFlippers` 的漏斗段）。
 *
 * 留着的那一排满宽小钉实测是有害的，三个理由：
 *   1. **它产生不了随机。** Galton 板落点服从 `Binomial(N, 0.5)`，N 是排数；
 *      单排就是 N=1，分布是两个点，谈不上散开。实测加了这排之后
 *      落槽熵从 0.570 掉到 0.535 —— 随机性反而降了。
 *   2. **它和收口漏斗穿模。** 钉排满宽铺到离侧壁 0.35bu，而漏斗正好斜穿
 *      y=2.5~3.7 那一带。两者都是静态体，Rapier 不推、不报错，
 *      球被夹在钉和墙之间磨 —— 改完漏斗那轮 12 关里有 5 关超时 22~33%。
 *   3. **它把移动落槽的时机技巧废掉。** 时机技巧的前提是「球从哪下来 ≈
 *      落进哪」；一排随机钉在中间拦一道，落点就回到纯概率，玩家无从判断。
 *
 * 板尖到槽沿之间那 2.5bu 自由落体改用降重力处理（`PHYSICS.gravity`），
 * 不靠挡球的东西 —— 挡球的东西只消耗能量，不减速。
 */
/**
 * 底部让位：盘面内容的最低点不得低于 `BOTTOM.keepOutY`。
 *
 * 为什么需要这一步：翻板是**运动学体**、钉是静态体。板弹起时扫过的扇形
 * （以枢轴为心、半径 = 板长、角度 = 静止角 → 弹起角）如果压到一颗钉，
 * Rapier 不会把它们推开 —— 板直接穿过去，球被夹在中间乱弹，
 * 而且盘面几何审计（`auditLanes`）只看钉与钉、`smoke` 只看落槽率，
 * **没有任何一层会报这个错**。只能在生成阶段把空间让出来。
 *
 * 让位规则分三种：
 *   1. 破绽十字 —— **搬家**而不是让位。它是底部随机区的分水岭，
 *      搬到 `BOTTOM.weakMouthY` 之后正好卡在板尖正下方。
 *   2. 整行 —— 向上平移到最低点刚好等于红线（保留钉阵密度，不整行删）。
 *   3. 阵型 —— 同上，竖直半径按形状粗估。估不准没关系：
 *      生成完还有一道实测校验（`bottomReport`）会把漏网的钉列出来。
 */
/**
 * 一个阵型从 `cy` 往下伸多远（世界单位）。
 *
 * 这些公式是从 `board.ts` 的 `pushFormation` 里**抄出来的**，不是在旁边估的 ——
 * 两处不一致时的失败模式很隐蔽：估小了阵型底部的钉会被翻板扫到，
 * 估大了整片阵型被无谓地抬高、和上方的钉挤成一团（冲突消解会静默丢钉）。
 * 改 `pushFormation` 的排布公式时必须同步这里。
 *
 * `U(r) = r × CELL`，CELL = 2.55（中心距系数）；`PASS = 1.95` 是围合形状的间距系数。
 */
function formReach(f: Form): number {
  const u = f.r * 2.55;
  const pass = u * 1.95;
  switch (f.shape) {
    case 'diamond':
      return u + f.r;
    case 'triangle':
      return u * 1.732 + f.r;
    case 'cross':
      return u + f.r;
    case 'ring':
      return u + ((f.rings ?? 2) - 1) * pass + f.r;
    case 'wall':
      return u * 0.32 + f.r;
    case 'chevron':
      return (f.count ?? 5) * pass * Math.sin((Math.min(78, f.angleDeg ?? 55) * Math.PI) / 180) + f.r;
    case 'funnel':
      return ((f.count ?? 6) - 1) * pass * 0.5 + f.r;
    case 'spiral':
      // 螺线半径每转约增长一个 step，保守取 turns + 1 圈
      return pass * ((f.turns ?? 2) + 1) + f.r;
    case 'hex':
      return (((f.rows ?? 3) - 1) / 2) * u * 1.95 * 0.87 + u + f.r;
    case 'wave':
      return (f.amp ?? u * 0.7) + u + f.r;
    case 'stair':
      return ((f.count ?? 4) - 1) * pass * 0.62 + f.r;
    case 'lattice':
      return (((f.rows ?? 3) - 1) / 2) * u * 1.95 * 1.3 + f.r;
    default:
      return f.r * 4;
  }
}

function makeRoomForBottom(rows: Row[], forms: Form[]): { rows: Row[]; forms: Form[]; notes: string[] } {
  const keep = BOTTOM.keepOutY;
  const notes: string[] = [];

  const outRows = rows.map((r) => {
    if (r.y - r.r >= keep) return r;
    const y = Number((keep + r.r).toFixed(3));
    notes.push(`行 y=${r.y}→${y}`);
    return { ...r, y };
  });

  const outForms: Form[] = [];
  for (const f of forms) {
    /*
     * 破绽十字**整个删掉**，不再搬到底部。
     *
     * 上一版把它搬到 `BOTTOM.weakMouthY`（板尖正下方 0.8bu 处），想让
     * 「撞破绽钉 → 进破绽口」这条读法在底部成立。物理上不成立：
     * 十字四钉臂距 0.765、钉半径 0.3，中央净缝只有 0.165 —— 球径 0.66
     * 根本进不去；而它离板尖太近（上钉 4.96 对板尖 5.0），球从板尖漏下时
     * 球心才 5.2，一离开板就贴上钉顶，撞完停死。实测 stage_02/04 停死率
     * 42%，热点全在 (0.5, 5.2) 一带。
     *
     * 「破绽」这件事现在由两处承担，都比一颗挡路的钉更可靠：
     *   · 槽口铭牌（`slotsFor` 里 `slot_weak.role`）常驻写明它是唯一扣血口；
     *   · 底部的随机性由滚落钉排提供，而滚落钉排在破绽槽正上方 ——
     *     球撞钉之后落进正下方那一口，仍然是「底部中央 = 破绽」的读法。
     */
    if (f.id === 'weak_mouth') {
      notes.push(`破绽十字 y=${f.cy}→删除（底部中央改由滚落随机钉独占）`);
      continue;
    }
    const reach = formReach(f);
    if (f.cy - reach >= keep) { outForms.push(f); continue; }
    const cy = Number((keep + reach).toFixed(3));
    notes.push(`${f.id} y=${f.cy}→${cy}`);
    outForms.push({ ...f, cy });
  }

  return { rows: outRows, forms: outForms, notes };
}

/**
 * 底部结构的实测校验（生成期，不跑物理）。
 *
 * 查两件事：
 *   1. 还有没有钉的最低点低于 `BOTTOM.keepOutY`。让位是粗估（阵型竖直半径按
 *      6r 包络），这一步用**展开后的真实钉位**兜底。
 *   2. 有没有钉落在翻板弹起的扫掠扇形里。这是**唯一会静默出错**的一类：
 *      板是运动学体、钉是静态体，相交时板直接穿过去，球被夹在中间乱弹，
 *      而 `auditLanes` 只看钉与钉、`smoke` 只看落槽率 —— 没有一层会报。
 */
function checkBottom(id: string, pegs: readonly PegDef[], flippers: readonly FlipperGeom[]): void {
  /*
   * 判据用**采样**而不是"扇形角度 + 半径"。
   *
   * 角度判据看起来更省，但会算错两类：
   *   · 钉落在扇形**外侧、板尖延长线方向**上（半径刚过板长）—— 按半径筛会被判成安全，
   *     实际它贴着板尖；破绽十字的臂钉就正好在这个位置（实测钉心到板尖 0.336）。
   *   · 钉落在扇形内侧但角度差一丝 —— 角度判据要给钉算一个角宽度，
   *     那个 `asin((r+half)/d)` 的近似在近距离会明显偏差。
   *
   * 板只有 2.4~2.8 长，扫掠角 62°。沿角度取 24 份、沿板长取 6 份共 144 个采样点，
   * 点间距约 0.05 —— 比任何真实间隙都细。`preview()` 里那条确定性弹道预测
   * 也是同样量级的采样密度，这一层的开销（12 关 × 百级钉 × 144）在生成期可以忽略。
   */
  for (const f of flippers) {
    const a0 = Math.min(f.restRad, f.flipRad);
    const a1 = Math.max(f.restRad, f.flipRad);
    const pad = f.half + 0.02;
    const hit: string[] = [];
    for (const p of pegs) {
      let near = Infinity;
      for (let ai = 0; ai <= 24 && near > p.r + pad; ai++) {
        const a = a0 + ((a1 - a0) * ai) / 24;
        for (let ri = 0; ri <= 6; ri++) {
          const r = (f.len * ri) / 6;
          const d = Math.hypot(f.px + Math.cos(a) * r - p.x, f.py + Math.sin(a) * r - p.y);
          if (d < near) near = d;
        }
      }
      if (near <= p.r + pad) hit.push(`(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
    }
    if (hit.length) {
      bottomReport.push(`${id} ⚠板扫掠 ${f.id} 命中 ${hit.slice(0, 4).join(' ')}`);
    }
  }
}

/**
 * 中央闸门：**在生成期堵掉「一颗球从盘面顶部一路笔直掉到板区正中」的中央滑梯。**
 *
 * ── 现象 ──
 *
 * 底部收口补完之后，玩家反馈「顶部格挡布局不合理，球过于容易从中间一路掉落」。
 * 在**钉阵主体区**里逐行向下洪泛（只往下，不许往上），把「中央 ±2 那一带
 * 球心全程可停」的列数数出来，量到的结果是这样的：
 *
 *   stage_02 盘宽14  最宽走廊 14.70bu  中央±2 可达 14/14  ← 全通
 *   stage_03 盘宽18  最宽走廊 18.00bu  中央±2 可达 13/13  ← 全通
 *   stage_05 盘宽16  最宽走廊 15.90bu  中央±2 可达 14/14  ← 全通
 *   stage_06 盘宽20  最宽走廊 20.10bu  中央±2 可达 13/13  ← 全通
 *   stage_09 盘宽16  最宽走廊 15.90bu  中央±2 可达 14/14  ← 全通
 *   stage_10 盘宽18  最宽走廊 18.00bu  中央±2 可达 13/13  ← 全通
 *   stage_12 盘宽18  最宽走廊  2.40bu  中央±2 可达  0/13  ← 合格
 *
 * 六个关卡的中央是一条**从盘面顶一路敞到底的滑梯**：球落进来几乎不碰钉，
 * 直落到两块弹板之间那道中央开口，再顺着它漏进槽。这不是弹球，是滑梯。
 *
 * ── 判据为什么是「单向下行」而不是四邻域洪泛 ──
 *
 * 第一版用四邻域洪泛，量出 stage_02 直达 14.70bu（盘宽 14）、stage_06 20.10bu
 * （盘宽 20）—— 接近甚至超过整盘宽。那是判据太松：球在屋顶下方那一整行
 * 任意位置起步，多向洪泛允许它在钉缝里上下左右绕，一颗正在下落的球做不到。
 *
 * 更要命的是上边界。屋顶（`trk_roof`，y≈27.6~32）下面本来就有一整条空带，
 * 从那里起步等于「球可以从任何位置落进来」，量出来永远是整盘宽。
 * 所以上边界取**盘面内容最高点往下 1.5bu**，把屋顶以上排除在统计之外。
 *
 * 传播也必须单向：球顺着斜面往下滑，不会逆着重力爬上去。
 * 实现成「逐行推进，每行的自由区间和上一行的可达区间相交则整段可达」，
 * 于是球可以横着滑过一整个区间，但爬不上斜面。
 *
 * ── 怎么堵 ──
 *
 * 反复：量 → 中央还全通就再插一根横挡 → 重量。
 * 每根插在**中央走廊的下半段**（从 `keepOutY` 往上扫第一个放得下的高度），
 * 于是第一根在下、第二根自然落在上，不会三根堆在同一高度。
 *
 * ── 三条不能破的约束 ──
 *
 *   · **两端必须留缝**（`width` 自带）。横挡压到侧壁或钉阵上就形成封闭空腔，
 *     球钻进去出不来 —— 那比滑梯严重得多。挡宽封顶 4.0bu：
 *     球仍然能绕过去，但必须真的瞄一下，宽走廊等于作废。
 *     再宽中央就变成一堵墙，球只能走两侧，节奏会太闷。
 *   · **横挡本体不能和任何钉相交**。相交不报错，只会在钉堆里多一面墙，
 *     而钉的相交消解是先到先得，于是这根挡可能被后面的钉顶掉、也可能把钉顶掉，
 *     两种结果都让这一轮收口变成随机事件。所以先扫高度，扫不到就跳过这一轮。
 *   · **横挡不能伸进弹板扫掠区**。下界卡在 `keepOutY`，插完 `checkBottom`
 *     照常复查，不靠这里自觉。
 *
 * ── 幂等 ──
 *
 * `buildStage` 一关会被调两次（`placeEnemies` 探一次、`main` 出货一次），
 * 所以这个函数必须是**纯函数**：只读 board，只按判据决定插不插，
 * 不带任何跨调用状态。终端报告按文本去重，避免同一个结论打两遍。
 */
const GATE = {
  /** 中央判定带：球心落在这个区间就算「走中央」 */
  band: 2.0,
  /** 横挡宽度。上限 4.0bu —— 太宽中央就成了一堵墙，球只能走两侧 */
  width: 4.0,
  /** 最多插几根 */
  rounds: 3,
  /** 找可插高度时的扫描步长 */
  yStep: 0.25,
  /** 相邻两根闸门的最小竖直间距 */
  minGap: 2.5,
  /** 横挡本体离钉至少留这么多（钉 r + 墙半厚 + 一点余量） */
  yClear: 0.16,
  /** 洪泛网格步长 */
  step: 0.3,
  /** 盘面主体区上边界 = 内容最高点往下留这么多 */
  topInset: 1.5,
} as const;

/** 逐行向下传播的可达带。返回「中央判定带内可停的列数 / 总列数」。 */
function measureShaft(
  obs: readonly { x: number; y: number; r: number }[],
  hw: number,
  yBot: number,
  yFrom: number,
  extra: readonly { x: number; y: number; r: number }[] = [],
): { full: number; mid: number } {
  const all = [...obs, ...extra];
  const step = GATE.step;
  const R = PHYSICS.ballRadius;
  if (yFrom <= yBot) return { full: 0, mid: 1 };
  const cols = Math.floor((2 * hw) / step) + 1;
  const rows = Math.ceil((yFrom - yBot) / step) + 1;
  const grid = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const y = yFrom - j * step;
    for (let i = 0; i < cols; i++) {
      const x = -hw + i * step;
      let free = true;
      for (const o of all) {
        if ((x - o.x) ** 2 + (y - o.y) ** 2 < (o.r + R) ** 2) {
          free = false;
          break;
        }
      }
      if (free) grid[j * cols + i] = 1;
    }
  }
  let reach = new Uint8Array(cols);
  for (let i = 0; i < cols; i++) reach[i] = grid[i];
  /*
   * `full` 逐行 AND：只有**每一行都可达**的列才算数。
   *
   * 只看最后一行会把「从两侧绕到闸门下方再横移回中央」也算成通 ——
   * 那是静态洪泛的乐观假设：球在空旷的闸门下方横向漂移需要一个很准的角度，
   * 而它砸在水平挡板上是被弹开的。所以这一列必须全程都在带内，
   * 才配叫「从中央笔直掉下来」。
   */
  const full = new Uint8Array(cols);
  for (let i = 0; i < cols; i++) full[i] = grid[i];
  for (let j = 1; j < rows; j++) {
    const next = new Uint8Array(cols);
    let inSeg = false;
    let segReach = false;
    let segX0 = 0;
    for (let i = 0; i <= cols; i++) {
      const open = i < cols && grid[j * cols + i] === 1;
      if (open) {
        if (!inSeg) {
          inSeg = true;
          segX0 = i;
          segReach = reach[i] === 1;
        } else if (reach[i]) segReach = true;
      } else if (inSeg) {
        if (segReach) for (let k = segX0; k < i; k++) next[k] = 1;
        inSeg = false;
        segReach = false;
      }
    }
    reach = next;
    for (let i = 0; i < cols; i++) full[i] &= reach[i];
  }
  let mid = 0;
  let hit = 0;
  for (let i = 0; i < cols; i++) {
    const x = -hw + i * step;
    if (x < -GATE.band || x > GATE.band) continue;
    mid++;
    if (full[i]) hit++;
  }
  return { full: hit, mid };
}

function centralGates(
  id: string,
  probe: { pegs: readonly { x: number; y: number; r: number }[]; walls: readonly WallDef[] },
  hw: number,
): WallDef[] {
  const yBot = BOTTOM.keepOutY;
  /** 障碍：钉按点，墙沿线采样。底部收口层不参与 —— 它本来就在 yBot 之下 */
  const obs: { x: number; y: number; r: number }[] = probe.pegs.map((p) => ({ ...p }));
  const sample = (w: WallDef): void => {
    if (w.y - Math.abs(w.w) < yBot - 1) return;
    const rad = (w.rotDeg * Math.PI) / 180;
    const dx = Math.cos(rad) * w.w;
    const dy = Math.sin(rad) * w.w;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / GATE.step));
    for (let i = 0; i <= n; i++) {
      obs.push({ x: w.x - dx + (2 * dx * i) / n, y: w.y - dy + (2 * dy * i) / n, r: w.h });
    }
  };
  for (const w of probe.walls) sample(w);
  // 上边界 = 盘面内容最高点往下 inset，把屋顶以上的空带排除在统计之外
  let topY = -Infinity;
  for (const o of obs) if (o.y > yBot && o.y > topY) topY = o.y;
  const yFrom = topY - GATE.topInset;
  const hl = Math.min(GATE.width, hw - 1.5) / 2;
  if (yFrom <= yBot + 1 || hl <= 0.2) return [];

  /** 闸门是**一条线**不是一点：当成点会在洪泛里失效，三轮全插在同一高度 */
  const asLine = (g: WallDef): { x: number; y: number; r: number }[] => {
    const n = Math.max(1, Math.ceil((hl * 2) / GATE.step));
    const out: { x: number; y: number; r: number }[] = [];
    for (let i = 0; i <= n; i++) out.push({ x: -hl + (2 * hl * i) / n, y: g.y, r: 0.16 });
    return out;
  };
  const report = (m: { full: number; mid: number; tag?: string }): void => {
    const note =
      `${id} ${m.tag ?? `闸门×${out.length}`}  中央±${GATE.band} 全程可达 ` +
      `${m.full}/${m.mid}${m.tag ? '' : out.length ? '（仍全通）' : ''}`;
    if (!topReport.includes(note)) topReport.push(note);
  };

  const out: WallDef[] = [];
  report({ ...measureShaft(obs, hw, yBot, yFrom), tag: '改造前' });
  for (let round = 0; round < GATE.rounds; round++) {
    const m = measureShaft(obs, hw, yBot, yFrom, out.flatMap(asLine));
    // 中央判定带不再全通就算收工
    if (m.full < m.mid) {
      if (out.length) report(m);
      return out;
    }
    /*
     * 从**下半段**往上扫第一个放得下的高度。上一轮插的挡在上半段，
     * 这一轮自然落在它下面；重测之后如果还全通，说明球从两挡之间绕过去了，
     * 下一轮再补一根更下面的。
     */
    let put: WallDef | null = null;
    for (let y = yBot + 1.2; y <= yFrom - 0.4 && !put; y += GATE.yStep) {
      // 和已插的挡保持竖直间距。三根挡全落在 9.2 就是漏了这一条：
      // clash 只查钉阵，不查上一轮自己插的墙，于是同一高度永远"空着"。
      if (out.some((g) => Math.abs(g.y - y) < GATE.minGap)) continue;
      let clash = false;
      for (const o of obs) {
        // 闸门是一条 y=const 的横线：只有高度差和横向距离同时够开才算不相交
        if (Math.abs(o.y - y) < o.r + GATE.yClear + 0.16 && Math.abs(o.x) < hl + o.r) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      put = wallD(`gate_${out.length + 1}`, 0, Number(y.toFixed(3)), hl, 0);
    }
    if (!put) break;
    out.push(put);
  }
  report(measureShaft(obs, hw, yBot, yFrom, out.flatMap(asLine)));
  return out;
}

function scatterRows(_w: number): Row[] {
  // 滚落随机钉已删（理由见上面那段）。函数留着是为了不改动 12 处调用点的签名，
  // 一旦有谁再往底部加「随机元件」，这里会是个明显的空实现提醒。
  return [];
}

/**
 * 导流板工厂。统一厚度（0.16）与 role，x 取三位小数 ——
 * 生成物是签进仓库的 JSON，浮点尾巴会让每次重新生成的 diff 全是噪声。
 * 提到模块级是因为底部收口层（`bottomFlippers`）也要用同一套工厂。
 */
function wallD(
  id: string,
  x: number,
  y: number,
  dw: number,
  rotDeg: number,
  flip?: 'left' | 'right',
): WallDef {
  return {
    id,
    x: Number(x.toFixed(3)),
    y,
    w: dw,
    h: 0.16,
    rotDeg,
    role: 'deflector',
    flip,
  };
}

/**
 * 10 面导流罩。**位置从盘宽实算，不按比例缩放。**
 *
 * 注意 `w` 是**半长**不是全长（Physics.createWall 收的是 hx/hy），
 * 所以一面 `w: 1.7` 的罩子实际有 3.4 长——按「全长」去算离壁距离会算错一倍。
 *
 * 两条硬约束，都是探针实测逼出来的：
 *
 * 1. **顶罩必须封到侧壁**。原来的顶罩外端离壁还有 1.05，球（径 0.66）刚好钻得进去，
 *    然后被罩子外端和侧壁两堵刚体夹在 (-7.7, 26.8) 的墙角上下不来——
 *    smoke 逐关校验里 stage_04 / stage_09 的头号死点全在这儿。
 *    侧壁是刚体，`escapeTrap` 虚化的是钉板，救不了被墙夹住的球，
 *    所以这类坑只能在摆位阶段堵死：顶罩外端压到离壁 0.15（球过不去）。
 *
 * 2. **侧罩不能跨中轴**。原来 `d_mid` 放在 ±(hw-5.1)，盘宽 12 时算出 ±0.9，
 *    罩子长 2.6 —— 两片罩子在盘心交叉成一个 X，球从发射口出来直接撞在叉口上。
 *    现在统一用 `sideShield` 夹紧：内端离中轴至少 2.2。
 */
function deflectorsFor(w: number): WallDef[] {
  const hw = w / 2;
  const d = wallD;

  /**
   * 侧导流罩。`inset` = 外端离侧壁的距离，`hl` = 半长。
   * 内端离中轴不足 2.2 就整片往里挪（宁可离壁远一点，也不能跨过盘心）。
   */
  const side = (
    id: string, side_: -1 | 1, y: number, hl: number, rotDeg: number, inset: number,
  ): WallDef => {
    const outer = hw - inset;
    const rad = (rotDeg * Math.PI) / 180;
    const halfSpan = hl * Math.cos(rad);
    const inner = Math.max(2.2, outer - halfSpan);
    const cx = side_ * ((outer + inner) / 2);
    // 正 rotDeg 时外端更高，中点要往下压半格
    const lift = hl * Math.sin(rad);
    return d(id, cx, y + lift, hl, side_ * rotDeg);
  };

  return [
    // **这里原本有一对「封壁斜罩」，已删掉。**
    //
    // 它想把顶排两侧的通道口堵上，结果两个问题：
    //   1. 任何斜面和平侧壁的交点都是一个 **V 形槽**，斜面把球往里送的力
    //      恰好和侧壁把球往外推的力对消，球就停在 (6~7, 26) 上下不来——
    //      比原来的墙角陷阱还严重（stage_01 落槽 95% → 87%）。
    //   2. 斜罩内端 (±4.85, 24.4) 正好压在 ±4.6 的十字枪阵上，
    //      罩子下沿与枪阵横臂只剩 0.50 的缝（球径 0.66），球根本钻不过去。
    //
    // 正解不是加罩子，是**把顶排铺到侧壁**：钉子外沿贴壁，侧向净缝 0，球压根进不去。
    side('d_mid_l', -1, 22.4, 1.3, 15, 3.4),
    side('d_mid_r', 1, 22.4, 1.3, 15, 3.4),
    side('d_low_l', -1, 13.6, 1.4, 28, 3.4),
    side('d_low_r', 1, 13.6, 1.4, 28, 3.4),
    /*
     * 中央那对 `horn_l / horn_r` 导流斜坡**已删除**。
     *
     * 它们原来在 y≈5.2~5.5、x = ±1.66，作用是把盘心落下来的球往两侧拨。
     * 底部收口之后这两根正好压在翻板板身的位置上：板从枢轴朝内下伸，
     * 板尖落在 ±0.95，horn 的内端却在 ±0.46 —— 两者在 x-y 上直接相交。
     * 而且中央现在有破绽十字卡在板尖正下方（`BOTTOM.weakMouthY`），
     * 「把中央的球拨走」这件事本身也不成立了：底部要的就是球必须经过中央。
     */
    ...bottomFlippers(hw, w, d),
  ];
}

/**
 * 底部收口层：一块可操作翻板 + 一片外侧导流阶梯（左右镜像）。
 *
 * ── 为什么要收口 ──
 *
 * 改造前板尖落在 `±(hw×0.6 − 板长×cos22°)` 上，盘宽 15.8 时是 ±2.02：
 * 两块板尖之间留 **4.04bu**（6.1 个球径），板外端到侧壁还有 **3.1bu** 空档。
 * 板总共只盖住底部 `2×2.78/15.8 = 35%` 的宽度，剩下 65% 是球碰都碰不到板的
 * 直落通道 —— 玩家按 Z / X 十次有九次打空，机制在、能按、有声音，就是打不到球。
 * 盘宽 28 的 teaching 关更极端：板尖之间 7.46bu，板外端到侧壁 5.5bu。
 *
 * 现在改成**板尖先定死在 ±BOTTOM.tipX**，枢轴由板长反推：
 * 板尖永远落在中央开口两侧，球从盘面中央掉下来必然先经过板。
 *
 * ── 导流阶梯是往哪边送球 ──
 *
 * **这一条和改造前是反的，是本轮最要紧的一处行为变化。**
 * 改造前导流墙是「往外侧下倾」的：球落在外侧，顺着墙一路滑到侧壁，
 * 直接掉进最外那个槽 —— 墙不是在喂翻板，是在**把球从翻板手里抢走送进外槽**。
 * 实测 1440 球里「万金」独占 40.9% 而对称的「铜钱」只有 2.1%，方向性就是这么来的。
 *
 * 现在阶梯一律**往内侧下倾**：球砸在外侧，顺着级面一级一级滑向枢轴，
 * 最后落在翻板上。板打回去才是这个底部的主要玩法，
 * 外槽只能靠球从板尖之间那道中央开口漏下来才拿得到。
 *
 * 阶梯级数很少（`guideSteps`）是有原因的：级面每级只落 `guideStepDrop`，
 * 一条从侧壁通到枢轴的长斜坡在 `keepOutY` 的高度预算下只有 5.5°，
 * 而球板摩擦 0.1 —— tan5.5° = 0.096 < μ，球骑上去直接停住。
 * 铺不满的那段不是漏点：槽行收窄到 `slotSpanRatio` 之后，
 * 外侧由**静态收口漏斗**接住，整排在漏斗嘴里面滑（见上面漏斗那段）。
 */
function bottomFlippers(
  hw: number,
  w: number,
  d: (id: string, x: number, y: number, dw: number, rotDeg: number, flip?: 'left' | 'right') => WallDef,
): WallDef[] {
  const out: WallDef[] = [];
  const rad = (BOTTOM.restDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  for (const [sideName, dir] of [['left', -1], ['right', 1]] as const) {
    /*
     * 板长：按盘宽给，但夹在 [minLen, maxLen]，并且不能长到把枢轴推出侧壁
     * （`hw − sideLeak` 是枢轴能到的最外位置）。
     */
    const room = hw - BOTTOM.sideLeak - BOTTOM.tipX;
    const len = Math.max(BOTTOM.minLen, Math.min(BOTTOM.maxLen, Math.min(hw * BOTTOM.lenRatio, room)));
    const halfLen = len / 2;
    /*
     * 枢轴 = 板尖 + 板长 × (cos, sin)。板身从枢轴指向板尖（朝内下），
     * 所以枢轴比板尖高、比板尖靠外，左右镜像。
     */
    const px = dir * (BOTTOM.tipX + len * cos);
    const py = BOTTOM.tipY + len * sin;
    /*
     * `expandStage` 按「墙体外端为翻板枢轴」反推（左板取左端、右板取右端），
     * 所以交给它的仍然是**墙体中心**：中心 = 枢轴朝板尖方向退回半块板长。
     * 左右两侧公式一样（**不能乘 dir**，乘了会让两块板差一整块板的高度）。
     *
     * **`d()` 的第三个参数是半长不是全长**（`WallDef.w` 是半长，翻板那一层
     * 再 `len = w.w × 2` 折算回来）。早先传全长时板实际长了一倍 —— 板尖从
     * ±0.95 一路伸到盘心另一侧、板尖扫掠打到 y=9 的钉，而生成期不报任何错，
     * 只有下面那道采样式扫掠校验能抓到。
     */
    out.push(
      d(
        `flip_${sideName}`,
        px - dir * halfLen * cos,
        py - halfLen * sin,
        halfLen,
        dir * BOTTOM.restDeg,
        sideName,
      ),
    );

    /*
     * 收口漏斗：静态斜墙，从侧壁一路斜下来，**内端落在槽行漂到最远时仍盖得住的位置**。
     *
     * 这一段是「两侧漏点变窄」的全部落点。之前枢轴到侧壁整段是敞着的
     * （窄关 2.76bu、宽关 10.3bu），球砸在外侧一路滑到最外那个槽，翻板拦都拦不住。
     * 现在漏斗把这整段收成一条朝内的斜坡，球顺着滑到槽行上方才落下。
     *
     * `lipX` 的取法是这里唯一 tricky 的地方，有两个约束同时成立：
     *
     *   1. **不许伸到弹板底下**。斜坡内端按槽行反推得到（外缘 − 漂移 − 余量），
     *      而窄盘上这个值会小于弹板的外缘 —— stage_07 实测槽行算出 `lipX = 1.96`，
     *      板外缘却在 `3.18`。差的这 1.2bu 是一条**没有收口的竖井**：
     *      球从上方落进板和斜坡之间，一路自由落体到槽沿，完全绕过弹板。
     *      这就是玩家说的「弹板和底部有间隙」。修法是让斜坡内端退到板外缘之外，
     *      并且板外缘和斜坡内端之间用一根竖直短墙接死，不留可穿过的缝。
     *   2. **要盖住槽行漂到最远时的外缘**。排是会左右滑的，只按零位的外缘收口的话，
     *      排滑到一边时另一侧就腾出一条没人接的带子，球从那儿直接漏到盘底。
     *      退到 `外缘 − 漂移` 才是「排无论滑到哪都压得住」的那条线，后面再留 0.6bu 保险。
     *
     * 两条取最大值即可。外侧那段（`xFun − lipX`）窄到放不下斜坡时，
     * 不生成斜坡 —— 竖直短墙会一路接到侧壁，两侧仍然是收口的。
     *
     * 漏斗是静态的：整排在它嘴里面滑，墙不跟着动，也就不会出现「墙和侧壁之间
     * 留出 ≈ 一个球径的夹球缝」—— 那个缝实测让 stage_01 有 28% 的球磨到超时。
     */
    const pitch = (w * BOTTOM.slotSpanRatio) / 5;
    const slotOuter = 2 * pitch + (w * BOTTOM.slotWidthRatio) / 2;
    const driftMax = w * BOTTOM.slotDriftRatio;
    // 弹板外缘：板尖 + 板长的水平投影。斜坡内端必须落在它外面（见上面第 1 条）
    const plateOuter = BOTTOM.tipX + len * cos;
    const lipFromSlot = slotOuter - driftMax - BOTTOM.funnelLipMargin;
    const lipX = Math.max(lipFromSlot, plateOuter + BOTTOM.funnelLipGap);
    const xFun = hw - BOTTOM.funnelWallGap;
    /*
     * 竖直短墙：把弹板外缘和斜坡内端之间那条竖井封死。
     * 顶端必须高于弹板外端（`py`），否则球从板外侧落下来还会从墙顶跨过去。
     */
    const gapW = lipX - plateOuter;
    if (gapW > 0.05) {
      const wallTop = py + 0.25;
      const wallBot = BOTTOM.slotY + BOTTOM.slotHalfH;
      out.push(
        d(`guide_${sideName}`, dir * ((plateOuter + lipX) / 2), (wallTop + wallBot) / 2, gapW / 2, 0),
      );
    }
    if (xFun - lipX > 0.6) {
      // 从侧壁高处斜到 lipX 的槽沿高度，**朝内下倾**，球滑进来
      const spanF = xFun - lipX;
      const rise = spanF * Math.tan((BOTTOM.funnelDeg * Math.PI) / 180);
      const cy = BOTTOM.slotY + BOTTOM.slotHalfH + rise / 2;
      const halfF = Math.hypot(spanF, rise) / 2;
      const rot = dir * ((Math.atan2(rise, spanF) * 180) / Math.PI);
      out.push(d(`funnel_${sideName}`, dir * ((lipX + xFun) / 2), cy, halfF, rot));
    }
  }
  return out;
}

/**
 * 顶排往外连续补钉，一路补到钉外沿贴住侧壁。
 *
 * 盘宽 16 时顶排只铺到 x=±5.8（钉外沿 6.06），侧壁在 ±8 —— 中间留着一条
 * **1.94 宽的竖直通道**，球顺着它一路窜到 y=27 的墙角，再被侧壁和顶排夹死。
 * 探针和 smoke 的头号死点 (-7.7, 26.8) / (7.3, 27.0) 就在这条通道上。
 *
 * 只在通道口补一颗钉是不够的：补一颗之后 5.8~7.74 之间还剩 1.42 的缝，
 * 球照样钻得进去，然后卡死在「侧壁 + 补钉」之间那道 45° 的 V 里
 * （smoke 实测 stage_01 死点 (7.3,27.0) 正好是补钉的斜下方 0.59 处）。
 * 所以要**一直补到贴壁**，且间距压到球钻不过去为止：
 * 净缝 = 间距 − 2r < 球径 0.66，即间距 < 2r + 0.66。
 *
 * 补出来的钉外沿正好等于侧壁内沿，真机顶排两端就是这么收边的。
 */
function sealCorners(rows: Row[], w: number): Row[] {
  const hw = w / 2;
  const top = rows.reduce((a, b) => (b.y > a.y ? b : a));
  // 净缝留 0.15 富余，别卡在「刚好等于球径」这种理论值上
  const step = Math.min(top.step, 2 * top.r + 2 * PHYSICS.ballRadius - 0.15);
  const extra: Row[] = [];

  for (const s of [-1, 1] as const) {
    // 这一排最靠外的钉（gaps 挖掉的洞不算）
    let last = s * top.fromX;
    for (let x = top.fromX; x <= top.toX + 1e-6; x += top.step) {
      if (!top.gaps.some((g) => Math.abs(x - g.x) < g.r)) last = Math.max(last, s * x);
    }
    if (last >= hw - top.r - 1e-6) continue; // 顶排本来就已经贴壁

    for (let x = last + s * step; s * x <= hw - top.r + 1e-6; x += s * step) {
      const prev = x - s * step;
      extra.push({
        y: top.y,
        step: Math.abs(x - prev),
        fromX: Math.min(prev, x),
        toX: Math.max(prev, x),
        r: top.r,
        kind: top.kind,
        stagger: false,
        gaps: [],
      });
    }
  }
  return [...rows, ...extra];
}

/**
 * 5 个区域：跟着盘宽左右分置。
 *
 * 铭牌写「路过 · 充能 +26」而不是「聚气」，是因为**盘面中区是球飞过就触发的带子，
 * 底部才是要瞄准落进去的槽**——两者机制完全不同，但原来盘面两处都印「聚气 / 连斩 /
 * 倍率」，玩家会以为是同一个东西的两份。数字全部读 COMBAT，和结算共用一处定义。
 *
 * 技能区原本摆在 y=17.6 的**最左角**（x=-4.9k），结果公孙胜 / 燕青 / 张顺三个
 * `zoneSkill` 武将**整局放不出技能**：球从底部发射器上来、横向贴着侧壁走，
 * 几乎不经过最左角那个矩形。实测（96 局 / 12 关 / 8 种子，每局进区次数）：
 *   旧位置 y=17.6 角落 → 中位 2 次，只有 19% 的局能凑够 charges=6（≈放不出技能）
 *   改到 y=16 中区   → 中位 8 次，61% 的局能凑够 6（≈多数局能放 1~2 次）
 * 所以技能区下移到球的高密度带（热力图峰值在 y=6 / y=14 / y=23，y=17~19 偏冷），
 * 并从最外角收到 -0.3 半宽处（球流实际走廊在中区，不在角落）。逐关 8 种子终验：
 * **能放技能的关从 2/12 提升到 8/12**（stage_02/03/04/05/07/08/11/12 中位 ≥6）。
 * 剩下 4 关（01/06/09/10）球流本身偏低，要抬上去得把技能区挪到正中心，
 * 但那里和 combo 区垂直重叠会双重触发，且会牺牲 combo 的命中——得不偿失。
 */
function zonesFor(w: number): ZoneDef[] {
  const k = w / 16;
  const hw = w / 2;
  return [
    { id: 'z_energy', x: Number((-5.0 * k).toFixed(3)), y: 14.2, w: 3.0, h: 1.5, kind: 'energy', label: `路过 · 充能 +${COMBAT.zoneEnergyGain}` },
    { id: 'z_boss', x: Number((5.0 * k).toFixed(3)), y: 14.2, w: 3.0, h: 1.5, kind: 'boss', label: `路过 · 破绽标记 ×${COMBAT.markSlotMult}` },
    { id: 'z_combo', x: 0, y: 14.2, w: 3.4, h: 1.5, kind: 'combo', label: `路过 · 连击 +${COMBAT.zoneComboGain}` },
    { id: 'z_skill', x: Number((-0.3 * hw).toFixed(3)), y: 16, w: 3.4, h: 1.6, kind: 'skill', label: `路过 · 技能充能 +${COMBAT.zoneSkillCharge}` },
    // 倍率区**留在原位**（右上角）。它和技能区是同一排的老问题，但倍率区一挪，
    // 球更频繁吃满 ballSlotFactor，对局变短、随机流岔开，stage_02 的超时率从 11% 翻到 16%
    // 直接顶破 smoke 红线——那是 RNG 分叉不是物理退化，但 gate 不会分辨。
    // 技能区是「坏了」（整局放不出），倍率区只是「稀」，优先级不同，本次只修技能区。
    { id: 'z_multiplier', x: Number((4.9 * k).toFixed(3)), y: 17.6, w: 3.0, h: 1.6, kind: 'multiplier', label: `路过 · 落槽 ×${COMBAT.zoneSlotMult}` },
  ];
}

/* ------------------------------------------------------------------ 关卡参数 */

type Row = PegRowDef;
type Form = PegFormationDef;

interface StageSpec {
  id: string;
  name: string;
  subtitle: string;
  /** 剧情一句话，写进关卡铭板 */
  story: string;
  /** 这一关的钉阵在打法上是什么角色 */
  layoutNote: string;
  width: number;
  gravity: number;
  rows: Row[];
  formations: Form[];
  boss: StageDef['boss'];
  rules: StageDef['rules'];
}

/** 确变：默认单关配方，个别关卡再覆盖 */
/**
 * 三幕剥夺阶梯：相位按「少 → 多」逐条叠加，维度只增不减。
 *
 * 旧版每关自带三个 effect（none / shield / frenzy），12 关各写一遍，
 * 结果是三个问题：
 *  1. 「shield」只改一个读不出来的护甲百分比，玩家只觉得这关莫名其妙打不动；
 *  2. 「frenzy」的横向重力没有对应画面，玩家分不清是盘在晃还是自己手滑；
 *  3. 12 关的自由度意味着 12 套手感，调一个数要同时看 12 关的 smoke。
 *
 * 现在只有三个维度（见 constants 的 PHASE），分三幕递进：
 *   第 1–4 关  aim
 *   第 5–8 关  aim + ammo
 *   第 9–12 关 aim + ammo + time
 * 同一幕的三条相位里，后一条必须是前一条的超集：局内不可能出现
 * 「刚打完更难的东西，剥夺反而少了一项」。
 *
 * 手感数字（漂移几倍、球时几折）全在 constants，这里只声明「吃哪几维」。
 */
const PHASE_LADDER: Record<1 | 2 | 3, PhaseDeprivation[][]> = {
  1: [['aim'], ['aim'], ['aim']],
  2: [['aim'], ['aim', 'ammo'], ['aim', 'ammo']],
  3: [['aim', 'ammo'], ['aim', 'ammo', 'time'], ['aim', 'ammo', 'time']],
};

/** 每个维度的一句话。写在这里而不是每关的数据里：文案必须与规则同步。 */
const PHASE_MECH: Record<PhaseDeprivation, string> = {
  aim: '落槽整排漂移加倍，破绽口跟着它跑',
  ammo: '本球时间压到三分之二，救球窗口关闭',
  time: '整盘横向推球，球路不再由你决定',
};

/**
 * 生成一关的相位阶梯。
 *
 * `rows` 只给阈值与风味文案；机械描述由阶梯自己拼上去——
 * 让人手写两遍，数据一旦漏改就会变成「文案说关救球，规则里没关」。
 *
 * 第一幕是 `aim` 常驻而不是「前一条相位什么都不剥」：实测量幕本不该把「一条相位
 * 什么都不剥」当成台阶——玩家看到的是三条相位却只被剥一次，后两条相位就只剩
 * 换文案的作用了。stage_01 走的是单独写死的教学相位（`deprive: []`）。
 */
function phaseLadder(
  act: 1 | 2 | 3,
  rows: { at: number; name: string; desc: string }[],
): BossPhaseDef[] {
  const ladder = PHASE_LADDER[act];
  if (rows.length > ladder.length) throw new Error(`phaseLadder: ${act} 幕最多 ${ladder.length} 条相位`);
  return rows.map((r, i) => {
    const deprive = ladder[i]!;
    const mech = deprive.map((d) => PHASE_MECH[d]).join('；');
    const flavor = r.desc.endsWith('。') ? r.desc : `${r.desc}。`;
    return { at: r.at, name: r.name, deprive, desc: mech ? `${flavor}${mech}。` : flavor };
  });
}

function feverOf(over: Partial<StageDef['rules']['fever']> = {}): StageDef['rules']['fever'] {
  return {
    triggerSlot: 'slot_weak',
    duration: 14,
    bonusBalls: 4,
    slotFactor: 1.2,
    chainStep: 0.2,
    chainMax: 6,
    gate: { w: 6.4, h: 1.1, y: 4.6 },
    armorRelief: 0.28,
    palette: { led: '#ffd24a', yakumono: '#ff9a2e', accent: '#fff0b8' },
    glyph: '確',
    ...over,
  };
}

/**
 * 玩法改成「一颗球反复打」之后，`balls` 这个字段的**含义变了**：
 * 它不再是「有几颗球」，而是「能打几发」。
 *
 * 旧版在这里统一乘 `SHOT_BUDGET_SCALE = 2.4`，理由是「球在盘上要追打 2~4 次」。
 * **现在已经删掉这个倍率**，因为它把预算变成了拍脑袋的常数：
 * 源码里写 18，JSON 里是 43；重拟合预算时对着哪个数改都不对，
 * 而真正的依据——smoke 实测的平均用球——被这一层乘法埋掉了。
 *
 * 现在的规则：**`balls` 就是 smoke 实测平均用球 x 1.6**，直接写。
 * bot 不会瞄，所以 1.6 倍冗余给的是「会瞄的玩家」而不是「刚好能过」。
 * 改动预算后的回归方式：`npm run smoke` 看「平均击射 / 球预算」，
 * 应该稳定在 60% 上下；低于 50% 就是球给多了，高于 75% 就是发紧。
 */

function rulesOf(over: Partial<StageDef['rules']> = {}): StageDef['rules'] {
  const base: StageDef['rules'] = {
    balls: 120,
    comboWindow: 1.7,
    startingEnergy: 20,
    fever: feverOf(),
    enemy: { ...ENEMY_RULES },
    reward: { silver: 320, stones: 90, shards: 2 },
    ...over,
  };
  /*
   * `fever.bonusBalls` 走的是同一条 `ballsLeft` 通道，必须跟着一起放大，
   * 否则確変的奖励会从「一口气多打十几发」缩成「多打两发」，感知不到。
   * `over` 里显式写的 `bonusBalls` 已经是成品数值（如 stage_08 的 6 发），
   * 不该再乘——所以只对默认值加系数。
   */
  const bonusBalls = over.fever?.bonusBalls ?? Math.round(base.fever.bonusBalls * SHOT_BUDGET_SLACK);
  return { ...base, fever: { ...base.fever, bonusBalls } };
}

/**
 * 5 枚敌人钉的固定机位。**每种五行一颗，不再是 8~9 枚的阵。**
 *
 * 之前每颗敌人是 `diamond`/`triangle` 阵，一组就是 8~9 枚，5 组 42 枚——
 * 占掉整块盘面的 46%，逼得关卡自己的钉阵被冲突消解挤掉 18~39 枚。
 * 更要命的是它把 y 16.4 和 y 11.2 两条带整条封掉，上下半场各剩不到
 * 3 个单位的空地，签名阵型没地方摆，最后全堆进 y 20~24 那条带上——
 * 探针实测那一带的滞留时间是别处的三倍，球在那儿来回弹一整局都落不了槽。
 *
 * 改成单颗大钉（r 0.55，是普通钉的两倍粗）之后：
 *   · 盘面空出 37 枚钉，签名阵型终于有地方摆
 *   · 观感也更好——一颗清楚的宝石色大钉，比一团同色小球好认得多
 *   · 五行面板照旧按五行分组，只是每行计数从 8 变成 1
 */
const ENEMY_SLOTS: { x: number; y: number; wuxing: NonNullable<Form['wuxing']>; hp: number }[] = [
  { x: -5.0, y: 17.0, wuxing: 'water', hp: 195 },
  { x: 5.0, y: 17.0, wuxing: 'fire', hp: 221 },
  { x: -3.6, y: 11.0, wuxing: 'wood', hp: 156 },
  { x: 3.6, y: 11.0, wuxing: 'metal', hp: 247 },
  // 土系刻意**偏离中轴**。放在 x=0 时那颗大钉正对着发射口，
  // 探针实测 12 关里有 8 关的头号卡点都是「正中一颗孤钉」——
  // 球从上方下来正好落它背上，四周又没有第二颗钉把它扶住，久了就赖在那儿。
  { x: 2.4, y: 20.6, wuxing: 'earth', hp: 208 },
];

/**
 * 每关小怪枚数。`enemies()` 的排布和 main() 的生成期校验共用这一份数字，
 * 所以「想要几枚」与「实际有几枚」不可能对不上。
 *
 * 取值范围 12~18 是被 perSweep = 0.08 反推的：
 * 满清倍率 = 1 + 枚数 × 0.08 ∈ [1.96, 2.44]。
 * 旧版这个数在 12 关里从 5 跳到 34（满清倍率 2.50~11.20，跨关强度差 4.5 倍），
 * 而它本来只是 `diamond` 硬展开 9 枚再被去重随机削减的副产物。
 *
 * stage_01 不用本表：教学关单独写了 5 枚大钉（r 0.95、血量 ×0.65），
 * 那一关要让玩家一眼认得出「这是小怪」，形状本身就是教学。
 */
const ENEMY_TOTAL_BY_STAGE: Record<string, number> = {
  stage_02: 12, stage_03: 13, stage_04: 13, stage_05: 14, stage_06: 14,
  stage_07: 15, stage_08: 16, stage_09: 16, stage_10: 17, stage_11: 18, stage_12: 18,
};

/** 默认小怪枚数。仅在表里查不到关卡 id 时兜底，正常每关都显式给值。 */
const ENEMY_TOTAL = 14;

/**
 * 满清倍率——**唯一的设计量**，perSweep 由它反推。
 *
 * 旧版把 `perSweep` 定成 0.3、再靠改小怪个数去凑强度，结果 12 关的满清倍率
 * 在 2.50~11.20 之间摇（跨关强度差 4.5 倍），难度顺序跟着小怪个数乱跳。
 * 而实际枚数又不是设计出来的——旧 `enemies()` 用 `shape: 'diamond'`，
 * `pushFormation` 的 `case 'diamond'` 写死 9 枚、完全不看 `count`，
 * 于是每关名义 5 枚实铺 45 枚，再被去重随机削掉一部分，
 * 12 关最后是 5/31/25/27/29/21/14/29/34/29/34/14 这种和设计无关的数。
 *
 * 改成反过来：**先定满清倍率，再按实际枚数反算汇率**。
 * 于是「清场换伤害」成为跨关恒定的交易（×2.2），实际枚数只影响盘面疏密
 * 和半清的节奏，不再决定强度。窄盘放不下 12 枚时也就只是枚数少一点，
 * 不会把倍率拉歪。
 */

/**
 * 一次「合格弱口」的参考伤害，以及玩家质量系数。
 *
 * 三个乘区各有出处：
 *  · 210   —— 破绽口槽底值（`slotsFor`）
 *  · 4.2   —— 槽倍率上限（`COMBAT.slotMultCap`）
 *  · 2.2   —— 满清倍率（`SWEEP_MAX`）
 *
 * 4.2 不是拍脑袋的：**smoke 标定实测** 12 关的合格弱口归一倍数是 3.98~4.20，
 * 也就是这个 bot 打出的每一次弱口都已经撞在上限上（见
 * `scripts/smoke.ts` 的 `printCalibration`）。倍率体系已经没有余量，
 * 「一次弱口值多少」在跨关意义上是个常数，这才是公式能成立的前提。
 * 换句话说：先量到上限被吃满，才敢把 Boss 血量写成一次公式的产物。
 */
const WEAK_HIT_REF = 210 * COMBAT.slotMultCap * SWEEP_MAX;

/**
 * 玩家质量系数：真实玩家打出的合格弱口，平均只有「满倍」的 75%。
 *
 * 少了这一项，全曲线会集体偏松——bot 每次都撞上限 4.2，
 * 拿它当玩家去算血量，定出来的是**满级玩家**的关卡，不是普通玩家的。
 */

/**
 * 每关的目标「合格弱口次数」——**唯一的难度轴**，Boss 血量由它反推。
 *
 * 旧版是 12 个人手调的 maxHp（1800~18000），跟球预算、盘宽、机制相位各走各的，
 * 于是理论最少球在 0.8~5.9 之间乱跳、非单调（第 7 关 2.8 比第 9 关 1.5 还高）。
 * 现在血量 = pull × 一次弱口的参考伤害 × PLAYER_QUALITY × layout × (1 - armor)。
 *
 * `pull` 的含义是**玩家实际会打出的合格弱口次数**，不是满效率下的次数：
 * 每次弱口只有满倍伤害的 75%，同样的 pull 次只能打出 75% 的伤害，
 * 所以血量要跟着乘 0.75。于是理论最少球 = pull × PLAYER_QUALITY × layout
 * （≈ pull × 0.75），严格单调是构造出来的，不是调出来的。
 *
 * 取值 3~14：一次弱口约 1455 有效伤害，所以血量落在 4.3k~16.3k。
 * 上限 14 而不是更高，是因为 weak 口每 5 颗球才落得进一颗，
 * 拉到 30 就得 150 颗球的关卡，与球预算的量级彻底脱节。
 */
const PULL_BY_STAGE: Record<string, number> = {
  stage_01: 3, stage_02: 4, stage_03: 5, stage_04: 6, stage_05: 7, stage_06: 8,
  stage_07: 9, stage_08: 10, stage_09: 11, stage_10: 12, stage_11: 13, stage_12: 14,
};

/**
 * 盘面对 Boss 伤害效率的补偿系数（默认 1）。
 *
 * `pull` 是**设计难度轴**（要打多少次破绽口），但 Boss 的血并不只从破绽口掉：
 * 连锁引爆、落槽、武器摧毁都算，而这三样有多少，取决于盘面阵型会不会反复
 * 触发钉击。实测（bot，12 局 / 每关 120 球无截断）：
 *
 *   第 11 关 `funnel/spiral`：3.0 次弱口就收工，血 15500
 *   第 9 关 `chevron/hex`  ：8.0 次弱口才收工，血 13450
 *
 * 同为「血更少、难度轴更早」的第 9 关，实际用球 43 个，是第 10 关（25）的
 * 一倍半。**盘面阵型在这里直接决定了 Boss 强度**，难度轴是断的。
 *
 * 两条路：换掉第 9 关的双斧+蜂窝（但那是它的设定身份），或者承认这个补偿。
 * 这里选后者，并且只给这一关开——系数有名字、有实测依据、可回归。
 * 以后换阵型时只要重跑 smoke 看第 9 关的用球，把这个数改回去即可。
 */
const LAYOUT_BOSS_FACTOR: Record<string, number> = {
  // 双斧+蜂窝不产出连锁 Boss 伤害，实测按 0.72 折算
  stage_09: 0.72,
  /*
   * 盘宽 14 + chevron/wall/cross：全 12 关里**合格弱口最少**的一关（0.8 次/局，
   * 其余关卡 1.8~3.4）。难度轴写的是 4 次弱口收工，实测中位数 14 发收工、尾部
   * 一局打 30 发还剩 13% Boss 血。
   *
   * 尾部卡住不是球不够，是**每发的期望伤害低**——跟第 9 关同一种病：盘面阵型
   * 决定能打出多少 Boss 伤害，而难度轴（PULL）是按「弱口次数」定的，两者没对齐。
   * 这里照第 9 关的先例，把血按实测折算，不去动 PULL（那是全局难度轴）。
   */
  stage_02: 0.75,
};

/** 由目标弱口次数反推 Boss 血量。取整到 50，让 JSON 里的数保持人眼可读。 */
function bossHpFor(id: string, armor: number): number {
  const pull = PULL_BY_STAGE[id];
  if (pull === undefined) throw new Error(`${id} 没有登记 PULL_BY_STAGE，难度轴就断了`);
  const layout = LAYOUT_BOSS_FACTOR[id] ?? 1;
  return Math.round((pull * WEAK_HIT_REF * PLAYER_QUALITY * (1 - armor) * layout) / 50) * 50;
}

/** 小怪 r。与 `ENEMY_RULES` / `enemies()` 保持一致，改一处就要同步。 */
const ENEMY_R = 0.55;

/**
 * 小怪落点的最高 y。
 *
 * 这个上限**试过收紧到 22，没通过**：窄盘（stage_07 盘宽只有 12）直接放不下
 * 小怪（实测只剩 1 枚），清场内容被抽空，比两个长尾局更糟。
 *
 * 根因是 `reachableCells` 的洪泛只是**必要**条件：顶排与侧壁之间那条 1.94 宽的
 * 竖直通道通到 y=27，判据会放行，但球顺上去以后就被侧壁和顶排夹死。
 * 实测 stage_06 死局剩的那枚小怪在 (-5.655, 24.2)，stage_10 在 (-1.855, 21.8)。
 *
 * 收敛到 y=24 能躲开前者、躲不开后者，证明「压高度」不是正确判据——
 * 真正要判的是**球能不能真的撞到**。这一版的决定是：落点范围不动，
 * 那两个长尾改由球预算吸收（见 `rules.balls`），并在 smoke 里作为硬断言盯着。
 */
const ENEMY_MAX_Y = 27;

/**
 * 按**真实占位**给小怪找落点，代替写死的坐标。
 *
 * 为什么不能写坐标：`expandStage` 的「相交消解」是先到先得，作者写在后面的
 * 敌人钉一旦和前面的钉相交就会被整枚丢掉，而丢多少取决于那一关的阵型长什么样。
 * 旧版实测 stage_07 请求 15 枚只活下来 4 枚、stage_06 请求 14 枚活下来 6 枚——
 * 于是满清倍率也跟着掉，难度顺序彻底乱掉。
 * 坐标是按最空的那一关调的，放到窄盘和密集阵型上就失效。
 *
 * 所以改成现算：先展开一次「不含小怪」的盘面拿到真实占位（连运行时补的入替钉
 * 也在内），再在候选网格里挑净空最大的 N 个点。
 *
 * 三条取舍：
 *  · 净空门限 0.5 —— 相交消解的门限是 `r_self + r_other + 0.02 = 0.85`，
 *    留 0.5 已经远超它。再高就放不下了：横排钉间距 2.6、钉 r 0.28，
 *    两颗钉正中间的最大净空只有 1.3 - 0.83 = 0.47，所以 0.9 门限下
 *    小怪根本钻不进钉排的缝里（实测 12 关只剩 3~12 枚）。
 *  · 彼此间距 1.8 —— 小怪钉 r 0.55，1.8 意味着球还能从两枚之间钻过去；
 *    再贴就变成一颗巨型障碍，清场门槛反而变高。
 *  · 分层限流（每 3.6 高最多 ceil(N/5) 枚）—— 纯按净空排序会把小怪全堆在
 *    盘面最空的那一角，看起来像 bug 而不是关卡设计。
 *  · **必须打得到**（`reachableCells`）—— 净空只看得到周围有没有钉，
 *    看不到「球能不能走到」。一处被钉阵封死的空腔对净空检查是完美的，
 *    对玩家是永远打不掉的钉：清场变成通关条件之后，那就是一堵必输的墙。
 *    smoke 用 400 球探针测出 stage_06/09/10 即使球无限也赢不了，
 *    就是这个漏洞。放之前先洪泛标出球的可达域，只在可达域旁边放。
 */
/**
 * 洪泛出「球能进得去」的自由格。
 *
 * 物理上球是可反弹的，所以真实可达域比自由空间大；但本作的球从底部进场、
 * 被钉阵围出来的空腔一旦封死就永远进不去，所以用自由空间洪泛是一个**充分
 * 而偏保守**的判据——宁可放过一处实际能打的空腔，也不要放进一颗打不到的钉。
 *
 * 格子对每颗钉按 `r_peg + ballRadius` 膨胀，种子取底部发射带上方的整行。
 * 返回 `Set<key>`，key 是 `${ix},${iy}`。
 */
function reachableCells(pegs: readonly { x: number; y: number; r: number }[], opts: {
  xLo: number; xHi: number; yLo: number; yHi: number; step: number; seedY: number;
}): Set<string> {
  const { xLo, xHi, yLo, yHi, step, seedY } = opts;
  const nx = Math.ceil((xHi - xLo) / step) + 1;
  const ny = Math.ceil((yHi - yLo) / step) + 1;
  const free: boolean[] = new Array(nx * ny).fill(true);
  const at = (ix: number, iy: number) => iy * nx + ix;

  for (let iy = 0; iy < ny; iy++) {
    const y = yLo + iy * step;
    for (let ix = 0; ix < nx; ix++) {
      const x = xLo + ix * step;
      if (x < xLo || x > xHi || y < yLo || y > yHi) continue;
      for (const p of pegs) {
        // 球心与钉心至少要有 r + ballR，球才碰得到钉；碰不到就是空地
        if (Math.hypot(p.x - x, p.y - y) < p.r + PHYSICS.ballRadius) { free[at(ix, iy)] = false; break; }
      }
    }
  }

  const seen = new Set<string>();
  const stack: [number, number][] = [];
  const iySeed = Math.max(0, Math.round((seedY - yLo) / step));
  for (let ix = 0; ix < nx; ix++) {
    if (free[at(ix, iySeed)]) { stack.push([ix, iySeed]); seen.add(`${ix},${iySeed}`); }
  }
  while (stack.length) {
    const [ix, iy] = stack.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const jx = ix + dx;
      const jy = iy + dy;
      if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
      if (!free[at(jx, jy)]) continue;
      const key = `${jx},${jy}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stack.push([jx, jy]);
    }
  }
  return seen;
}

/** 盘面结构区的最高点。用于「内容在哪一段盘上」，排除收口与空区。 */
function topYOf(pegs: readonly { y: number }[], yBot: number): number {
  let top = -Infinity;
  for (const p of pegs) if (p.y > yBot && p.y > top) top = p.y;
  return top;
}

function placeEnemies(spec: StageSpec): number {
  const forms = spec.formations.filter((f) => f.kind === 'enemy');
  // stage_01 的 5 枚大钉是教学关自己写的（r 0.95、血量 ×0.65），位置已验证过，不动
  if (!forms.length) return 0;
  if (spec.id === 'stage_01') return forms.length;

  const withoutEnemies = { ...spec, formations: spec.formations.filter((f) => f.kind !== 'enemy') };
  const probe = expandStage(buildStage(withoutEnemies));
  const halfSpan = Math.min(probe.playLeftX, probe.playRightX) - 1.1;
  const yLo = BOTTOM.keepOutY + 1.4;

  // 球的可达域。网格与候选点用同一套步长，判据才能直接写成「相邻可达格」。
  const STEP = 0.35;
  const reach = reachableCells(probe.pegs, {
    xLo: -halfSpan, xHi: halfSpan, yLo, yHi: 27, step: STEP,
    seedY: yLo + 0.2,
  });
  const reachCell = (x: number, y: number): boolean => {
    const r = ENEMY_R + PHYSICS.ballRadius;
    const ix = Math.round((x - -halfSpan) / STEP);
    const iy = Math.round((y - yLo) / STEP);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (reach.has(`${ix + dx},${iy + dy}`)) {
          const cx = -halfSpan + (ix + dx) * STEP;
          const cy = yLo + (iy + dy) * STEP;
          if (Math.hypot(cx - x, cy - y) <= r) return true;
        }
      }
    }
    return false;
  };

  type Cand = { x: number; y: number; clear: number };
  /*
   * 候选点不越过 `ENEMY_MAX_Y`，也不越过「钉阵主体区顶部 − 2.5」。
   *
   * 上界为什么必须跟结构走：盘面顶部那一段本来就没有钉，球能上去、却没有任何
   * 结构让它拐回来，落上去的小怪只能靠球浪偶然打中。实测 smoke 的死局残怪全部
   * 落在中央区顶部（stage_02 / 08 / 09 / 10 / 12），把球预算从 46 加到 55、
   * 从 72 加到 80 一点用都没有——球根本不去那儿。
   *
   * `ENEMY_MAX_Y` 只作总上限兜底（窄盘关卡的钉阵本来就矮）。
   */
  const yHi = Math.min(
    ENEMY_MAX_Y,
    Math.max(yLo + 2, topYOf(probe.pegs, BOTTOM.keepOutY) - 2.5),
  );
  const cands: Cand[] = [];
  for (let y = yLo; y <= yHi; y += 0.4) {
    for (let x = -halfSpan; x <= halfSpan; x += 0.35) {
      let clear = Math.min(halfSpan - Math.abs(x), y - yLo);
      for (const p of probe.pegs) {
        clear = Math.min(clear, Math.hypot(p.x - x, p.y - y) - (p.r + ENEMY_R));
      }
      if (clear >= 0.5 && reachCell(x, y)) cands.push({ x, y, clear });
    }
  }
  // 先按净空降序，再按 y 降序（同一净空时把上面的先放，下面的留出通道）
  cands.sort((a, b) => b.clear - a.clear || b.y - a.y);

  const bandCap = Math.max(2, Math.ceil(forms.length / 5));
  const chosen: Cand[] = [];
  const bandOf = (y: number): number => Math.floor((y - yLo) / 3.6);
  for (const c of cands) {
    if (chosen.length === forms.length) break;
    if (chosen.filter((q) => bandOf(q.y) === bandOf(c.y)).length >= bandCap) continue;
    if (chosen.some((q) => Math.hypot(q.x - c.x, q.y - c.y) < 1.8)) continue;
    chosen.push(c);
  }
  /*
   * 放不满时**不报错**，按实际放下的枚数算汇率（见 `resolvePerSweep`）。
   * 窄盘（stage_07 盘宽 12）物理上就装不下 12 枚 r=0.55 的钉还留出球道——
   * 为难生成器没有意义，倍率恒定之后枚数也不再决定强度。
   * 放不下的表单要从 formations 里删掉，否则会残留 (0,0) 的幽灵钉。
   */
  chosen.sort((a, b) => b.y - a.y || a.x - b.x);
  forms.forEach((f, i) => {
    const c = chosen[i];
    if (!c) return;
    f.cx = Number(c.x.toFixed(3));
    f.cy = Number(c.y.toFixed(3));
  });
  const kept = forms.slice(0, chosen.length);
  if (kept.length !== forms.length) {
    spec.formations = spec.formations.filter((f) => !forms.includes(f) || kept.includes(f));
  }
  return kept.length;
}

/**
 * 按实际小怪枚数反推 perSweep，把满清倍率钉在 SWEEP_MAX。
 *
 * 必须在 `expandStage` **之后**算：枚数要按消解后的真实结果数，
 * 而不是按请求数。反过来做就又会回到「名义 5 枚实铺 45 枚」的老路。
 */
function resolvePerSweep(def: StageDef, enemyCount: number): number {
  if (enemyCount <= 0) throw new Error(`${def.id} 一枚小怪都没有，满清倍率无从定义`);
  return Number(((SWEEP_MAX - 1) / enemyCount).toFixed(4));
}

/**
 * 敌人钉的伤害经济。**这组数是被钉板数量倒逼出来的，不能照抄旧值。**
 *
 * 旧版每种五行是一组 8~9 枚的阵，全盘 38 枚敌人钉；smoke 实测它们贡献了
 * 231 次钉击里的约 33 次，却带来了绝大部分伤害（敌人命中 26~56，普通钉命中 ~1）。
 * 改成单颗大钉后只剩 5 枚，钉击直接掉到 184，全场伤害几乎腰斩——
 * 单卡武松的胜率从 43% 掉到 0%。
 *
 * 所以「把 38 枚缩成 5 枚」必须同时把**单次命中的收益**补回来：
 *   · r 0.42 → 0.75：碰撞截面 2r 宽了 1.8 倍，命中频率跟着涨
 *   · baseDamage / perBounce 一并上调约 2.4 倍
 *   · hp 上调 1.3 倍：命中的次数多了，总伤害持平，不需要更多次才能击坠
 *
 * `killDamage`（击坠一枚直接扣 110 点 Boss 血）已删，改成 `perSweep` 倍率：
 * **倍率跟着玩家实际打出的 Boss 伤害走，而旧的那个固定值不跟**——12 关 Boss 血
 * 从 1800 到 18000，固定 110 在第一关是 30% 血、在第十二关只有 0.6%，同一份数据
 * 在两端差了 50 倍。倍率天然按关卡缩放，这一条就不用手工再配一遍 12 遍。
 */
const ENEMY_RULES = {
  baseDamage: 62,
  perBounce: 22,
  bounceMax: 12,
  attrWin: 1.5,
  attrGen: 1.2,
  attrLose: 0.7,
  critChance: 0.22,
  critMult: 2.2,
  killBoost: 4.4,
  /**
   * 每清空一枚小怪，之后对 Boss 的伤害加成。**占位值，运行时会被覆写。**
   *
   * 设计量是 `SWEEP_MAX`（满清倍率 ×2.2），汇率由它和实际小怪枚数反推：
   * `perSweep = (SWEEP_MAX - 1) / 实际枚数`。真正写进 JSON 的值是
   * `main()` 里 `resolvePerSweep()` 算的，必须在 `expandStage` 之后才算 ——
   * 枚数要按消解后的真实结果数，反过来做就又回到旧版的老路。
   *
   * 旧值 0.3 乘上实际小怪数（5~34 枚）之后，满清倍率在 12 关里从 ×2.50 摇到 ×11.20：
   * 同一套 build 跨关强度差 4.5 倍，难度顺序也跟着小怪个数乱跳（第 7、11 关
   * 是两处凹点）。0.08 把满清倍率钉在 ×1.96 ~ ×2.44（12~18 枚），
   * 「清场换伤害」从此是一个跨关可预期的交易，而不是隐藏的 ×4.5 大招。
   * 见 docs/superpowers/reviews/2026-10-10-level-core-plan.md 第 2.2 节。
   */
  perSweep: 0.08,
  /** 全清时额外的一次 Boss 伤害。各关按 Boss 血量的 5% 生成，见 main() */
  fullSweepDamage: 90,
  /** 击射用尽时每剩一枚小怪扣多少最终得分 */
  leftoverPenalty: 0.06,
};

/**
 * 小怪排布：**枚数是设计参数，位置是算出来的**。
 *
 * 旧写法是每种五行给一个 `shape: 'diamond'`。但 `pushFormation` 里
 * `case 'diamond'` 是写死的 9 个偏移、**完全不看 `count`**（board.ts:259），
 * 于是每关名义上 5 枚、实际铺 45 枚，再被去重和相交消解随机吃掉一部分——
 * 12 关的小怪数因此变成 5/31/25/27/29/21/14/29/34/29/34/14 这种
 * 和关卡设计毫无关系的数。它是排版副产物，不是难度选择。
 *
 * 现在改成**分层排 N 枚**，每枚一个 `lattice count:1 rows:1`（正好 1 颗钉），
 * 枚数就是枚数。位置按盘宽等比收放，窄盘（stage_07 宽 12）不会被甩到墙里。
 *
 * 分层的 y 必须落在**横排钉之间的空档**：`expandStage` 的「相交消解」是
 * 先到先得，作者写在后面的敌人钉一旦和前面的钉相交就会被整枚丢掉。
 * 12 关的横排钉固定在 y = 8.0 / 12.4 / 15.6 / 20.0 / 24.0，
 * 于是可用的空档中心就在这几处；排到排上，枚数会被随机吃掉一部分
 * （第一版就这么把 12~18 枚吃成了 5~14 枚）。
 * 敌人 r=0.55、横排钉 r=0.28，相交门限是 0.83；下面的 y 都留了 ≥1.1 的净空。
 *
 * `ENEMY_SLOTS` 里那条「土系刻意偏离中轴」的教训仍然成立：
 * 正对着发射口、四周又没有第二颗钉扶着的那颗，会变成球赖着不走的卡点。
 * 所以同一层内 x 均分且**不取 0**，中轴留给入替区。
 */
const ENEMY_BAND_Y = [17.4, 10.6, 21.6];

function enemies(id: string, k: number, hpScale = 1): Form[] {
  const total = ENEMY_TOTAL_BY_STAGE[id] ?? ENEMY_TOTAL;
  const order = ENEMY_SLOTS.map((e) => e.wuxing);
  const span = Math.min(5.4, k * 5.2);
  return Array.from({ length: total }, (_, i) => {
    const slot = ENEMY_SLOTS[i % ENEMY_SLOTS.length]!;
    const band = i % ENEMY_BAND_Y.length;
    // 同层内第几颗：用来在该层内均分 x，并保证同一颗钉不会被摆两次
    const rank = Math.floor(i / ENEMY_BAND_Y.length);
    const perBand = Math.ceil((total - band) / ENEMY_BAND_Y.length);
    const t = perBand <= 1 ? 0.5 : rank / (perBand - 1);
    // 取 ±span 上 78% 的宽度，避开墙；同时让最左/最右不贴边
    const x = (t - 0.5) * 2 * span * 0.78;
    return {
      id: `en_${slot.wuxing}_${i}`,
      shape: 'lattice' as const,
      count: 1,
      rows: 1,
      cx: Number(x.toFixed(3)),
      cy: ENEMY_BAND_Y[band]!,
      r: 0.55,
      kind: 'enemy' as const,
      hp: Math.round(slot.hp * hpScale),
      wuxing: order[i % order.length]!,
      score: Math.round(slot.hp * hpScale * 1.7),
      label: order[i % order.length]!,
    };
  });
}
/** 一行横排钉。gaps 是 [x, 半径][] —— 写 [0, 1.8] 就是正中开一个 3.6 宽的洞。 */
function row(
  y: number,
  step: number,
  fromX: number,
  toX: number,
  r: number,
  kind: Row['kind'],
  stagger: boolean,
  ...gaps: [number, number][]
): Row {
  return { y, step, fromX, toX, r, kind, stagger, gaps: gaps.map(([x, rr]) => ({ x, r: rr })) };
}

/* ------------------------------------------------ 阵型速写 —— 12 关的真正差异 */

const cross = (id: string, cx: number, cy: number, r: number, kind: Form['kind']): Form => ({
  id, shape: 'cross', cx, cy, r, kind, arms: 4, label: id,
});
const wall = (id: string, cx: number, cy: number, r: number, kind: Form['kind'], count: number): Form => ({
  id, shape: 'wall', cx, cy, r, kind, count, label: id,
});
const chevron = (
  id: string, cx: number, cy: number, r: number, kind: Form['kind'], count: number, angleDeg: number,
): Form => ({ id, shape: 'chevron', cx, cy, r, kind, count, angleDeg, label: id });
const hex = (
  id: string, cx: number, cy: number, r: number, kind: Form['kind'], count: number, rows: number,
): Form => ({ id, shape: 'hex', cx, cy, r, kind, count, rows, label: id });
const spiral = (
  id: string, cx: number, cy: number, r: number, kind: Form['kind'], turns: number, phase: number,
): Form => ({ id, shape: 'spiral', cx, cy, r, kind, turns, phase, label: id });
const funnel = (
  id: string, cx: number, cy: number, r: number, kind: Form['kind'], count: number, angleDeg: number, span: number,
): Form => ({ id, shape: 'funnel', cx, cy, r, kind, count, angleDeg, span, label: id });
const wave = (
  id: string, cx: number, cy: number, r: number, kind: Form['kind'],
  count: number, amp: number, waveLen: number, wavePhase: number,
): Form => ({ id, shape: 'wave', cx, cy, r, kind, count, amp, waveLen, wavePhase, label: id });
const stair = (
  id: string, cx: number, cy: number, r: number, kind: Form['kind'], count: number, perStep: number,
): Form => ({ id, shape: 'stair', cx, cy, r, kind, count, perStep, label: id });
const ring = (
  id: string, cx: number, cy: number, r: number, kind: Form['kind'], rings: number, phase: number,
): Form => ({ id, shape: 'ring', cx, cy, r, kind, rings, phase, label: id });
const lattice = (
  id: string, cx: number, cy: number, r: number, kind: Form['kind'], count: number, rows: number,
): Form => ({ id, shape: 'lattice', cx, cy, r, kind, count, rows, phase: 1, label: id });

const WUXING_NAME: Record<string,string> = { water: '水兽', fire: '火鸦', wood: '木灵', metal: '金甲卫', earth: '镇岳使' };

const SPECS: StageSpec[] = [
  {
    id: 'stage_01',
    name: 'Celestial · 第一阵',
    subtitle: '先学蓄力，再看金环',
    story: '镇山母虎守住中央破绽口。三将同行，先摸清这一盘的发射、救球与技能。',
    layoutNote: '教学关。六排疏钉、五个独立敌人、三枚万金钉；瞄准中央破绽口，金环亮时有限救球。',
    width: 28,
    gravity: -74,
    rows: [
      row(28.6, 2.6, -7.8, 7.8, 0.28, 'normal', false, [0, 1.3]),
      row(24.0, 2.6, -7.8, 7.8, 0.28, 'normal', true, [0, 1.1]),
      row(20.0, 2.6, -7.8, 7.8, 0.28, 'normal', false, [2.4, 1.2]),
      row(15.6, 2.6, -7.8, 7.8, 0.28, 'normal', true),
      row(12.4, 2.6, -7.8, 7.8, 0.28, 'normal', false),
      row(8.0, 2.6, -7.8, 7.8, 0.28, 'destructible', true, [0, 1.2]),
    ],
    formations: [
      ...ENEMY_SLOTS.map((e) => ({
        id: `en_${e.wuxing}`, shape: 'lattice' as const, count: 1, rows: 1,
        cx: e.x, cy: e.y, r: 0.95, kind: 'enemy' as const,
        hp: Math.round(e.hp * 0.65), wuxing: e.wuxing, score: 180, label: WUXING_NAME[e.wuxing],
      })),
      { id: 'gold_l', shape: 'lattice', count: 1, rows: 1, cx: -6.2, cy: 13.9, r: 0.32, kind: 'golden', label: '万金钉' },
      { id: 'gold_r', shape: 'lattice', count: 1, rows: 1, cx: 6.2, cy: 13.9, r: 0.32, kind: 'golden', label: '万金钉' },
      { id: 'gold_m', shape: 'lattice', count: 1, rows: 1, cx: 0.6, cy: 7.0, r: 0.32, kind: 'golden', label: '万金钉' },
      { id: 'spear_l', shape: 'lattice', count: 1, rows: 1, cx: -2.6, cy: 22.0, r: 0.34, kind: 'spear', label: '枪阵' },
      { id: 'spear_r', shape: 'lattice', count: 1, rows: 1, cx: 4.8, cy: 22.0, r: 0.34, kind: 'spear', label: '枪阵' },
      { id: 'spear_ml', shape: 'lattice', count: 1, rows: 1, cx: -4.0, cy: 19.0, r: 0.34, kind: 'spear', label: '枪阵' },
      { id: 'spear_mr', shape: 'lattice', count: 1, rows: 1, cx: 4.0, cy: 19.0, r: 0.34, kind: 'spear', label: '枪阵' },
      { id: 'weak_mouth', shape: 'lattice', count: 1, rows: 1, cx: 0, cy: 5.8, r: 0.32, kind: 'weak', label: '破绽钉' },
    ],
    boss: {
      id: 'boss_jingyang', name: '镇山母虎', title: '第一阵 · 守将',
      maxHp: bossHpFor('stage_01', 0),
      armor: 0,
      weakPoint: { x: 0, y: 3.1, r: 1.25 },
      phases: [{ at: 1.0, name: '镇守', desc: '瞄准破绽，学会蓄力与救球。', deprive: [] }],
      colors: { body: '#2b3550', trim: '#ff5470', glow: '#ff8a5c' },
    },
    rules: { ...rulesOf(), balls: 14, startingEnergy: 40, skillChargeScale: 0.4,
      fever: { ...feverOf(), bonusBalls: 3 },
    },
  },

  /* ---------------------------------------------------------------- 02 */
  {
    id: 'stage_02',
    name: '渭州 · 镇关西',
    subtitle: '三拳打不死，反倒惹了官司',
    story: '鲁提辖为金翠莲三拳打死镇关西。盘子窄得像酒馆的一条巷子，两把雪炮从两侧把球往中间赶。',
    layoutNote: '窄盘 14。雪炮双翼架在中场，张开的臂把球一路往盘心推，落进中央破绽口。',
    width: 14,
    gravity: -74,
    rows: [
      row(26.5, 2.7, -5.4, 5.4, 0.27, 'normal', false, [0, 1.8]),
      row(22.6, 2.4, -5.8, 5.8, 0.27, 'normal', true, [0, 2.0]),
      row(14.2, 2.2, -5.8, 5.8, 0.26, 'armored', true, [-3.0, 1.2], [3.0, 1.2]),
      row(9.0, 2.7, -5.6, 5.6, 0.27, 'destructible', false, [0, 1.5]),
    ],
    formations: [
      chevron('cannon_l', -4.2, 17.6, 0.27, 'spear', 4, 58),
      chevron('cannon_r', 4.2, 17.6, 0.27, 'spear', 4, 58),
      wall('rail_m', 0, 12.2, 0.26, 'armored', 6),
      cross('gold_l', -4.8, 13.4, 0.27, 'golden'),
      cross('gold_r', 4.8, 13.4, 0.27, 'golden'),
      cross('weak_mouth', 0, 6.6, 0.3, 'weak'),
      ...enemies('stage_02', 0.875, 0.85),
    ],
    boss: {
      id: 'boss_zhengtu',
      name: '镇关西',
      title: '渭州 · 屠户',
      maxHp: bossHpFor('stage_02', 0.08),
      armor: 0.08,
      weakPoint: { x: 0, y: 3.1, r: 1.2 },
      phases: phaseLadder(1, [
        { at: 1.0, name: '横肉', desc: '一盆酒泼在盘子中央，球走到哪儿他跟到哪儿' },
        { at: 0.6, name: '泼皮', desc: '泼皮一叉腰，落槽开始自己跑' },
        { at: 0.3, name: '发飙', desc: '抡起板斧横劈，这颗球的时间也短了一截' },
      ]),
      colors: { body: '#4a2a1c', trim: '#ffb347', glow: '#ff7043' },
    },
    rules: rulesOf({
      /*
       * 球预算 21 → 25。
       *
       * 这一关是 12 关里最窄的（宽 14）且超时率最高，方差也最大：
       * 12 局里最快 5 发收工、最慢一局打了 25 发还剩 13% Boss 血。
       *
       * 预算原来是按均值 × 1.6 给的（见 SHOT_BUDGET_SLACK），可 1.6 倍管的是
       * 「关卡难度的冗余」，不是「bot 手气的冗余」——这一关的手气方差就有 5 倍。
       * 尾部局照样能把球用光却收不了工（残怪 0，纯牌不够），所以这里按
       * 尾部而不是均值给冗余：均值 15 发，预算 30 = 2 倍。
       */
      balls: 30,
      reward: { silver: 360, stones: 100, shards: 2 },
    }),
  },

  /* ---------------------------------------------------------------- 03 */
  {
    id: 'stage_03',
    name: '汴梁 · 风雪山神庙',
    subtitle: '那一夜风雪，大到看不见人',
    story: '林冲发配沧州，止不住脚步要回东京。风雪山神庙里，他才知道自己已经被逼到了哪一步。',
    layoutNote: '宽盘 18 + 低重力。蜂窝密排 + 一条螺线：蜂窝决定路难选，螺线负责把球一路搅到底。',
    width: 18,
    gravity: -62,
    rows: [
      row(27.0, 3.0, -7.4, 7.4, 0.26, 'normal', false, [0, 1.9]),
      row(22.4, 2.7, -7.6, 7.6, 0.26, 'normal', true, [0, 2.2]),
    ],
    formations: [
      hex('hex_a', -5.8, 19.4, 0.25, 'normal', 3, 3),
      hex('hex_b', 5.8, 19.4, 0.25, 'normal', 3, 3),
      spiral('spir_m', 0, 14.6, 0.26, 'spear', 2, 0.5),
      hex('hex_c', -4.6, 11.6, 0.25, 'normal', 3, 2),
      hex('hex_d', 4.6, 11.6, 0.25, 'normal', 3, 2),
      cross('gold_m', 0, 13.4, 0.27, 'golden'),
      cross('weak_mouth', 0, 6.4, 0.3, 'weak'),
      ...enemies('stage_03', 1.125, 0.9),
    ],
    boss: {
      id: 'boss_linjiao',
      name: '林教头',
      title: '汴梁 · 禁军教头',
      maxHp: bossHpFor('stage_03', 0.12),
      armor: 0.12,
      weakPoint: { x: 0, y: 3.1, r: 1.3 },
      phases: phaseLadder(1, [
        { at: 1.0, name: '识破', desc: '一眼看穿来路，盘上的钉子开始自己挪位' },
        { at: 0.65, name: '风雪', desc: '风雪掩面，落槽整排顺着风往一边跑' },
        { at: 0.3, name: '逼上梁山', desc: '雪压塌了山神庙，落槽跑得比人跑得还快' },
      ]),
      colors: { body: '#26364f', trim: '#8fd6ff', glow: '#c9ecff' },
    },
    rules: rulesOf({
      balls: 22,
      comboWindow: 2.0,
      fever: feverOf({ duration: 16, chainStep: 0.24 }),
      reward: { silver: 400, stones: 110, shards: 2 },
    }),
  },

  /* ---------------------------------------------------------------- 04 */
  {
    id: 'stage_04',
    name: '东平府 · 七星聚义',
    subtitle: '一坛生辰纲，智取',
    story: '吴用下蒙汗药，梁山七人扮作枣客。盘子上方一道大漏斗，把所有球都收进正中那条线里。',
    layoutNote: '上漏斗收口 + 中段两道正弦波带。漏斗决定「必须走中路」，波带决定走中路之后往哪边甩。',
    width: 16,
    gravity: -74,
    rows: [
      row(27.0, 2.7, -6.4, 6.4, 0.26, 'normal', false, [0, 1.8]),
      row(6.0, 2.8, -6.4, 6.4, 0.26, 'normal', false, [0, 1.4]),
    ],
    formations: [
      funnel('fun_up', 0, 24.0, 0.26, 'spear', 5, 64, 12.0),
      wave('wave_a', 0, 17.4, 0.26, 'normal', 9, 1.0, 7, 0),
      wave('wave_b', 0, 12.6, 0.26, 'armored', 9, 1.0, 7, Math.PI),
      wall('rail_l', -5.2, 10.4, 0.26, 'armored', 4),
      wall('rail_r', 5.2, 10.4, 0.26, 'armored', 4),
      cross('gold_l', -3.4, 13.4, 0.27, 'golden'),
      cross('gold_r', 3.4, 13.4, 0.27, 'golden'),
      cross('weak_mouth', 0, 6.8, 0.3, 'weak'),
      ...enemies('stage_04', 1, 0.95),
    ],
    boss: {
      id: 'boss_shengchengang',
      name: '生辰纲护卫',
      title: '东平府 · 八名押禁',
      maxHp: bossHpFor('stage_04', 0.1),
      armor: 0.1,
      weakPoint: { x: 0, y: 3.1, r: 1.25 },
      phases: phaseLadder(1, [
        { at: 1.0, name: '押运', desc: '八个人押着一只酒坛，谁也别想碰' },
        { at: 0.62, name: '蒙汗', desc: '坛口的酒气漫上来，破绽口缩成一小圈' },
        { at: 0.3, name: '倾巢', desc: '护卫散开包抄，落槽越荡越远' },
      ]),
      colors: { body: '#3d2a46', trim: '#b07bd6', glow: '#e0a8ff' },
    },
    rules: rulesOf({
      balls: 30, reward: { silver: 440, stones: 120, shards: 3 } }),
  },

  /* ---------------------------------------------------------------- 05 */
  {
    id: 'stage_05',
    name: '济州 · 怒闯梁山泊',
    subtitle: '一刀一个，血溅鸳鸯楼',
    story: '宋江怒杀阎婆惜、张文远，提头出逃，投奔梁山泊。盘上一级级台阶往下走，没有回头路。',
    layoutNote: '双阶梯 + 中场一道双环。台阶把球一级级往下递，环在中间再横着搅一道。',
    width: 16,
    gravity: -74,
    rows: [
      row(27.0, 2.6, -6.2, 6.2, 0.26, 'normal', false, [0, 1.8]),
      row(22.6, 2.3, -6.6, 6.6, 0.26, 'normal', true, [0, 1.6]),
    ],
    formations: [
      stair('stair_a', -4.2, 20.6, 0.26, 'spear', 3, 4),
      stair('stair_b', 4.2, 20.6, 0.26, 'spear', 3, 4),
      ring('ring_m', 0, 14.0, 0.28, 'armored', 2, 0.3),
      wall('rail_l', -5.4, 10.2, 0.26, 'normal', 3),
      wall('rail_r', 5.4, 10.2, 0.26, 'normal', 3),
      cross('gold_m', 0, 13.4, 0.27, 'golden'),
      cross('weak_mouth', 0, 6.6, 0.3, 'weak'),
      ...enemies('stage_05', 1, 1),
    ],
    boss: {
      id: 'boss_chongyi',
      name: '王义',
      title: '济州 · 刀笔小吏',
      maxHp: bossHpFor('stage_05', 0.12),
      armor: 0.12,
      weakPoint: { x: 0, y: 3.1, r: 1.25 },
      phases: phaseLadder(2, [
        { at: 1.0, name: '笔架', desc: '一支笔一支架，球撞上就往回弹' },
        { at: 0.6, name: '泼墨', desc: '墨汁泼满盘面，落槽开始乱摆' },
        { at: 0.3, name: '狗头', desc: '一万条人命换来的刀，这颗球的时间被砍去一截' },
      ]),
      colors: { body: '#1f2a33', trim: '#6fb7d6', glow: '#a8e4ff' },
    },
    // 默认 14 发 → ×2.4 = 34。stage_05 实测平均要用到 33.3 发，几乎是贴着预算打，
    // 胜率只有 67%。给到 19（→46）留出余量：这一关是 stair 阵，球路被反复折返，
    // 一颗球本来就要吃掉更多击射。
    rules: rulesOf({ balls: 17, reward: { silver: 480, stones: 130, shards: 3 } }),
  },

  /* ---------------------------------------------------------------- 06 */
  {
    id: 'stage_06',
    name: '祝家庄 · 三打祝家庄',
      subtitle: '前两次都丢了盘',
    story: '一打失利石将军，二打丢了单廷珪，三打才破了那口活路。宋江三军齐发，盘子宽得像整座庄。',
    layoutNote: '超宽盘 20 + 棋盘疏阵 + 双侧环。全场最空的一张盘——这关考的不是走位，是算哪条路能接成连打。',
    width: 20,
    gravity: -74,
    rows: [
      row(27.0, 3.2, -8.4, 8.4, 0.26, 'normal', false, [0, 2.0]),
      row(22.2, 2.9, -8.6, 8.6, 0.26, 'normal', true, [0, 2.2]),
      row(14.4, 2.7, -8.6, 8.6, 0.25, 'armored', false, [-4.8, 1.4], [4.8, 1.4]),
      row(9.2, 3.0, -8.4, 8.4, 0.26, 'normal', true, [0, 1.6]),
    ],
    formations: [
      lattice('lat_l', -6.2, 19.0, 0.25, 'normal', 3, 3),
      lattice('lat_r', 6.2, 19.0, 0.25, 'normal', 3, 3),
      lattice('lat_m', 0, 19.0, 0.25, 'normal', 3, 3),
      ring('ring_l', -5.4, 12.0, 0.27, 'spear', 2, 0.4),
      ring('ring_r', 5.4, 12.0, 0.27, 'spear', 2, -0.4),
      cross('gold_l', -3.4, 13.4, 0.27, 'golden'),
      cross('gold_r', 3.4, 13.4, 0.27, 'golden'),
      cross('weak_mouth', 0, 6.8, 0.3, 'weak'),
      ...enemies('stage_06', 1.25, 1.05),
    ],
    boss: {
      id: 'boss_zhujiazhuang',
      name: '祝家庄三雄',
      title: '一打 · 二打 · 三打',
      maxHp: bossHpFor('stage_06', 0.14),
      armor: 0.14,
      weakPoint: { x: 0, y: 3.1, r: 1.3 },
      phases: phaseLadder(2, [
        { at: 1.0, name: '一打', desc: '只探不打，庄门紧闭，钉阵全是虚招' },
        { at: 0.7, name: '二打', desc: '单廷珪的钩镰枪扫过，球还在盘上，救球的窗口先被掐了' },
        { at: 0.4, name: '三打', desc: '三路人马同时压上，球时比刚才更短' },
      ]),
      colors: { body: '#2f3a2c', trim: '#9fd66a', glow: '#d6ff9a' },
    },
    rules: rulesOf({
      /*
       * 球预算从 33 加到 38：**吸收那枚长尾小怪**（−5.655, 24.2）。
       *
       * 那枚钉在顶排与侧壁之间的袋子里，洪泛判「通」、几何也挑不出毛病，
       * 但球几乎摸不到它——smoke 的 12 局里有 1 局正好剩下它、球用尽，
       * 于是「Boss 已倒 + 小怪未清」= 收不了工。
       *
       * 两条路：删掉那一枚（少一枚小怪 = 这一关整体降伤），或者给够球。
       * 这里选后者，因为漏网的概率本来就随盘宽变化，把预算当余量调比改落点稳。
       * 加完实测击射 18.3 → 19.6，用球率 55% → 59%，仍在 45~75% 的带里。
       */
      balls: 38,
      fever: feverOf({ duration: 15, bonusBalls: 5, chainStep: 0.22 }),
      reward: { silver: 520, stones: 140, shards: 3 },
    }),
  },

  /* ---------------------------------------------------------------- 07 */
  {
    id: 'stage_07',
    name: '大名府 · 玉麒麟',
    subtitle: '吴用火烧十万禁军',
    story: '卢俊义被陷害刺配沙门岛，中途被救上山。盘子窄到只剩一条螺线，谁也别想从中路过而不被打散。',
    layoutNote: '最窄盘 12 + 高重力 + 单条三圈螺线。窄盘上唯一的复杂阵型，全靠螺线把球搅碎。',
    width: 12,
    gravity: -88,
    rows: [
      row(27.0, 2.4, -4.4, 4.4, 0.27, 'normal', false, [0, 1.7]),
      row(22.4, 2.2, -4.6, 4.6, 0.27, 'normal', true, [0, 1.6]),
      row(10.0, 2.6, -4.6, 4.6, 0.27, 'normal', false, [0, 1.4]),
    ],
    formations: [
      spiral('spir_m', 0, 15.0, 0.26, 'spear', 3, 0.3),
      chevron('cannon_l', -3.0, 12.6, 0.26, 'normal', 3, 52),
      chevron('cannon_r', 3.0, 12.6, 0.26, 'normal', 3, 52),
      wall('rail_m', 0, 9.0, 0.26, 'armored', 5),
      cross('gold_m', 0, 13.4, 0.27, 'golden'),
      cross('weak_mouth', 0, 6.2, 0.3, 'weak'),
      ...enemies('stage_07', 0.75, 1.05),
    ],
    boss: {
      id: 'boss_lujunyi',
      name: '卢俊义',
      title: '大名府 · 玉麒麟',
      maxHp: bossHpFor('stage_07', 0.15),
      armor: 0.15,
      weakPoint: { x: 0, y: 3.1, r: 1.3 },
      phases: phaseLadder(2, [
        { at: 1.0, name: '棍棒天下', desc: '一条棍横扫，盘上钉阵皆为浮尘' },
        { at: 0.68, name: '鳞甲', desc: '锦毛虎的鳞甲竖起，落槽甩得更快' },
        { at: 0.32, name: '火烧大名府', desc: '城头火起，这颗球的时间被烧掉一截' },
      ]),
      colors: { body: '#3a3550', trim: '#ffd76a', glow: '#fff0b8' },
    },
    rules: rulesOf({
      // 全场最窄的一关（宽 12 / 94 枚钉），球在两侧窄道里反复被弹回来。
      // 旧预算 55 而实测只打掉 12.6 发，等于给了 4 倍冗余——
      // 那不是「关卡好过」，是「球根本用不完」，失败条件因此形同虚设。
      // 现按 12.6 x 1.6 收到 21。
      balls: 21,
      comboWindow: 1.5,
      fever: feverOf({ duration: 13, armorRelief: 0.22 }),
      reward: { silver: 560, stones: 150, shards: 4 },
    }),
  },

  /* ---------------------------------------------------------------- 08 */
  {
    id: 'stage_08',
    name: '江州 · 浔阳楼',
    subtitle: '题了反诗，判了个死罪',
    story: '宋江题反诗被判死罪，柴进、戴宗、李逵三处相救，发配江州路上才真正断了回头念想。',
    layoutNote: '三重正弦波带 + 上下双破绽口。两条波带一正一反，球在里面被来回甩，兩边破绽口都得够。',
    width: 16,
    gravity: -68,
    rows: [
      row(27.0, 2.6, -6.4, 6.4, 0.26, 'normal', false, [0, 1.8]),
      row(6.2, 2.7, -6.4, 6.4, 0.26, 'normal', false, [-3.2, 1.2], [3.2, 1.2]),
    ],
    formations: [
      wave('wave_a', 0, 21.4, 0.26, 'normal', 9, 0.75, 9, 0),
      wave('wave_b', 0, 18.2, 0.26, 'spear', 9, 0.75, 9, Math.PI),
      wave('wave_c', 0, 13.0, 0.26, 'armored', 9, 0.7, 9, 0),
      chevron('cannon_l', -4.4, 19.4, 0.26, 'normal', 3, 55),
      chevron('cannon_r', 4.4, 19.4, 0.26, 'normal', 3, 55),
      cross('weak_l', -3.2, 8.4, 0.3, 'weak'),
      cross('weak_r', 3.2, 8.4, 0.3, 'weak'),
      cross('gold_m', 0, 13.4, 0.27, 'golden'),
      ...enemies('stage_08', 1, 1.1),
    ],
    boss: {
      id: 'boss_huangwenbing',
      name: '黄文炳',
      title: '江州 · 军城观察',
      maxHp: bossHpFor('stage_08', 0.13),
      armor: 0.13,
      weakPoint: { x: 0, y: 3.1, r: 1.35 },
      phases: phaseLadder(2, [
        { at: 1.0, name: '题诗', desc: '一支笔一卷诗，盘上字迹越来越乱' },
        { at: 0.66, name: '构陷', desc: '一封伪信落在盘上，落槽开始来回摆' },
        { at: 0.3, name: '斩首', desc: '刑场鼓声一响，球还在盘上就得认命' },
      ]),
      colors: { body: '#243040', trim: '#4fa8d6', glow: '#8fd6ff' },
    },
    rules: rulesOf({
      balls: 55,
      comboWindow: 1.9,
      fever: feverOf({ duration: 15, slotFactor: 1.12, chainStep: 0.16, chainMax: 8 }),
      reward: { silver: 600, stones: 160, shards: 4 },
    }),
  },

  /* ---------------------------------------------------------------- 09 */
  {
    id: 'stage_09',
    name: '沂岭 · 沂水',
    subtitle: '四只烧饼，两把板斧',
    story: '李逵沂岭杀四只烧饼，寿张县擂打李万监。所谓「两斧清盘」，盘上就是两把正在抡的斧。',
    layoutNote: '双巨斧 + 蜂窝内衬。斧臂张得比别关开，球撞上就被甩得很高、落得很散，蜂窝又把下半盘切成一条条窄巷——想在这儿打出连击，得学会等球掉回来。',
    width: 16,
    /*
     * 重力是这关的**难度前提**，不是装饰。
     *
     * 原先这里写的是 -88（全场最高）。实测（bot，12 局）：
     *  -88 时这关平均 45 球、p90 79、12 局里有 1 局 120 球都收不了工，
     *   比钉更密的第 10 关（-74，25 球）贵一倍——难度轴直接断了。
     * -88 让球一趟穿盘，每发能扫到的破绽口个数太少，于是只能用球数硬堆。
     * 钉阵已经加不动了（加密 hex/chevron/wall 会被 expandStage 的重叠剔除
     * 反吃回去，钉数从 100 掉到 88），所以从重力下手。
     */
    gravity: -74,
    rows: [
      row(27.0, 2.4, -6.4, 6.4, 0.26, 'normal', false, [0, 1.8]),
      row(22.4, 2.2, -6.6, 6.6, 0.25, 'armored', true, [0, 1.6]),
    ],
    formations: [
      chevron('axe_l', -3.8, 19.4, 0.27, 'spear', 4, 64),
      chevron('axe_r', 3.8, 19.4, 0.27, 'spear', 4, 64),
      hex('hex_l', -5.0, 13.2, 0.25, 'normal', 3, 2),
      hex('hex_r', 5.0, 13.2, 0.25, 'normal', 3, 2),
      wall('wall_m', 0, 9.2, 0.26, 'normal', 6),
      cross('gold_l', -4.4, 13.4, 0.27, 'golden'),
      cross('gold_r', 4.4, 13.4, 0.27, 'golden'),
      cross('weak_mouth', 0, 6.6, 0.3, 'weak'),
      ...enemies('stage_09', 1, 1.15),
    ],
    boss: {
      id: 'boss_likui',
      name: '李逵',
      title: '沂岭 · 黑旋风',
      maxHp: bossHpFor('stage_09', 0.16),
      armor: 0.16,
      weakPoint: { x: 0, y: 3.1, r: 1.35 },
      phases: phaseLadder(3, [
        { at: 1.0, name: '黑旋风', desc: '两把板斧抡成风，盘上的钉子被劈得乱飞' },
        { at: 0.64, name: '嗜杀', desc: '见人就砍，这颗球的时间比刀还快' },
        { at: 0.3, name: '沂岭', desc: '把整个山岭连盘一起掀了，整盘开始横向推球' },
      ]),
      colors: { body: '#2b2320', trim: '#ff7a4a', glow: '#ffb08a' },
    },
    rules: rulesOf({
      balls: 80,
      fever: feverOf({ duration: 12, slotFactor: 1.3, bonusBalls: 6, armorRelief: 0.34 }),
      reward: { silver: 640, stones: 170, shards: 4 },
    }),
  },

  /* ---------------------------------------------------------------- 10 */
  {
    id: 'stage_10',
    name: '梁山 · 排座次',
    subtitle: '一百零八人，天罡地煞',
    story: '三山聚义，宋江题写替天行道。排座次那天，盘上摆的是整座梁山的阵——三道环，一圈套一圈。',
    layoutNote: '天罡三环 + 地煞双环。环环相套，球每穿过一道就被拨一次方向，弹射轨迹完全不可预测。',
    width: 18,
    gravity: -74,
    rows: [
      row(27.0, 2.9, -7.2, 7.2, 0.26, 'normal', false, [0, 1.9]),
      row(22.2, 2.6, -7.4, 7.4, 0.26, 'normal', true, [0, 1.7]),
    ],
    formations: [
      ring('ring_tian', 0, 18.6, 0.28, 'normal', 3, 0),
      ring('ring_disha_l', -6.2, 12.6, 0.26, 'spear', 2, 0.4),
      ring('ring_disha_r', 6.2, 12.6, 0.26, 'spear', 2, -0.4),
      hex('hex_l', -6.4, 8.6, 0.25, 'normal', 2, 2),
      hex('hex_r', 6.4, 8.6, 0.25, 'normal', 2, 2),
      cross('gold_l', -4.2, 13.4, 0.27, 'golden'),
      cross('gold_r', 4.2, 13.4, 0.27, 'golden'),
      cross('weak_mouth', 0, 6.6, 0.3, 'weak'),
      ...enemies('stage_10', 1.125, 1.2),
    ],
    boss: {
      id: 'boss_chongge',
      name: '晁盖',
      title: '梁山 · 托塔天王',
      maxHp: bossHpFor('stage_10', 0.14),
      armor: 0.14,
      weakPoint: { x: 0, y: 3.1, r: 1.4 },
      phases: phaseLadder(3, [
        { at: 1.0, name: '天王', desc: '一座宝塔压在盘心，三道环就是塔影' },
        { at: 0.7, name: '盖天王', desc: '晁天王一声令下，落槽与球时一齐收紧' },
        { at: 0.35, name: '托塔', desc: '宝塔倒转，整座盘面向一边压过去' },
      ]),
      colors: { body: '#2c2a44', trim: '#ffb347', glow: '#ffe1a8' },
    },
    rules: rulesOf({
      // ring 阵球路绕、追打次数天然偏多，实测平均用掉 24.3 发。
      // 现按 24.3 x 1.6 给到 39。
      balls: 40,
      startingEnergy: 28,
      fever: feverOf({ duration: 16, bonusBalls: 5, armorRelief: 0.32 }),
      reward: { silver: 700, stones: 190, shards: 5 },
    }),
  },

  /* ---------------------------------------------------------------- 11 */
  {
    id: 'stage_11',
    name: '陈桥驿 · 招安',
    subtitle: '一道诏书，把贼变成官',
    story: '宋江一封招安表递上去，梁山泊变成编制。诏书到了那一刻，盘上的钉阵忽然倒转过来。',
    layoutNote: '正漏斗接反漏斗。上面照常把球收到中间，最底下一道反向扩口又把它甩向两边。',
    width: 16,
    gravity: -74,
    rows: [
      row(27.0, 2.6, -6.4, 6.4, 0.26, 'normal', false, [0, 1.8]),
      row(22.4, 2.3, -6.6, 6.6, 0.26, 'normal', true, [0, 1.6]),
    ],
    formations: [
      funnel('fun_up', 0, 24.0, 0.26, 'spear', 4, 66, 11.0),
      funnel('fun_rev', 0, 9.6, 0.26, 'normal', 4, 26, 5.0),
      spiral('spir_m', 0, 15.4, 0.26, 'armored', 2, 0.8),
      wall('rail_l', -5.4, 6.6, 0.26, 'armored', 3),
      wall('rail_r', 5.4, 6.6, 0.26, 'armored', 3),
      cross('gold_l', -3.4, 13.4, 0.27, 'golden'),
      cross('gold_r', 3.4, 13.4, 0.27, 'golden'),
      ...enemies('stage_11', 1, 1.25),
    ],
    boss: {
      id: 'boss_caijing',
      name: '蔡京',
      title: '陈桥驿 · 殿前太师',
      maxHp: bossHpFor('stage_11', 0.18),
      armor: 0.18,
      weakPoint: { x: 0, y: 3.1, r: 1.4 },
      phases: phaseLadder(3, [
        { at: 1.0, name: '诏书', desc: '一纸诏书压在盘心，球撞上去就被弹开' },
        { at: 0.7, name: '揽权', desc: '太师府的门一关，这颗球的时间也短了一截' },
        { at: 0.35, name: '削藩', desc: '一纸文书把梁山泊拆了个干净，整盘开始横向推球' },
      ]),
      colors: { body: '#38293f', trim: '#c98ae0', glow: '#f0c8ff' },
    },
    rules: rulesOf({
      balls: 26,
      comboWindow: 1.6,
      fever: feverOf({ duration: 14, slotFactor: 1.25, armorRelief: 0.2 }),
      reward: { silver: 760, stones: 210, shards: 5 },
    }),
  },

  /* ---------------------------------------------------------------- 12 */
  {
    id: 'stage_12',
    name: '昱岭关 · 征方腊',
    subtitle: '魂幡之下，一百零八人去了七十',
    story: '昱岭关外，项充的魂幡阵把人马困在原地。方腊的盘子是最后一张——螺线、蜂窝、巨斧全挤在一起。',
    layoutNote: '终局混编。螺线搅动 + 蜂窝内衬 + 巨斧双翼 + 阶梯落口，四种阵型分占四段，盘面最长。',
    width: 18,
    gravity: -88,
    rows: [
      row(27.0, 2.6, -7.2, 7.2, 0.26, 'normal', false, [0, 1.9]),
      row(22.2, 2.4, -7.4, 7.4, 0.26, 'normal', true, [0, 1.7]),
      row(6.0, 2.9, -7.2, 7.2, 0.26, 'normal', false, [0, 1.5]),
    ],
    formations: [
      hex('hex_a', -6.0, 19.8, 0.25, 'normal', 3, 3),
      hex('hex_b', 6.0, 19.8, 0.25, 'normal', 3, 3),
      chevron('axe_l', -5.0, 15.0, 0.26, 'normal', 3, 60),
      chevron('axe_r', 5.0, 15.0, 0.26, 'normal', 3, 60),
      spiral('spir_m', 0, 14.4, 0.26, 'spear', 2, 0.3),
      stair('stair', 0, 11.0, 0.25, 'normal', 3, 4),
      hex('hex_c', -6.6, 12.0, 0.25, 'normal', 2, 2),
      hex('hex_d', 6.6, 12.0, 0.25, 'normal', 2, 2),
      // 第十二阵盘宽 18、钉 115，是全局最密的一关，容不下金钉上抬。
      // 保持原来的低矮位置：它在 hex 阵下方、破绽钉上方的空档里，
      // 球最后一段会经过，倍率照样吃得到，还不会在主通道上封出路。
      cross('gold_l', -3.0, 7.6, 0.27, 'golden'),
      cross('gold_r', 3.0, 7.6, 0.27, 'golden'),
      ...enemies('stage_12', 1.125, 1.45),
    ],
    boss: {
      id: 'boss_fangla',
      name: '方腊',
      title: '昱岭关 · 摩教教主',
      maxHp: bossHpFor('stage_12', 0.2),
      armor: 0.2,
      weakPoint: { x: 0, y: 3.1, r: 1.45 },
      phases: phaseLadder(3, [
        { at: 1.0, name: '教令', desc: '一道教令，盘上所有灯同时转成青白' },
        { at: 0.75, name: '魂幡', desc: '项充李衮的魂幡立起来，落槽与球时一齐收紧' },
        { at: 0.45, name: '八魔', desc: '八条魔头缠上来，整盘开始横向推球' },
      ]),
      colors: { body: '#1d2b2e', trim: '#5fe0c8', glow: '#c8fff0' },
    },
    rules: rulesOf({
      balls: 34,
      startingEnergy: 30,
      comboWindow: 1.9,
      fever: feverOf({
        duration: 18,
        bonusBalls: 6,
        slotFactor: 1.35,
        chainStep: 0.22,
        chainMax: 7,
        armorRelief: 0.36,
      }),
      // perSweep 不再单关覆盖。旧的 0.24 是为了把满清倍率从 ×4.36 拉回
      // 与其他关同一量级，但它仍然是另一套汇率——统一成 ENEMY_RULES 的 0.08，
      // 满清倍率由小怪枚数（12~18）自己决定，不再靠改汇率凑。
      enemy: { ...ENEMY_RULES, baseDamage: 32, perBounce: 11 },
      reward: { silver: 1200, stones: 320, shards: 8 },
    }),
  },
];
/* ------------------------------------------------------------------ 组装输出 */

function buildStage(s: StageSpec): StageDef {
  const w = s.width;
  const tutorialScale = s.id === 'stage_01' ? w / 20 : 1;
  // 全清奖励跟着 Boss 血量走：12 关 Boss 从 1800 到 18000，写死一个数就会重演
  // 旧 `killDamage` 那个「第一关 30% 血、第十二关 0.6% 血」的十倍误差。
  //
  // 单球时间预算跟着**盘面密度**走，密度 = 钉数 / 盘宽。
  // 12 关的密度从 1.8（stage_01：50 枚钉摊在 28 宽）到 6.4（stage_02：89 枚摊在 14 宽），
  // 差 3.5 倍。同一颗球在最密的盘上要弹的次数是最疏的盘的三倍多，
  // 用同一条 9.5 秒去卡，最密的那几关就有 16% 的球是被倒计时判死的——
  // 而 smoke 会把它记成「关卡布局缺陷」，所有人跑去调布局，问题却根本不在盘面上。
  //
  // 有了翻板之后这条线的性质也变了：它不再是死线，而是**玩家买时间的预算**
  // （每打中一次翻板还回 `FLIPPER.timeRefund` 秒）。盘越密球活得越久，
  // 预算就得跟着放宽，否则按板救回来的球反而会被这条线判死。
  const density = s.rows.length + s.formations.length * 6;
  void density;
  const rules = {
    ...s.rules,
    enemy: { ...s.rules.enemy, fullSweepDamage: Math.max(60, Math.round(s.boss.maxHp * 0.05)) },
  };

  /*
   * 先按「没有轨道」拼一次盘面，展开后拿两样东西：
   *   1. 实际的钉位  —— 轨道必须躲开它，否则会把球埋进钉堆
   *   2. 实际的半宽  —— 边界墙是按内容包围盒算的，轨道会反过来撑大盘面
   * 顺序反了就会重演那个坐标系混用的 bug：拿「缩放后的半宽」去算
   * 「缩放前的轨道坐标」，屋顶外端被推到 x=16.86 而侧壁在 16.9，只剩 0.044bu 的缝。
   */
  /*
   * 底部让位必须在 sealCorners / 缩放**之前**做：
   * 这两步改的是 x 方向（补顶排、按教学关缩放），而让位改的是 y 方向，
   * 互不干扰，但先让位能保证「红线」是按原始数据判的，不会被缩放带偏。
   */
  const room = makeRoomForBottom(s.rows, s.formations);
  if (room.notes.length) bottomReport.push(`${s.id} 让位 ${room.notes.join(' ')}`);

  const board = {
    width: w,
    height: BOARD_H,
    gravity: s.gravity,
    walls: [] as WallDef[],
    deflectors: baseDeflectors(s, w, tutorialScale),
    pegRows: [
      // 教学关的坐标是缩放前的，其余关补顶排；两条分支都必须**展开**进数组，
      // 少写一层 `...` 会把整叠行变成一个「行数组」元素，`expandPegRow`
      // 读到的 `fromX / step / stagger` 全是 undefined —— 钉阵静默消失一半，
      // 而生成期一切正常、`auditLanes` 只会说「干净」。
      ...(s.id === 'stage_01'
        ? room.rows.map((r) => ({ ...r, fromX: r.fromX * tutorialScale, toX: r.toX * tutorialScale, step: r.step * tutorialScale, r: .32, gaps: r.gaps.map((g) => ({ x: g.x * tutorialScale, r: g.r * tutorialScale })) }))
        : sealCorners(room.rows, w)),
      // 底部滚落随机钉永远排在最后：它跟盘面钉阵基本不接触（y=3.55 远在
      // keepOutY 之下），但排在最后能让冲突消解在极端情况下优先保住盘面布局。
      ...scatterRows(w),
    ],
    pegFormations: room.forms.map((f) => ({ ...f, cx: f.cx * tutorialScale })),
    // 教学关只保留 energy / boss / skill：combo 和 multiplier 撤掉，避免一上来就弹一屏数字。
    // **skill 必须留着** —— 玩家第一次上手多半就带公孙胜/燕青/张顺，
    // 教学关没有技能区等于「这将的技能是坏的」，比多教一个机制更劝退。
    //
    // 教学关的球流和正式关完全不同：球从右侧发射道上冲后由**右上角**进主盘，
    // 钉阵（行 8.3/12.4/15.6/20/24/28.6）又把它锁在右半边，整局几乎不去左侧
    // （实测 x∈[-13.9,13.9] 里球 90% 时间在 x>9）。所以正式关那套「中区 y=16 / xf=-0.3」
    // 在教学关是死区。扫了 6 个力度档的轨迹后，把教学关技能区挪到球真正会走的右上（x≈9, y≈26.3，
    // 每局约 8.8 次进区，能凑够 charges=6）。
    // 附带说明：教学关的 energy/boss 也摆在两侧角落，同样几乎不命中——这是教学关球流的
    // 独立问题（设计写「瞄准中央破绽口」但球不去中央），不在本次技能修复范围内。
    zones: s.id === 'stage_01'
      ? zonesFor(w)
          .filter((z) => z.kind === 'energy' || z.kind === 'boss' || z.kind === 'skill')
          .map((z) => (z.kind === 'skill' ? { ...z, x: Number((0.32 * w).toFixed(3)), y: 26.3 } : z))
      : zonesFor(w),
    slots: slotsFor(w),
  };
  const probe = expandStage({
    id: 'probe', name: 'probe', subtitle: 'probe', story: '', layoutNote: '',
    board,
    boss: s.boss,
    rules: s.rules,
  } as unknown as StageDef);
  // `playLeftX` 是**正数**（左墙所在 x），不是「左边界的距离」。
  // 写成 `hw = -probe.playLeftX` 会得到负半宽，后面所有 x 取负之后左右整个翻面。
  const hw = probe.playLeftX;
  /*
   * 中央闸门必须在**钉阵展开之后**算：它要看的是「钉和墙摆完之后还剩哪条直通道」，
   * 而那个结果只有在 `expandStage` 之后才拿得到。插完再展开一次，后面的轨道、
   * 小怪落点、满清倍率全部基于闸门之后的盘面算。
   */
  const gates = centralGates(s.id, probe, hw);
  if (gates.length) {
    board.walls.push(...gates);
    Object.assign(probe, expandStage({
      id: 'probe', name: 'probe', subtitle: 'probe', story: '', layoutNote: '',
      board, boss: s.boss, rules: s.rules,
    } as unknown as StageDef));
  }
  checkBottom(s.id, probe.pegs, probe.flippers);
  const pegCount = probe.pegs.length;
  const tracks = buildTracks(s, hw, tutorialScale, probe.pegs, board.deflectors, board.height);

  return {
    id: s.id,
    name: s.name,
    subtitle: s.subtitle,
    story: s.story,
    layoutNote: s.layoutNote,
    board: {
      ...board,
      // 轨道排在导流板前面：`BoardView` 按数组顺序建网格，
      // 轨道在最内层会被钉阵挡住，读起来像「轨道画在钉子后面」。
      deflectors: [...tracks, ...board.deflectors],
    },
    boss: s.boss,
    rules: {
      ...rules,
      // 密度 = 展开后的实际钉数 / 盘宽。12 关从 1.8（stage_01）到 6.4（stage_02），
      // 差 3.5 倍。8.6 秒是疏盘（密度 2）的基准，每多 1 的密度加 0.95 秒。
      ballSeconds: Math.round((8.6 + (pegCount / w) * 0.95) * 10) / 10,
    },
  };
}

/* ---------------------------------------------------------------- 轨道层 */

/**
 * 每一关用哪一种轨道形状。这**不是风格选择，是实测结果**。
 *
 * 调参台（`.acceptance/_tune.mts`）对每关跑「无轨道基线 + 4 种形状」，用两个指标挑：
 *   每发钉击 —— 轨道该带来的收益：球被轨道带着走，是不是打到了更多钉
 *   超时率   —— 轨道不该带来的代价：有没有造出球进得去出不来的口袋
 *
 * 盯「每发钉击」而不是「钉击总数」是被迫的：钉击总数和胜负**不同向**。
 * 屋顶把球甩到外侧那条无钉死区时，钉击总数能从 22 涨到 51（看着像大成功），
 * 可落槽分布塌了（破绽槽 24% → 10%），单球伤害 316 → 109，18 球打不完，胜率 95% → 60%。
 * 按总数挑形状，会稳稳地选出最差的那个。
 *
 * 实测出来的规律是：**越疏的盘越需要分岔，越密的盘越需要收束**。
 *   stage_01 宽 28  50 枚钉   基线每发 3.9   A 三段式 7.2（+85%）
 *   stage_02 窄 14  89 枚钉   基线每发 8.6   A 三段式 10.8（+26%）
 *   stage_03 中 18 107 枚钉   基线每发 8.0   A 三段式 6.8（−15%）／B 双层漏斗 8.7（+9%）
 * 密盘的基线本来就打满全程，轨道只会把它从密集区引开，所以换成收束型。
 */
/**
 * 轨道层用哪几层。这是**实测结果**，不是风格选择。
 *
 * 调参台（`.acceptance/_tune.mts`）对 12 关各跑「无轨道 / 双层 / 只顶带 / 只第二带」，
 * 盯两个指标：
 *   每发钉击  轨道该带来的收益——球被轨道带着走，是不是打到了更多钉
 *   胜率+超时 轨道不该带来的代价——有没有造出球出得来的口袋
 *
 * 盯「每发钉击」而不是「钉击总数」是被迫的：钉击总数和胜负**不同向**。
 * 早期那版屋顶把球甩到外侧无钉死区，钉击总数从 22 涨到 51（看着像大成功），
 * 可破绽槽 24% → 10%，单球伤害 316 → 109，18 球打不完，胜率 95% → 60%。
 * 按总数挑形状，会稳稳地选出最差的那个。
 *
 * 实测结论（20 局/组，每发钉击）：
 *   关      无轨道  双层  只顶带  只第二带   → 采用
 *   01 宽28   3.9   5.3    4.1     4.8      双层
 *   02 窄14   8.6   8.6    8.6     9.0      只第二带
 *   03 中18   8.1   7.5    9.3     7.2      只顶带
 *   04       9.6   8.0    8.1    10.2      只第二带
 *   05       9.0   8.5    8.1     9.3      只第二带
 *   06       8.0   7.5    7.2     8.3      只第二带
 *   07 窄12   8.2   6.8    7.2     7.0      只第二带（双层会掉到 85% 胜率）
 *   08       7.8   9.6    7.4     8.7      双层
 *   09       5.4   5.6    5.4     5.9      双层（只第二带会掉到 95% 胜率）
 *   10       7.6   8.1    8.0     6.9      双层
 *   11      12.8  10.9   10.6    12.9      只第二带
 *   12       7.1   6.8    6.6     7.2      只第二带
 *
 * 读法是一致的：**疏盘要双层**（球需要被带着多走几个地方），
 * **密盘只要收束的那一层**（球本来就撞满全程，多一层屋顶只会把它从密集区引开）。
 * 这就是「不同关卡的轨道地图」——层数和形状都跟着盘面密度走。
 */
type TrackShape = 'none' | 'both' | 'top' | 'second';
const TRACK_SHAPE: Record<string, TrackShape> = {
  stage_01: 'both',
  stage_02: 'second',
  stage_03: 'top',
  stage_04: 'second',
  stage_05: 'second',
  stage_06: 'second',
  stage_07: 'second',
  stage_08: 'both',
  stage_09: 'both',
  stage_10: 'both',
  stage_11: 'second',
  stage_12: 'second',
};

/** 每关的轨道层用了几条、被校验丢了���条。生成完在终端打出来，别让它悄悄降级。 */
let trackReport: string[] = [];

/**
 * 底部收口层的让位与校验记录。⚠ 开头的是**必须处理**的：
 * 要么有钉还在红线以下，要么有钉落在翻板扫掠扇形里（板会直接穿过去）。
 */
let bottomReport: string[] = [];

/** 每关中央闸门的插桩结果。 */
let topReport: string[] = [];

/**
 * 按两端点生成一条斜轨。`atan2` 而不是 `atan`：轨道可以往左下走，
 * 用 `atan` 会把「左下」和「右上」折成同一条。
 */
function trackBar(id: string, x1: number, y1: number, x2: number, y2: number): WallDef {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  return {
    id,
    x: Number(((x1 + x2) / 2).toFixed(3)),
    y: Number(((y1 + y2) / 2).toFixed(3)),
    w: Number((len / 2).toFixed(3)),
    h: 0.2,
    rotDeg: Number(((Math.atan2(dy, dx) * 180) / Math.PI).toFixed(2)),
    role: 'deflector',
  };
}

/**
 * 球心在哪些 y 上能横穿全盘而不蹭钉。返回从低到高排的净空带。
 *
 * 判据是「球心到钉心的距离 > 钉半径 + 球半径」。比「钉与钉之间空几格」准，
 * 因为大钉（r 0.95）会吃掉两倍的高度——stage_01 在 y=11 有两枚 r=0.95 的，
 * 按行距看「11 和 12.4 之间明明有 1.4bu 的空」，按球径算其实只剩 0.4。
 *
 * **轨道坐标必须从这张表里长出来，不能写死 y。** 写死过一版，
 * 结果每一关都把轨道埋进钉行：stage_01 的送板轨 y 12.4~17.4 正对着
 * y=15.6 那一行 6 枚钉，y=11 两枚大钉直接把轨顶穿 0.65bu。
 */
function clearBands(pegs: readonly PegDef[], height: number): [number, number][] {
  const R = PHYSICS.ballRadius;
  const blocked = pegs
    .map((p) => [p.y - p.r - R, p.y + p.r + R] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const b of blocked) {
    const last = merged[merged.length - 1];
    if (last && b[0] <= last[1]) last[1] = Math.max(last[1], b[1]);
    else merged.push([b[0], b[1]]);
  }
  const bands: [number, number][] = [];
  let prev = 0;
  for (const [lo, hi] of merged) {
    if (lo > prev) bands.push([prev, lo]);
    prev = Math.max(prev, hi);
  }
  if (prev < height) bands.push([prev, height]);
  return bands;
}

/** 球骑在轨道上时，球心比轨道中轴高出的量（轨厚一半 + 球半径）。 */
const RIDE = 0.1 + PHYSICS.ballRadius;

/**
 * 把一条轨道塞进给定的净空带。
 *
 * 顺序是「先定坡度、再定长度」而不是「先定长度、再算坡度」：
 * 坡度低于 18° 球骑在轨上不动（摩擦和弹性抵消掉重力分量），
 * 高于 28° 就不是「骑轨道」而是「撞斜板」，球直接弹飞而不是滑过去。
 * 所以横向跑多远是**结果**：带有多高就决定能跑多长。
 */
function fitTrack(
  band: [number, number],
  gap: number,
  xOutMax: number,
  slopeDeg: number,
): { xIn: number; xOut: number; yIn: number; yOut: number } | null {
  const margin = 0.18;
  // 轨道中轴的可摆动范围：球心要在带内，所以中轴要比带矮 RIDE。
  const yTop = band[1] - RIDE - margin;
  const yBot = band[0] - RIDE + margin;
  const avail = yTop - yBot;
  if (avail < 0.6) return null;
  const tan = Math.tan((slopeDeg * Math.PI) / 180);
  let run = Math.min(xOutMax - gap, avail / tan);
  if (run < 1.2) return null;
  const drop = run * tan;
  return { xIn: gap, xOut: gap + run, yIn: yTop, yOut: yTop - drop };
}

/** 一对镜像轨道。左右两半必须同生共死，所以校验和统计都以「对」为单位。 */
interface TrackPair {
  prefix: string;
  bars: WallDef[];
}

/**
 * 从高到低取够高的净空带，每条带按**从长到短**生成若干候选。
 *
 * 为什么要有长度梯度：第二带里本来就压着固定导流板 `d_mid_l/r`，
 * 满长的轨道会正好压在它旁边留出一条 0.8~1.5bu 的缝——球进得去、出不来。
 * 正确的退让方式是**把轨道缩短**（坡度不变、落差跟着变小），
 * 而不是整条丢掉：丢掉的话这一层就白留了，而缩短之后既躲开了导流板，
 * 又仍然是一条球能骑的滑道。
 *
 * 轨道一律是 ∨（外端高、内端低、中缝落进盘心）。早先试过一版 ∧ 分岔
 * （把球往外撒），12 关里只有最疏的 stage_01 受益，另外 10 关每发钉击
 * 掉 10~40%、四关胜率腰斩——球被撒到钉阵边缘那片低密度区，白跑一趟。
 * 「往盘心收」对疏盘密盘都是正收益，所以只保留这一种。
 */
function trackCandidates(shape: TrackShape, hw: number, bands: [number, number][]): TrackPair[] {
  // y≈8 那条净空带只有 1bu 上下，塞不下 18° 坡度的轨道，硬塞就会顶穿钉子。
  const usable = bands.filter((b) => b[1] - b[0] >= 1.6).slice(-2).reverse();
  if (!usable.length) return [];
  /*
   * 中缝宽度有下限，不能按盘宽缩放。
   * 两半之间的缝如果落在「刚够球钻进去」那一档（球径 0.66 ~ 1.6），
   * 球就会坐进轨道中缝的低点：它不会停死（以 3~5bu/s 来回滚，高于 stallSpeed 2.5），
   * 于是「停死强制落槽」那条兜底抓不到它，只能一路挂到球龄上限。
   * 窄盘按 0.09·hw 算只有 1.11bu，正好落在最危险的位置。
   */
  const gap = Math.max(1.05, 0.11 * hw);
  const out: TrackPair[] = [];
  // 用带在 `usable` 里的序号命名，不是过滤后的序号——
  // 否则「只第二带」那几关的第二层会被错叫成 trk_roof，
  // 数据里一条画在 y≈24 的轨道顶着「屋顶」的名字，排查时能把人绕晕。
  usable.forEach((band, i) => {
    if (shape === 'top' && i !== 0) return;
    if (shape === 'second' && i !== 1) return;
    const prefix = i === 0 ? 'trk_roof' : 'trk_mid';
    for (const shrink of [1, 0.8, 0.62, 0.46, 0.34]) {
      const t = fitTrack(band, gap, 0.88 * hw * shrink, 20);
      if (!t) continue;
      out.push({
        prefix,
        bars: [
          trackBar(`${prefix}_l`, -t.xOut, t.yIn, -t.xIn, t.yOut),
          trackBar(`${prefix}_r`, t.xIn, t.yOut, t.xOut, t.yIn),
        ],
      });
    }
  });
  return out;
}

/** 本关的固定导流板（不含轨道）。 */
function baseDeflectors(s: StageSpec, w: number, tutorialScale: number): WallDef[] {
  if (s.id !== 'stage_01') return deflectorsFor(w);
  /*
   * 教学关拆成两层，**只有上半层跟着缩放**：
   *
   *   上半（侧导流罩）：按 20 宽生成，再整体缩放到 28 宽。
   *   底半（翻板 + 导流墙）：**按真实半宽直接生成，不缩放**。
   *
   * 底部不能缩放的原因和 `BOTTOM` 里写的是同一条：底部是机台硬件。
   * 缩放它会让板长从 2.8 变 3.9、板尖弹起时扫到 y=8.4 —— 而这关的顶排钉
   * 正好在 y=8.0（钉底 7.72），板会在弹起途中从钉子身上穿过去。
   */
  const hw = w / 2;
  const upper = deflectorsFor(20)
    .filter((x) => !x.id.startsWith('flip_') && !x.id.startsWith('guide_'))
    .map((x) => ({
      ...x,
      x: Number((x.x * tutorialScale).toFixed(3)),
      w: Number((x.w * tutorialScale).toFixed(3)),
    }));
  return [...bottomFlippers(hw, hw * 2, wallD), ...upper];
}

const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
};

const ends = (t: WallDef): [number, number, number, number] => {
  const r = (t.rotDeg * Math.PI) / 180;
  const dx = Math.cos(r) * t.w;
  const dy = Math.sin(r) * t.w;
  return [t.x - dx, t.y - dy, t.x + dx, t.y + dy];
};

/** 轨道到最近一枚钉的净距（已扣掉钉半径和轨厚）。负数 = 轨道压在钉子上。 */
function trackPegGap(t: WallDef, pegs: readonly PegDef[]): { gap: number; peg: PegDef | null } {
  const [ax, ay, bx, by] = ends(t);
  let worst = Infinity;
  let who: PegDef | null = null;
  for (const p of pegs) {
    const d = segDist(p.x, p.y, ax, ay, bx, by) - p.r - t.h / 2;
    if (d < worst) { worst = d; who = p; }
  }
  return { gap: worst, peg: who };
}

/** 轨道到其它墙体（导流板 / 已接受的轨道）的净距。 */
function trackWallGap(t: WallDef, others: readonly WallDef[]): number {
  const [ax, ay, bx, by] = ends(t);
  let worst = Infinity;
  for (const o of others) {
    if (o.id === t.id) continue;
    const [cx, cy, dx2, dy2] = ends(o);
    let d = Infinity;
    for (let k = 0; k <= 20; k++) {
      const u = k / 20;
      d = Math.min(d, segDist(ax + (bx - ax) * u, ay + (by - ay) * u, cx, cy, dx2, dy2));
      d = Math.min(d, segDist(cx + (dx2 - cx) * u, cy + (dy2 - cy) * u, ax, ay, bx, by));
    }
    const gap = d - (t.h + o.h) / 2;
    if (gap < worst) worst = gap;
  }
  return worst;
}

/**
 * 轨道能不能要。两条判据，方向和直觉相反的那条写在下面：
 *
 *   1. 轨道不能压到钉子上（净距 < 球径的一半就废）
 *   2. 轨道与别的墙之间**不能**留一条「刚够球钻进去」的缝。
 *      缝比球径**小**是安全的——球进不去，那只是一堵墙；
 *      缝在 1.0~1.6 之间才是口袋：球滑进去、被上下两条轨夹住、出不来。
 *      一开始把判据写成「净距 < 球径就告警」，结果把一堆 0.5 的死路报成问题，
 *      反而放过了真正卡球的 1.05。
 */
/**
 * 轨道能不能要，返回拒绝理由（`null` = 通过）。
 *
 * `gap` 的正负方向一开始理解反了，结论整个是反的：
 *   gap = 钉心到轨道中轴的距离 − 钉半径 − 轨厚的一半
 *   gap = +0.08  钉顶在轨道**上表面之下** 0.08 —— 钉子藏在轨道底下，完全安全
 *   gap = −0.65  钉顶戳出轨道上表面 0.65 —— 球骑在轨道上会被顶开，甚至卡死
 * 所以判据是「**负得够多才拒**」，一开始写成 `gap < 0.36`，
 * 于是 +0.08 这种最安全的轨道也被毙了，反而放过了 −0.65。
 */
function trackReject(t: WallDef, pegs: readonly PegDef[], walls: readonly WallDef[]): string | null {
  const ballD = PHYSICS.ballRadius * 2;
  const { gap: pg, peg } = trackPegGap(t, pegs);
  if (pg < -0.15) return `钉戳穿轨道 ${pg.toFixed(2)} @(${peg?.x.toFixed(1)},${peg?.y.toFixed(1)})`;
  const g = trackWallGap(t, walls);
  if (g > ballD && g < ballD * 2.4) {
    /*
     * 缝比球径**小**是安全的——球根本钻不进去，那只是一堵墙。
     * 真正要命的是「刚够钻进去」的那一档：球滑进去、被上下两条轨夹住、出不来。
     */
    const who = walls
      .filter((o) => o.id !== t.id)
      .map((o) => ({ o, d: segGap(t, o) }))
      .sort((a, b) => a.d - b.d)[0];
    return `夹球缝 ${g.toFixed(2)} @${who?.o.id ?? '?'}`;
  }
  return null;
}

/** 两条轨之间��净距（已扣掉两条的厚度）。 */
function segGap(t: WallDef, o: WallDef): number {
  const [ax, ay, bx, by] = ends(t);
  const [cx, cy, dx2, dy2] = ends(o);
  let d = Infinity;
  for (let k = 0; k <= 20; k++) {
    const u = k / 20;
    d = Math.min(d, segDist(ax + (bx - ax) * u, ay + (by - ay) * u, cx, cy, dx2, dy2));
    d = Math.min(d, segDist(cx + (dx2 - cx) * u, cy + (dy2 - cy) * u, ax, ay, bx, by));
  }
  return d - (t.h + o.h) / 2;
}


/**
 * 本关的轨道层 = 按比例生成 + 逐条对着真实钉阵校验。
 *
 * 校验放在这里而不是靠手调，是因为**加关卡只加数据**：以后加第 13 关，
 * 只要在 `TRACK_SHAPE` 里给它一个形状，几何不合的那几条会被自动丢掉，
 * 而不是像第一版那样把轨道埋进钉子里、在 smoke 上表现成「超时率升高」，
 * 让所有人误以为要去调盘面布局。
 */
function buildTracks(
  s: StageSpec,
  hw: number,
  tutorialScale: number,
  pegs: readonly PegDef[],
  base: readonly WallDef[],
  height: number,
): WallDef[] {
  const shape = TRACK_SHAPE[s.id] ?? 'none';
  if (shape === 'none') {
    trackReport.push(`${s.id} 无轨道`);
    return [];
  }
  // 教学关的坐标是缩放**前**的：`(w/2)/tutorialScale`，再乘回去。
  // 顺序写反就是那个「屋顶外端 0.044bu」的 bug。
  const bands = clearBands(pegs, height);
  const scaleTracks = (list: WallDef[]): WallDef[] =>
    list.map((t) => ({ ...t, x: Number((t.x * tutorialScale).toFixed(3)), w: Number((t.w * tutorialScale).toFixed(3)) }));
  const levels = trackCandidates(shape, hw / tutorialScale, bands);
  const kept: WallDef[] = [];
  const taken: string[] = [];
  const rejected: string[] = [];
  for (const level of new Set(levels.map((l) => l.prefix))) {
    /*
     * 同一条带按长度从长到短试，取第一条能通过校验的。
     * 镜像的两半是整体判定：左右几何对称，被哪枚钉顶穿只差钉阵 ±0.1 的抖动，
     * 逐条判定会只留下半条偏心的轨道，球全往一边走，日志上还看不出所以然。
     */
    const tries = levels.filter((l) => l.prefix === level);
    let placed = false;
    for (const cand of tries) {
      const bars = scaleTracks(cand.bars);
      const why = bars.map((t) => trackReject(t, pegs, [...base, ...kept])).find((r) => r !== null) ?? null;
      if (why === null) {
        kept.push(...bars);
        const reach = Math.max(...cand.bars.map((b) => Math.abs(b.x) + b.w)).toFixed(1);
        taken.push(`${level}到x=${reach}`);
        placed = true;
        break;
      }
      rejected.push(`${level}:${why}`);
    }
    if (!placed && tries.length) rejected.push(`${level}:全长度都不合格`);
  }
  const bandTxt = bands.filter((b) => b[1] - b[0] >= 1.6).map((b) => `${b[0].toFixed(1)}~${b[1].toFixed(1)}`).join(',');
  trackReport.push(
    `${s.id} 形状${shape} 带[${bandTxt}] 采用[${taken.join(' ') || '无'}]` +
    (rejected.length ? ` 退让[${rejected.join(' ')}]` : ''),
  );
  return kept;
}


/** 这个阵型单独展开成探针盘时有多少枚钉，用来报「挤掉了多少」。 */
function countFormationPegs(f: Form): number {
  const probe = expandStage({
    id: 'probe',
    name: 'probe',
    subtitle: 'probe',
    story: '',
    layoutNote: '',
    board: {
      width: 40,
      height: 40,
      gravity: -74,
      walls: [],
      deflectors: [],
      pegRows: [],
      pegFormations: [{ ...f, cx: 0, cy: 0 }],
      zones: [],
      slots: [],
    },
    boss: {
      id: 'b',
      name: 'b',
      title: 'b',
      // 这是 countFormationPegs 用的临时探针盘，只求能展开，不参与任何数值
      maxHp: 1,
      armor: 0,
      weakPoint: { x: 0, y: 0, r: 1 },
      phases: [],
      colors: { body: '#000', trim: '#000', glow: '#000' },
    },
    rules: {
      balls: 40,
      comboWindow: 1,
      startingEnergy: 0,
      fever: feverOf(),
      enemy: { ...ENEMY_RULES },
      reward: { silver: 0, stones: 0, shards: 0 },
    },
  });
  return probe.pegs.length;
}

async function main(): Promise<void> {
  const outDir = join(import.meta.dirname, '..', 'public', 'data', 'stages');
  await mkdir(outDir, { recursive: true });

  let bad = 0;
  const requested = process.argv.indexOf('--stage');
  const selected = requested >= 0 ? SPECS.filter((s) => s.id === process.argv[requested + 1]) : SPECS;
  if (!selected.length) throw new Error('未找到指定关卡');
  for (const spec of selected) {
    placeEnemies(spec);
    const def = buildStage(spec);
    const stage = expandStage(def);
    const audit = auditLanes(stage.pegs, PHYSICS.ballRadius);
    const shapes = [...new Set(spec.formations.map((f) => f.shape))].join('/');
    const status = audit.overlaps.length ? '相交!' : audit.nests.length > 40 ? '窄巷多' : 'ok';
    if (audit.overlaps.length) bad++;
    /*
     * 满清倍率校验。
     *
     * 旧版难度曲线非单调的根因就在这里：`perSweep` 是定值，倍率 = 1 + 实际枚数 × perSweep，
     * 而实际枚数是排版副产物（diamond 写死 9 枚 + 去重随机削减），
     * 于是 12 关倍率在 2.50~11.20 乱跳。
     *
     * 现在把方向倒过来：倍率是设计量（SWEEP_MAX），perSweep 按实际枚数反推，
     * 并且必须在 expandStage **之后**回写进 JSON —— 否则运行时读到的还是旧值。
     * 因此这一段的读数应当恒为 ×2.20；不是就说明反推没接上。
     */
    const wantEnemies = spec.id === 'stage_01' ? 5 : (ENEMY_TOTAL_BY_STAGE[spec.id] ?? ENEMY_TOTAL);
    const gotEnemies = stage.pegs.filter((p) => p.kind === 'enemy').length;
    def.rules.enemy.perSweep = resolvePerSweep(def, gotEnemies);
    const sweepMax = 1 + gotEnemies * def.rules.enemy.perSweep;
    const enStatus = `${String(gotEnemies).padStart(2)}枚×${sweepMax.toFixed(2)}`;
    if (Math.abs(sweepMax - SWEEP_MAX) > 0.01) bad++;
    // 枚数是排版结果，只报警不失败；但掉到个位数说明阵型把盘面塞死了，得看一眼
    if (gotEnemies < wantEnemies - 4) {
      console.warn(`  ! ${spec.id} 盘面只放得下 ${gotEnemies} 枚小怪（想要 ${wantEnemies}）`);
    }
    const dropped = spec.formations.reduce(
      (n, f) => n + countFormationPegs(f) - stage.pegs.filter((p) => p.id.includes(f.id)).length,
      0,
    );
    console.log(
      `${spec.id} ${spec.name.padEnd(12, '　')} 盘宽${String(spec.width).padStart(2)}  ` +
        `钉${String(stage.pegs.length).padStart(3)}${dropped > 0 ? `(挤掉${String(dropped).padStart(2)})` : '      '}  ` +
        `阵型 ${shapes.padEnd(28)}  小怪${enStatus.padEnd(12)} ` +
        `弹射${stage.plunger.minPower}~${stage.plunger.maxPower}  ${status}  ${auditSummary(audit, 3)}`,
    );
    await writeFile(join(outDir, `${spec.id}.json`), `${JSON.stringify(def, null, 2)}\n`, 'utf8');
  }

  console.log(`\n轨道层:`);
  for (const line of trackReport) console.log(`  ${line}`);

  console.log(`\n中央闸门:`);
  for (const line of topReport.length ? topReport : ['  （12 关的直通段都在阈值内，不需要闸门）'])
    console.log(`  ${line}`);

  console.log(`\n底部收口层:`);
  for (const line of bottomReport) console.log(`  ${line}`);

  console.log(`\n写出 ${selected.length} 关`);
  if (bad) {
    console.error(`✗ ${bad} 处关卡生成不合法（钉相交或满清倍率偏离 SWEEP_MAX），必须修`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
