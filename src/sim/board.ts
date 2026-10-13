import type {
  RecoveryRules,
  PegDef,
  PegFormationDef,
  PegKind,
  PegRowDef,
  SlotDef,
  StageDef,
  WallDef,
  ZoneDef,
} from '../data/schema.ts';
import {
  BOTTOM,
  FLIPPER,
  PHYSICS,
  PLUNGER,
  RECOVERY_POOL,
  climbSpeedFor,
  plungerPowerRange,
} from '../core/constants.ts';
import { enemyCardForStage } from '../data/EnemyCards.ts';

/**
 * 一块可操作翻板的完整几何。
 *
 * 全部由关卡里那根 horn 条**算出来**，核心代码不接受坐标：
 * 关卡只负责说「这里有一块左板，静止时朝这个角度」，剩下的（枢轴在哪、
 * 板有多长、弹到什么角度）由这一层按 `FLIPPER` 的统一规则补齐。
 * 这样加关卡只加数据，同时 12 关的翻板手感完全一致。
 */
export interface FlipperGeom {
  id: string;
  side: 'left' | 'right';
  /** 枢轴（板的外端），翻板绕它转 */
  px: number;
  py: number;
  /** 板长：枢轴到内端 */
  len: number;
  /** 板厚（半厚） */
  half: number;
  /** 静止时板身的绝对角度（弧度） */
  restRad: number;
  /** 弹到位时板身的绝对角度（弧度） */
  flipRad: number;
  /**
   * 击球时球被推走的方向（弧度）。
   *
   * **这是设计决定，不是几何推导**，必须和 `flipRad` 分开存。
   * 直板在弹起后的几何法线指向「上外侧」（左板是 134°，往左墙上顶），
   * 照它推球的结果是「越按左板，球越往左边死角跑」。
   *
   * 真弹球的翻板能把球送到对面，靠的是**弧形板面**沿切线甩出去而不是法线；
   * 这里用的是直板，就只能把「往对面打」当成规则直接写死：
   * 左板往右上、右板往左上，两块板构成一对交叉球路。
   */
  kickRad: number;
}

/**
 * 从一根标了 `flip` 的 horn 条算出翻板几何。
 *
 * 枢轴取**远离中央的那一端**：左板取左端、右板取右端。
 * 这不是随手选的——翻板的意义是「把中央落下来的球打回中区」，
 * 枢轴放内侧的话板一弹就把球往机台外侧掀，玩家越按越把球送死。
 *
 * 板身方向 `dirRad` 必须单独算，不能直接用 `restRad`：
 * 墙体的两个端点分别落在 `restRad` 和 `restRad + π` 上，枢轴占了其中一头，
 * 板尖就在**另一头**。左右两侧的枢轴端正好相反，
 * 所以 `dirRad` 一边是 `restRad`、另一边是 `restRad + π`。
 * 两边共用 `restRad` 的话右板板尖会指向机台外侧（实测落在 x=+7.1），
 * 而板在画面上还在原处——这个 bug 静态截图完全看不出来。
 */
export function flipperFromWall(w: WallDef): FlipperGeom | null {
  const side = w.flip;
  if (!side) return null;
  const restRad = (w.rotDeg * Math.PI) / 180;
  const dx = Math.cos(restRad) * w.w;
  const dy = Math.sin(restRad) * w.w;
  const isLeft = side === 'left';
  const px = isLeft ? w.x - dx : w.x + dx;
  const py = isLeft ? w.y - dy : w.y + dy;
  const dirRad = isLeft ? restRad : restRad + Math.PI;
  const len = w.w * 2;
  // 弹起方向：左板逆时针（板尖往内上抬），右板顺时针。
  const flipRad = dirRad + (isLeft ? 1 : -1) * ((FLIPPER.flipDeg * Math.PI) / 180);
  const kickRad = (((isLeft ? 90 - FLIPPER.kickAngleDeg : 90 + FLIPPER.kickAngleDeg) * Math.PI) / 180);
  // 存的是「枢轴 → 板尖」这条射线的绝对角，静止和弹起都用同一个约定。
  // 早先这里存的是墙体自己的 `rotDeg`，右板于是是 18° 而不是 198°——
  // 而 Rapier 的碰撞盒沿刚体局部 +x 铺开，于是右板的板整个朝机台外侧指着，
  // 球从它旁边滚过去，板却怎么按都打不到。
  return { id: w.id, side, px, py, len, half: w.h, restRad: dirRad, flipRad, kickRad };
}

/**
 * 弹射道几何。**由盘面内容算出来**，不是写死坐标。
 *
 * 为什么要算：12 关盘宽从 12 到 28，钉阵右缘最远到 x=+10.9（stage_01）、
 * 最近到 x=+7.0（stage_02，钉子直接顶在侧壁上）。球道必须待在主盘之外，
 * 所以它只能贴着「本关内容的实际右缘」往外放——写死坐标的话，宽盘关卡
 * 会留一大块死白，窄盘关卡的球道则会压在钉子上。
 */
export interface PlungerGeom {
  /** 球道中心 x */
  x: number;
  /** 球道净宽 */
  width: number;
  /** 内壁 x（球道的左边界，主盘那一侧） */
  innerX: number;
  /** 外壁 x（机台右框） */
  outerX: number;
  /** 球停道底时的球心 y */
  restY: number;
  /** 交汇处的 y。球道到此为止，也是球真正出射的位置 */
  bendY: number;
  /**
   * 内壁的收头高度 = `bendY − PLUNGER.innerTopDrop`。
   * 提前收头是为了在交汇处留出一扇朝左的出射窗口：
   * 竖直内壁若砌到交汇处，球刚被折向左侧就糊在墙上出不来。
   */
  innerTopY: number;
  /**
   * 交汇处的出射弹道。**这就是「力度 → 落点」的全部**：
   * 球沿球道爬到交汇处后按这里的参数折向左上方飞进主盘。
   *
   * 力度同时决定出射速度和仰角（`PhysicsBoard.exitVelocity` 里按比例插值），
   * 玩家只读一个数。出射速度跟着每关重力走——重力 −62 到 −88 跨度四成，
   * 用绝对值的话重力大的关卡满弹会直接撞左壁。
   */
  exit: {
    /** 最弱一发的出射速度 */
    weakSpeed: number;
    /** 满档的出射速度 */
    fullSpeed: number;
    /** 最弱一发的仰角（度，0 = 正水平朝左，90 = 竖直朝上） */
    weakAngleDeg: number;
    /** 满档的仰角 */
    fullAngleDeg: number;
  };
  /** 力度下限 */
  minPower: number;
  /** 力度上限：按重力实算，保证最弱一发也爬得到交汇处 */
  maxPower: number;
}

export interface ExpandedStage {
  id: string;
  name: string;
  /** **含弹射道**的机台总宽。相机取景和侧壁位置都读它，不是 `StageBoardDef.width` */
  width: number;
  /**
   * 外壳（漆木机台）的中心与半宽。**和 `width` 不是一回事**。
   *
   * `width` 是「外壁 + 外框余量」，只描述右边有多远；而球道是挂在主盘右边的一条，
   * 主盘内容仍然以 x=0 为中心。于是机台外壳真正的跨度是
   * `[−(主盘左缘 + 余量), +(球道外壁 + 余量)]`，**中心不在 0 上**。
   *
   * 第一版拿 `width / 2` 当半宽、中心取 0，画出来就是「木框只盖住主盘、
   * 球道两条金轨浮在机台外面」，底槽最左最右两个还各被框壁切掉一半
   * （实机截图 stage_01：铜槽缺左半、金槽缺右半）。
   */
  caseCenterX: number;
  caseHalfWidth: number;
  height: number;
  gravity: number;
  /** 主盘（不含球道）内容原本占的右缘，用来定位球道 */
  playRightX: number;
  /** 主盘内容原本占的左缘。出界判定要分别用左右两侧，不能拿总宽反推 */
  playLeftX: number;
  plunger: PlungerGeom;
  walls: WallDef[];
  /**
   * 可操作的翻板。**已经从 `walls` 里摘出去了**——
   * 同一面几何体不能既当静态墙又当运动学体建两次，否则 Rapier 里有两个重叠碰撞体，
   * 球会被夹在中间弹飞。
   *
   * 枢轴取自原 horn 条的**外端**（左板取左端、右板取右端），
   * 于是翻板弹起时的扫掠范围正好覆盖中央落球区，而静止姿态与原布局逐字节一致，
   * 12 关调好的落点分布不会被这一版改动搅动。
   */
  flippers: FlipperGeom[];
  pegs: PegDef[];
  zones: ZoneDef[];
  slots: SlotDef[];
  weakPoint: { x: number; y: number; r: number };
  boss: StageDef['boss'];
  rules: StageDef['rules'];
  recovery: RecoveryRules;
}

/**
 * 阵型中心距系数。中心距 = r × CELL，两钉表面留 (CELL-2)r = 0.55r 的缝。
 * 球半径必须小于这个缝才穿得过去，所以 **CELL 不能再往下调**。
 * 下面每种新形状的排布都以这个系数为基准，改形状时按比例缩放，不要写死像素值。
 */
const CELL = 2.55;

/**
 * 密排形状（雪炮 / 漏斗）的间距系数。
 *
 * `u = r × CELL` 的净缝只有 0.55r，对 r=0.25 的钉来说只有 0.1375 —— 远小于
 * 球能滚过去的缝（BALL_NEST × 0.33 ≈ 0.38）。照 u 排的结果是每两颗钉之间
 * 都有一道「球刚好卡住、却差一点点钻不过去」的缝，钉阵越密卡得越死。
 *
 * 这两种形状是**开放**的（V 形、雪炮没有围合），挤一点反而是设计意图。
 */
const DENSE = 1.45;

/**
 * 围合形状（环 / 螺线 / 蜂窝 / 棋盘 / 阶梯 / 波带）的间距系数。
 *
 * 这几个和 DENSE 不是一回事，得分开看：它们会围出一块「里面」，球要能从
 * 外面**进得去**。球径 0.66，钉径 2r，所以环上相邻两钉的中心距必须 ≥ 2r + 0.66；
 * 对 r=0.25 来说是 1.18，也就是 ≥ 4.7r，而 `u` 只有 2.55r——**差了近一倍**。
 *
 * 之前这些形状按 DENSE（3.7r）排，环上的净缝只有 0.44 < 球径 0.66：
 * 一道闭合的钉环就是一道球永远穿不过去的墙。探针实测大名府关 100% 超时、
 * 热点 (1,18)——球卡在螺线圈外面下不去，不是卡在缝里，是整层过不去。
 *
 * PASS 排完净缝 ≈ 0.74（r=0.25），球有富余量穿过去。
 */
const PASS = 1.95;

/** 把一行的抽象定义展开为具体钉板；stagger 让相邻行错开，形成柏青哥钉阵。 */
export function expandPegRow(row: PegRowDef, rowIndex: number, out: PegDef[]): void {
  const offset = row.stagger && rowIndex % 2 === 1 ? row.step / 2 : 0;
  const n = Math.max(1, Math.floor((row.toX - row.fromX) / row.step) + 1);
  for (let i = 0; i < n; i++) {
    const x = row.fromX + offset + i * row.step;
    if (x > row.toX + 1e-6) break;
    const blocked = row.gaps.some((g) => Math.abs(x - g.x) < g.r);
    if (blocked) continue;
    out.push({
      id: `peg_r${rowIndex}_${i}`,
      x: Number(x.toFixed(4)),
      y: row.y,
      r: row.r,
      kind: row.kind,
      value: 1,
    });
  }
}

function pushFormation(f: PegFormationDef, out: PegDef[]): void {
  const u = f.r * CELL;
  const add = (dx: number, dy: number): void => {
    out.push({
      id: `peg_${f.id}_${out.length}`,
      x: Number((f.cx + dx).toFixed(4)),
      y: Number((f.cy + dy).toFixed(4)),
      r: f.r,
      kind: f.kind,
      value: f.score ?? 2,
      hp: f.hp,
      wuxing: f.wuxing,
    });
  };

  switch (f.shape) {
    case 'diamond':
      add(0, 0);
      add(-u, 0);
      add(u, 0);
      add(0, u);
      add(0, -u);
      add(-u, u);
      add(u, u);
      add(-u, -u);
      add(u, -u);
      break;
    case 'triangle':
      add(0, 0);
      add(-u, 0);
      add(u, 0);
      add(-u * 1.5, -u * 0.866);
      add(u * 1.5, -u * 0.866);
      add(0, -u * 1.732);
      add(-u * 2.5, -u * 1.732);
      add(u * 2.5, -u * 1.732);
      break;
    case 'cross': {
      const arms = f.arms ?? 4;
      // 不放中心钉：球会卡在中心钉与臂钉之间的窄缝里。
      // 臂钉落在坐标轴上（phase 默认为 0）而不是 45°，这样任意一颗臂钉的顶部
      // 都没有左右两颗钉构成 V 形凹坑 —— 球落到哪颗臂钉上都会自己滚落。
      // 这条约束让 cross 成为「安全阵型」，配合 phase 仍可做斜向排布。
      for (let i = 0; i < arms; i++) {
        const a = (Math.PI * 2 * i) / arms + (f.phase ?? 0);
        add(Math.cos(a) * u, Math.sin(a) * u);
      }
      break;
    }
    case 'ring': {
      // 环的每圈**颗数由弧长反推**，不能写死 4+4k：
      // 内圈半径小，颗数一多相邻钉就直接相交（两颗钢钉物理上重叠，
      // 球挤过去会被 Rapier 的分离冲量弹飞，轨迹完全不可预测）。
      // 每圈按「弧长 / 间距」取整并向下取整，宁可稀一点也不许相交。
      //
      // 环是**开口的**（下方留 70° 缺口）。闭合的钉环就是一道墙——即使间距
      // 够球穿过去，球也得先能「找得到」那道缝；开口的月牙形既好认又必然能进。
      const rings = f.rings ?? 2;
      const step = u * PASS;
      const sweep = 250 * (Math.PI / 180); // 下方缺口 = 360 - 250 = 110°
      const start = -Math.PI / 2 - sweep / 2; // 缺口正对 -90°（正下方）
      for (let k = 0; k < rings; k++) {
        const rr = u + k * step;
        const count = Math.max(4, Math.floor((sweep * rr) / step));
        for (let i = 0; i < count; i++) {
          const a = start + (sweep * i) / Math.max(1, count - 1) + (f.phase ?? 0);
          add(Math.cos(a) * rr, Math.sin(a) * rr);
        }
      }
      break;
    }
    case 'wall': {
      // 横垒是一道**必须穿过去**的屏障，间距不能拿嵌套着玩的 CELL。
      // CELL 下的净缝只有 0.14（r=0.26），球骑在上面就下不来。
      //
      // 而且横排的钉是**一条水平面**——球落上去会顺着整排滚到头才掉，
      // 探针里 stage_07 的热点 (-1,10) 一次就刷 81 次就是这么来的。
      // 所以钉位要砖砌错位：奇偶交替高低 0.3，球永远找不到一条能躺平的面，
      // 每一颗钉下面都留着缝，它只会一颗一颗往下漏。
      const count = f.count ?? 5;
      const step = u * DENSE;
      const span = f.span ?? (count - 1) * step;
      const zig = u * 0.32;
      for (let i = 0; i < count; i++) {
        add(-span / 2 + (span * i) / Math.max(1, count - 1), i % 2 ? -zig : zig);
      }
      break;
    }

    /* ------------------------------------------------------------------ *
     *  以下 7 种是关卡布局差异的主要来源。每种都对应一种明确的打法，
     *  注释里写的是「这形状在物理上把球往哪儿赶」。
     *
     *  这几种一律用 PASS 间距而不是 u：u 的净缝只有 0.55r，对 r=0.25 的
     *  钉来说是 0.14 —— 远小于球能滚过去的 0.38，会在每两颗钉之间挖出一条
     *  球刚好卡住、却差一点点钻不过去的缝。写得再省事也不能省这个系数。
     * ------------------------------------------------------------------ */

    case 'chevron': {
      // 雪炮 / V 形导流：两条臂向上张开。球从中间穿过时被臂钉一路往下外侧赶。
      // **臂顶不封口**——封了就成 V 形凹坑，球会停在那里。
      // 同层左右两颗臂钉的距离是 2·step·cos(角)，角太大（>78°）两臂就会贴到一起，
      // 所以这里对角度夹一道上限，而不是相信调用方会传一个安全的值。
      const n = f.count ?? 5;
      // 臂上用 PASS 而不是 DENSE：球是**贴着臂滚**的，臂上两颗钉的净缝必须大于球径。
      // DENSE 下净缝只有 0.42 < 0.66，球骑上臂就卡在两颗钉之间下不来——
      // 探针里 stage_02 / stage_12 的头号热点都正好落在雪炮的臂上。
      const step = u * PASS;
      const a = Math.min(78, f.angleDeg ?? 55) * ((Math.PI / 180) as number);
      const c = Math.cos(a);
      const s = Math.sin(a);
      for (let i = 0; i < n; i++) {
        const d = (i + 1) * step;
        add(-d * c, d * s);
        add(d * c, d * s);
      }
      break;
    }
    case 'funnel': {
      // 漏斗：上宽下窄，两侧斜钉把球挤向正中。
      // 收口宽度必须以「钉径 + 球能过的缝」为下限：`halfMin = r + 1.15·R/2`。
      // 之前按 0.45u 收口，对 r=0.26 算出来两钉相距 0.30 而钉径就有 0.52——
      // 收口最后一级直接是两颗相交的钢钉。
      const n = f.count ?? 6;
      // 漏斗壁同理：球顺着斜面被挤下来，壁上的缝必须容得下球。
      const step = u * PASS;
      const a = ((f.angleDeg ?? 62) * Math.PI) / 180;
      const wide = (f.span ?? n * step * 0.5) / 2;
      const halfMin = f.r + 0.22;
      const drop = step * 0.5;
      for (let i = 0; i < n; i++) {
        const t = i / Math.max(1, n - 1);
        const half = Math.max(halfMin, wide * (1 - t) + halfMin * t);
        const y = -i * drop;
        // 反向漏斗（招安关）：angleDeg 给小值，skew 就朝内收，两臂变成扩口
        const skew = i * drop * (Math.tan(a) * 0.35);
        add(-half - skew, y);
        add(half + skew, y);
      }
      break;
    }
    case 'spiral': {
      // 阿基米德螺线：球一进圈就被连着弹，弹出的方向持续旋转。
      //
      // 步长必须按**弧长**给，而不是按固定角度采样。写死步数的话，
      // 半径趋近 0 时 `u/radius` 会爆到几十弧度，几十颗钉全糊在盘心一点上，
      // 直接生成几千对相交的钉。正确做法是迭代推进 dθ = step / r，
      // 并让半径每转增长 step/2π —— 这样任意两点相邻钉的弧长恒等于 step。
      const turns = f.turns ?? 2;
      const step = u * PASS;
      const thMax = turns * Math.PI * 2;
      let r = step;
      let th = f.phase ?? 0;
      let guard = 0;
      add(0, 0); // 中心单独一颗，不参与螺线
      while (th < thMax && guard++ < 600) {
        add(Math.cos(th) * r, Math.sin(th) * r);
        const dth = step / r; // r 只增不减 ⇒ dth ≤ 1，中心不会打转
        th += dth;
        r += (step * dth) / (2 * Math.PI);
      }
      break;
    }
    case 'hex': {
      // 六边蜂窝：密排但不留凹坑——蜂窝的每个空隙都被三颗钉围成三角形，
      // 三角形是**稳定**的（球会沿边滚走），不像 V 形凹坑那样把球兜住。
      // 横向间距比纵向宽，因为奇数行要整体错半格，错位后斜向邻居才是最近的。
      const rows = f.rows ?? 3;
      const cols = f.count ?? 4;
      const sx = u * PASS;
      const sy = u * PASS * 0.87;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const x = (i - (cols - 1) / 2) * sx + (j % 2 ? sx / 2 : 0);
          const y = (j - (rows - 1) / 2) * sy;
          add(x, y);
        }
      }
      break;
    }
    case 'wave': {
      // 正弦波带：钉阵整体起伏，球顺着波谷走，形成一条可预测的「轨道」。
      // 波长必须 ≥ 6 钉距，否则波谷比球径还窄，球会卡在波谷里。
      const count = f.count ?? 9;
      const step = u * PASS;
      const amp = f.amp ?? u * 0.7;
      const waveLen = Math.max(6, f.waveLen ?? 6) * step;
      for (let i = 0; i < count; i++) {
        const x = (i - (count - 1) / 2) * step;
        add(x, Math.sin((x / waveLen) * Math.PI * 2 + (f.wavePhase ?? 0)) * amp);
      }
      break;
    }
    case 'stair': {
      // 阶梯：每级台阶横向一排，逐级向右下错开。球要么一路走到底，
      // 要么在每一级的转角被弹上去——两级之间**不做转角封堵**。
      const steps = f.count ?? 4;
      const per = f.perStep ?? 3;
      const step = u * PASS;
      const dy = -step * 0.62;
      const dx = step * 0.7;
      for (let s = 0; s < steps; s++) {
        for (let i = 0; i < per; i++) {
          add(-dx * (steps - 1) / 2 + s * dx + (i - (per - 1) / 2) * step, s * dy);
        }
      }
      break;
    }
    case 'lattice': {
      // 棋盘：疏密相间。间距取 1.3×PASS ≈ 6.5r，是全场最空的阵型——
      // 用在需要「让球顺利穿过、只做计数」的段落，或者当整关的减压区。
      // phase > 0.5 时抽掉 (i+j) 奇数的格子，变成真正的棋盘缺口。
      const rows = f.rows ?? 3;
      const cols = f.count ?? 4;
      const step = u * PASS * 1.3;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          if ((i + j) % 2 === 1 && (f.phase ?? 0) > 0.5) continue;
          add((i - (cols - 1) / 2) * step, (j - (rows - 1) / 2) * step);
        }
      }
      break;
    }
  }
}

/**
 * 入替区（盤底收口）。真柏青哥的盤口正上方都有一片**细杆密钉**叫入替，
 * 它不是装饰：球从主钉阵冲下来，靠这片密钉一路磕碰着「磨」进槽口。
 *
 * 没有它会怎样，实测过（stage_01，14 颗球逐帧）：
 *   盘面最后排钉在 y=8.0，槽口在 y=2.5，中间 **5.5bu 什么都没有**。
 *   球从 y=7.7 一路自由落体到 y=3.4，vy 从 -19 单调增到 -30，**全程零碰撞**，
 *   砸到滚落钉排后以 **-31.6 bu/s** 进槽，一帧之内原地消失。
 *   球半径 0.33，31.6 bu/s = 每秒走过 95 个球半径 —— 玩家只看见「一眨眼没了」，
 *   这就是「落槽不像自然掉落」。
 *   12 关全是这个毛病：y=3.88 往上整 4.7~8.1bu 全宽空带（外部进程加的滚落钉排
 *   把洞缩小了一点，但没填上）。
 *
 * 下面这套参数不是拍脑袋，是按递推算的。球每穿过一排，掉速后按恢复系数 e
 * 反弹，再落 `rowGap` 又被重力加速：
 *
 *     v' = e · √(v² + 2g·rowGap)
 *
 * 不动点 v\* = e·√(2g·rowGap)/√(1-e²)。取 e≈0.49（钢珠撞钢钉，见 PHYSICS
 * 的 ballRestitution）、rowGap 1.5 → v\* ≈ 8.2 bu/s。从 35 bu/s 冲下来的话，
 * 三排就能收敛到 ~10 bu/s，也就是**每秒 30 个球半径**——球开始「滚」着进槽，
 * 一秒能看完，好判断落点。
 *
 * 横向：净缝 = step - 2r = 1.2 - 0.34 = 0.86bu，球径 0.66 的 1.30 倍。
 * 球过得去，但每次都要蹭到两侧的杆，能量就是这么一路磨掉的。
 * 奇偶排错开半个步长，免得出现一条直通到底的竖缝。
 *
 * **底部活跃区（`BOTTOM.keepOutY` 以下）是禁入的**：那一段被翻板扫掠扇形和
 * 滚落随机钉阵占满，补进去的入替钉会压在板上（板上钉的失败模式见 `pushIzo`
 * 里的长注释）。所以 12 关的入替区现在基本只在**中场空带**里出现；
 * 底部的耗能改由 `scripts/genstages.ts` 的 `scatterRows` 那一排滚落钉承担。
 */
const IZO = {
  /** 钉半径。比主阵细——入替钉在真机台上就是细杆，视觉和手感都靠「密」不靠「粗」 */
  r: 0.17,
  /** 横向中心距。净缝 = 1.2 - 2×0.17 = 0.86 = 球径 0.66 的 1.30 倍 */
  step: 1.2,
  /**
   * 纵向排距，决定收敛速度 v\* ≈ 6.84·√rowGap（见上）。
   *
   * 取 1.1 是为了在**同一道缝里多塞一排**：两排错开半步时球要同时躲过两道缝
   * 才可能直穿，三排把竖缝错成折线之后直穿基本消失，收敛速度也从 9.4 降到
   * 7.2 bu/s。这对中场空带（缝高 2~4bu）成立；底部活跃区那道缝已经被
   * `keepOutY` 卡掉，一个钉都不会铺。
   */
  rowGap: 1.1,
  /** 离侧壁的余量，别把钉顶到墙上 */
  edgeGap: 0.5,
  /**
   * 空带至少这么高才补。
   * 已经排得够密的盘（入替区本来就在那儿）不重复加钉。
   */
  minVoid: 1.8,
  /** 上限。防止某关空带异常高时铺出一整片钢钉墙 */
  maxRows: 4,
} as const;

/**
 * 找出「底部结构簇」和「主钉场」之间那道竖直空隙。
 *
 * 不用「横向覆盖率」判空：那套判据在钉排间距 1.5~4.6bu 的盘上一律判成没铺满，
 * 整段从槽口到盘顶都算空带，取出来的「最大空带」是整个下半张盘，毫无意义。
 *
 * 改成按**钉的纵向区间聚簇**：
 *   1. 每枚钉占一个 [y-r, y+r] 区间，区间相交就并成一簇（底部那道滚落钉排
 *      和压在它上面的破绽十字本来就咬在一起，是一簇，不是两簇）
 *   2. 簇按高度排序
 *   3. 从下往上找第一道超过 minVoid 的缝，那就是球自由落体的那一段
 *
 * stage_01：底簇 {3.55 滚落排, 4.2 破绽十字} 顶到 4.52，主场下一排在 8.28
 *           → 缝 3.44bu，球在这儿从 ~19 加速到 ~30 bu/s，无碰撞
 * stage_07：底簇顶到 4.82，主场下一排在 8.5 → 缝 3.68bu
 */
function bottomVoid(pegs: PegDef[]): { top: number; bottom: number } | null {
  const spans = pegs.map((p) => [p.y - p.r, p.y + p.r] as const).sort((a, b) => a[0] - b[0]);
  const clusters: { lo: number; hi: number }[] = [];
  for (const [lo, hi] of spans) {
    const last = clusters[clusters.length - 1];
    // 留 0.15bu 容差：两枚钉的区间差一点点没咬上时，仍然算同一簇，
    // 否则 0.1bu 的缝会被当成一道值得填的空带，铺进去一排纯干扰钉
    if (last && lo <= last.hi + 0.15) { if (hi > last.hi) last.hi = hi; }
    else clusters.push({ lo, hi });
  }
  for (let i = 0; i < clusters.length - 1; i++) {
    const gap = clusters[i + 1]!.lo - clusters[i]!.hi;
    if (gap >= IZO.minVoid) return { top: clusters[i]!.hi, bottom: clusters[i + 1]!.lo };
  }
  return null;
}

/**
 * 在盘底最大的那道竖直空隙里补入替区。
 *
 * 刻意放在 pushFormation **之后**：冲突消解按生成顺序保留先出现的，
 * 作者写好的关键阵型（破绽十字、敌人钉、金钉）必须压过自动补出来的入替钉。
 * 真撞上了也是消解器把入替钉丢掉，而不是反过来。
 *
 * 横向只扫主盘（playLeftX..playRightX），不扫球道：球道整条是空的，
 * 入替钉铺进去会把发射管堵死。
 */
function pushIzo(stage: StageDef, geom: { playLeftX: number; playRightX: number },
  authored: PegDef[], out: PegDef[]): number {
  if (!stage.board.slots.length) return 0;
  const slotTop = Math.max(...stage.board.slots.map((s) => s.y + s.h / 2));
  // playLeftX 对外暴露的是**正幅度**（见 buildPlunger 里的 -left），左边界要自己变号
  const left = -geom.playLeftX, right = geom.playRightX;
  if (right - left < IZO.step) return 0;

  const hole = bottomVoid(authored);
  if (!hole) return 0;
  /*
   * 入替区的下界是**底部活跃区**，不是槽口。
   *
   * `BOTTOM.keepOutY` 是底部那一套结构（滚落随机钉阵 + 翻板扫掠扇形）的上沿，
   * `scripts/genstages.ts` 用它把作者写的行/阵型顶上去。运行时补的入替钉
   * 必须守同一条线 —— 这是**上一版踩爆的坑**：
   *
   * 翻板是运动学体、钉是静态体。板弹起时扫过的扇形若压到一颗钉，Rapier
   * **不会把它们推开**，板直接穿过去，球被夹在中间乱弹直到停死。
   * 实测（把 `lo` 只写成 `slotTop` 的那一版）：`izo_*` 在 stage_12 铺到了
   * y=4.29 / 5.39 / 6.49 三排，第三排有 8 颗正好落在左板扫掠扇形里，
   * 全关停死率 42%、落槽率从 92% 掉到 33%，而**没有任何一层会报这个错**：
   * 生成期的 `checkBottom` 只看得见 JSON 里 authored 的钉，
   * 而 izo 是 `expandStage` 运行时才铺出来的。
   *
   * 所以两条防线都要有：
   *   1. 这里 —— 入替钉不得越过 `keepOutY`（底部活跃区是它的净空）；
   *   2. `scripts/genstages.ts` 的 `checkBottom` —— 复查**展开后**的钉列表，
   *      以后再加任何运行时生成的钉也会被拦下。
   */
  const lo = Math.max(slotTop, BOTTOM.keepOutY, hole.top), hi = hole.bottom;
  if (hi - lo < IZO.minVoid) return 0;

  const rows = Math.min(IZO.maxRows, Math.floor((hi - lo) / IZO.rowGap));
  let added = 0;
  for (let row = 0; row < rows; row++) {
    const y = Number((lo + IZO.rowGap * (row + 0.5)).toFixed(3));
    if (y + IZO.r > hi - 0.1) break;
    const offset = row % 2 === 1 ? IZO.step / 2 : 0;
    for (let x = left + IZO.edgeGap + offset; x <= right - IZO.edgeGap + 1e-6; x += IZO.step) {
      out.push({
        id: `izo_${row}_${added}`,
        x: Number(x.toFixed(4)),
        y,
        r: IZO.r,
        // 普通钉：只挡球，不结算。入替区的职责是耗能，不是给伤害
        kind: 'normal',
        value: 1,
      });
      added++;
    }
  }
  return added;
}

export function expandStage(stage: StageDef): ExpandedStage {
  const pegs: PegDef[] = [];
  stage.board.pegRows.forEach((row, i) => expandPegRow(row, i, pegs));
  for (const f of stage.board.pegFormations) pushFormation(f, pegs);
  // 入替区最后补，冲突时让位给作者写好的阵型
  pushIzo(stage, buildPlunger(stage, pegs), pegs, pegs);

  // 去重：同一坐标只保留一枚钉板，避免形成处与行重叠成不可解的死结
  const seen = new Set<string>();
  const clean: PegDef[] = [];
  for (const p of pegs) {
    const key = `${p.x.toFixed(2)}:${p.y.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(p);
  }

  // 冲突消解：两颗钉相交时丢掉后出现的那一枚。
  //
  // 为什么不靠人手调坐标：写关卡时「把这套阵挪到那边去」和「让那套阵小一点」
  // 是一遍遍试出来的，而相交是**局部**问题——第一关里 `en_earth` 的十字压在
  // `spear_c` 的三角上，看着毫无关系，肉眼扫一百枚钉根本看不出来。
  //
  // 保留顺序 = 钉的生成顺序 = 横排优先、阵型按声明顺序，所以关卡作者把关键
  // 阵型写在前面就能保住它，被挤掉的一定是后来叠上去的那一枚。
  //
  // 相交的钢钉在 Rapier 里是两个互相穿插的静态碰撞体，球挤过去会被分离冲量
  // 弹飞，轨迹完全不可预测——这是必须拦在运行时的一道闸，不能只靠作者自觉。
  const kept: PegDef[] = [];
  for (const p of clean) {
    let clash = false;
    for (const q of kept) {
      const dx = q.x - p.x;
      if (Math.abs(dx) > q.r + p.r + 0.02) continue;
      const dy = q.y - p.y;
      if (dx * dx + dy * dy < (q.r + p.r + 0.02) ** 2) {
        clash = true;
        break;
      }
    }
    if (!clash) kept.push(p);
  }

  const elementCounts = new Map<string, number>();
  for (const peg of kept) {
    if (peg.kind !== 'enemy') continue;
    const element = peg.wuxing ?? 'metal';
    const ordinal = elementCounts.get(element) ?? 0;
    peg.enemyId = enemyCardForStage(element, stage.id, ordinal).id;
    elementCounts.set(element, ordinal + 1);
  }

  const geom = buildPlunger(stage, kept);

  /*
   * 翻板从静态墙里分流出去。
   *
   * 必须在**建碰撞体之前**分掉，而不是建完再删：同一面几何体在 Rapier 里
   * 出现两次（一次固定、一次运动学），球撞上去会被两个求解器同时推，
   * 结果是弹开后立刻又被另一个体弹一下——玩家看到的是球在原地抽搐。
   */
  const allWalls = [...stage.board.walls, ...stage.board.deflectors];
  const flippers: FlipperGeom[] = [];
  const walls: WallDef[] = [];
  for (const w of allWalls) {
    const f = flipperFromWall(w);
    if (f) flippers.push(f);
    else walls.push(w);
  }

  return {
    id: stage.id,
    name: stage.name,
    width: geom.width,
    caseCenterX: geom.caseCenterX,
    caseHalfWidth: geom.caseHalfWidth,
    height: stage.board.height,
    gravity: stage.board.gravity,
    playRightX: geom.playRightX,
    playLeftX: geom.playLeftX,
    plunger: geom.plunger,
    walls,
    flippers,
    pegs: kept,
    zones: stage.board.zones,
    slots: stage.board.slots,
    weakPoint: stage.boss.weakPoint,
    boss: stage.boss,
    rules: stage.rules,
    recovery: { ...RECOVERY_POOL, ...stage.rules.recovery },
  };
}

/**
 * 把弹射道叠到盘面内容右侧，并算出含球道的机台总宽。
 *
 * 步骤（每一步的余量都对应一个真实的失败模式）：
 *
 * 1. **量内容右缘**：钉 / 槽 / 带 / 导流板都算进去。槽口和带子是平铺满盘宽的，
 *    只量钉子会让球道压到槽口上——而球落进槽口就是结算，压上去等于球一进盘就结算。
 * 2. **内壁 = 右缘 + innerMargin**：球在道顶拐弯时会横向漂一点，留 0.9 的缓冲，
 *    不然高速球擦着内壁拐进主盘，轨迹会被碰撞求解器抖成不可预测的。
 * 3. **外壁 = 内壁 + laneWidth**：球道净宽固定 2.7，球径 0.66，左右各留 1.0 活动量。
 * 4. **总宽 = 外壁 + outerMargin，对称镜像**：机台左右两边留一样宽，
 *    否则球道那侧会明显比另一侧厚。
 *
 * 力度上限按重力反推（`plungerMaxPower`）：球道全长约 30bu，
 * -88 重力下需要 v ≈ 76 才冲得过道顶，比旧发射器的 30 高出一倍多——
 * 所以 `BASE_MAX_SPEED` 必须同步抬高，否则球刚出杆就被限速按死。
 */
function buildPlunger(
  stage: StageDef,
  pegs: PegDef[],
): { width: number; caseCenterX: number; caseHalfWidth: number; playRightX: number; playLeftX: number; plunger: PlungerGeom } {
  let right = 0;
  let left = 0;
  const eat = (x: number, half: number): void => {
    right = Math.max(right, x + half);
    left = Math.min(left, x - half);
  };
  for (const p of pegs) eat(p.x, p.r);
  for (const s of stage.board.slots) eat(s.x, s.w / 2);
  for (const z of stage.board.zones) eat(z.x, z.w / 2);
  for (const w of [...stage.board.walls, ...stage.board.deflectors]) {
    // 旋转后的包围盒：把半宽半高按 |cos|/|sin| 投影，防止斜置导流板伸出计算的右缘之外
    const rad = ((w.rotDeg ?? 0) * Math.PI) / 180;
    eat(w.x, Math.abs(Math.cos(rad)) * w.w + Math.abs(Math.sin(rad)) * w.h);
  }
  // 导流罩：旧发射器时代挂在盘顶两侧的那两条，它们比任何关卡数据都靠外
  right = Math.max(right, stage.board.width / 2 - 0.3);

  const innerX = right + PLUNGER.innerMargin;
  const outerX = innerX + PLUNGER.laneWidth;
  // 道底地板顶面 = 0.4 + floorHalf，球停在它上面 restHeight 处（球**底面**离地）
  const floorTop = 0.4 + PLUNGER.floorHalf;
  const restY = floorTop + PLUNGER.restHeight + PHYSICS.ballRadius;

  /*
   * 交汇处。球道到此为止，也是球**真正出射**的位置。
   *
   * 整套机制是：拉杆 → 球沿竖直球道真爬上来 → 到交汇处按力度折向左上方飞走。
   * 球道那一段是真物理（看得见球被顶上去），但它只负责「把球送到交汇处」；
   * 决定落点的是交汇处的出射弹道，不是球道里的速度。
   *
   * **为什么中间不需要斜坡、也不撒横向冲量**：竖直通道必然吃掉横向速度
   * （早期版本实测球到顶时 `vx` 只剩 −1.0bu/s，落点散度 0.1bu，力度对落点
   * 完全没有影响）。速度在通道里守不住，就不要指望它——让交汇处直接按
   * 力度给定出射速度，映射关系从「碰撞巧合」变成「一条插值曲线」。
   *
   * 内壁提前 `innerTopDrop` 收头，在交汇处留出朝左的窗口；
   * 外壁砌到交汇处，给球一个「它还在道里」的上边界。
   *
   * **高度必须跟着钉阵顶走，不能只按「离天花板多远」定**：
   * stage_01 的钉子最高一颗在 y=28.6，而按顶盖余量算出来的交汇处只有 27.0 ——
   * 球一出射就已经在钉阵内部了，第一个碰到的永远是那几颗最高的钉子，
   * 力度对进场点完全没有影响（实测 12 关里唯一失效的一关，落差 0.1bu）。
   * 所以取「顶盖余量」和「钉阵顶 + 让位」里更高的那个。
   */
  const topContent = Math.max(
    0,
    ...pegs.map((peg) => peg.y + peg.r),
    ...stage.board.zones.map((z) => z.y + z.h / 2),
  );
  const bendY = Math.max(
    stage.board.height - PLUNGER.bendDropFromTop,
    topContent + PLUNGER.junctionClearance,
  );
  const innerTopY = bendY - PLUNGER.innerTopDrop;

  /*
   * 力度区间：只保证球爬得到交汇处。出射弹道另算，两件事互不干涉。
   *
   * 出射速度用**爬升临界速度**做基准而不是绝对值：重力从 −62 到 −88 跨度四成，
   * 绝对值会让重力大的关卡满弹直接撞左壁、弱弹连主盘都进不去。
   * 用同一个临界速度当尺子，12 关的落点区间就一致了。
   */
  const climb = bendY - restY;
  const range = plungerPowerRange(stage.board.gravity, climb);
  const critical = climbSpeedFor(stage.board.gravity, climb, PLUNGER.laneDamping);

  /*
   * 机台宽度。**不是**把球道加在主盘右边就完事——那样机台会变成「主盘偏左、
   * 右边挂一条道」的不对称形状，左侧凭空多出一大片空地，摄像机取景也跟着歪。
   *
   * 正确做法是把**整个机台**（主盘 + 球道）一起居中：
   * 主盘内容居中在 0，球道挂在右边，总宽 = 右缘 + 外框余量，
   * 于是左壁要退到 `−(右缘 + 余量)`，和右壁对称。
   * 所以 `width` 既是总宽，也是两侧侧壁的位置依据。
   */
  const outerEdge = outerX + PLUNGER.outerMargin;

  /*
   * 外壳跨度。**中心不在 0 上**。
   *
   * 主盘内容（钉 / 槽 / 带 / 导流罩）仍然以 x=0 为中心，球道挂在它右边。
   * 所以外壳要罩住的区间是 `[左缘 − 余量, 外壁 + 余量]`：
   * 右边罩住球道，左边跟右边一样厚，球道才像是长在机台上而不是贴在旁边。
   *
   * **注意 `left` 本身就是负的左缘坐标**（`eat` 里 `left = Math.min(left, x - half)`），
   * 而对外暴露的 `playLeftX` 是它的**正幅度**（`-left`）。这里要的是前者，
   * 再取一次负会把外壳缩成球道那么窄、整体挪到右边去（实测 caseHalfWidth 3.3、
   * 中心 15.66，整台机罩不住自己的盘面）。
   *
   * 这一段是纯视觉几何，不参与任何物理判据 —— 侧壁位置在 `PhysicsBoard` 里
   * 按 `playLeftX` / `plunger.outerX` 单独算，两者各管各的，别合并。
   */
  const caseLeft = left - PLUNGER.outerMargin;
  const caseRight = outerEdge;

  return {
    width: outerEdge,
    caseCenterX: (caseLeft + caseRight) / 2,
    caseHalfWidth: (caseRight - caseLeft) / 2,
    playRightX: right,
    playLeftX: -left,
    plunger: {
      x: (innerX + outerX) / 2,
      width: PLUNGER.laneWidth,
      innerX,
      outerX,
      restY,
      bendY,
      innerTopY,
      exit: {
        weakSpeed: critical * PLUNGER.exitSpeedWeak,
        fullSpeed: critical * PLUNGER.exitSpeedFull,
        weakAngleDeg: PLUNGER.exitAngleWeakDeg,
        fullAngleDeg: PLUNGER.exitAngleFullDeg,
      },
      minPower: range.min,
      maxPower: range.max,
    },
  };
}

export function countByKind(pegs: PegDef[], kind: PegKind): number {
  return pegs.filter((p) => p.kind === kind).length;
}

/* ---------------------------------------------------------------------- *
 *  盘面几何审计
 *
 *  写新关卡时唯一会翻车的地方就是「球停得住」：两颗钉的表面缝小于球径时，
 *  球落到那道缝里就会被两颗钉的接触法线夹住，重力把它压在缝里出不来。
 *  这在无头跑单局时看不出来（球速够高直接弹走），到玩家手上就是「一颗球
 *  挂在盘上不动」。
 *
 *  判据（钢球压在两颗钉之间的凹坑里能不能滚出来）：
 *
 *    gap = 圆心距 − ra − rb      （两钉表面之间的净缝）
 *    gap <  BALL_NEST × R        ⇒ 凹坑，标记为窄巷
 *    gap ≤ 0                     ⇒ 两钉相交，几何上球根本过不去，必须修
 *
 *  BALL_NEST 取 1.15：钢球要越过一道竖直窄缝，接触角得小于 ~49°，对应
 *  净缝 < 2R·tan(49°) ≈ 1.15R。超过这个值球就会自己滚下去。
 *
 *  审计只报不改：真正「卡死」与否还要看球的入射速度，所以 smoke 里另有一层
 *  实测兜底（超时卡点热力图）。这里是让人在写关卡时**当场**看见问题的那一层。
 * ---------------------------------------------------------------------- */

export interface LaneAudit {
  /** 两颗钉的 id */
  a: string;
  b: string;
  /** 净缝（世界单位），相交时为负 */
  gap: number;
  /** 缝隙中点 */
  x: number;
  y: number;
  /** 越接近 0 越危险；gap ≤ 0 时为 Infinity */
  severity: number;
}

export interface StageAudit {
  /** 两钉相交：球物理上过不去，且 Rapier 的分离冲量会把球弹飞 */
  overlaps: LaneAudit[];
  /** 净缝 < 1.15R 的凹坑：球可能停在上面 */
  nests: LaneAudit[];
}

/** 凹坑判定的缝宽系数，见上面的推导 */
const BALL_NEST = 1.15;

export function auditLanes(pegs: PegDef[], ballRadius: number): StageAudit {
  const limit = BALL_NEST * ballRadius;
  const overlaps: LaneAudit[] = [];
  const nests: LaneAudit[] = [];

  // 只比邻近的钉：按 x 排序后滑窗，板子宽度量级下 O(n·k) 就够，
  // 不必上空间划分——关卡钉数在百级，全对全也只是 5 万次平方根。
  const sorted = [...pegs].sort((p, q) => p.x - q.x);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (b.x - a.x > limit + a.r + b.r) break;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const gap = d - a.r - b.r;
      const rec: LaneAudit = {
        a: a.id,
        b: b.id,
        gap: Number(gap.toFixed(4)),
        x: Number(((a.x + b.x) / 2).toFixed(3)),
        y: Number(((a.y + b.y) / 2).toFixed(3)),
        severity: gap <= 0 ? Infinity : gap,
      };
      if (gap <= 0) overlaps.push(rec);
      else if (gap < limit) nests.push(rec);
    }
  }
  nests.sort((p, q) => p.severity - q.severity);
  return { overlaps, nests };
}

/** 一行摘要，给 smoke 打印用 */
export function auditSummary(a: StageAudit, top = 4): string {
  const parts: string[] = [];
  if (a.overlaps.length) {
    parts.push(
      `相交 ${a.overlaps.length} 对（最严重 ${a.overlaps
        .slice(0, top)
        .map((o) => `(${o.x},${o.y})`)
        .join(' ')}）`,
    );
  }
  if (a.nests.length) {
    parts.push(
      `窄巷 ${a.nests.length} 处（最窄 ${a.nests
        .slice(0, top)
        .map((n) => `(${n.x},${n.y}) ${n.gap.toFixed(2)}`)
        .join(' ')}）`,
    );
  }
  return parts.length ? parts.join(' / ') : '干净';
}

export function slotById(slots: SlotDef[], id: string): SlotDef | undefined {
  return slots.find((s) => s.id === id);
}
