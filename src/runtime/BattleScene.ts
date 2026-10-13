import * as THREE from 'three';
import { audio } from '../core/Audio.ts';
import { COMBAT, PLUNGER, clamp } from '../core/constants.ts';
import type { Engine } from '../core/Engine.ts';
import { Physics, type ImpactInfo } from '../core/Physics.ts';
import type { CharacterDef, LinkDef } from '../data/schema.ts';
import { BattleSim } from '../sim/BattleSim.ts';
import { expandStage, type ExpandedStage } from '../sim/board.ts';
import { PhysicsBoard } from '../sim/PhysicsBoard.ts';
import type { BallControlState, BattleEvent, BattleSnapshot, SimCommand, StrikePreview } from '../sim/types.ts';
import { BoardView } from './BoardView.ts';
import { BossView } from './BossView.ts';
import { Fx } from './Fx.ts';
import { SkillAim } from './SkillAim.ts';
import { StrikeView } from './StrikeView.ts';

export interface BattleCallbacks {
  onSkillAim?(preview: StrikePreview | null, index: number | null, slowRemaining: number): void;
  onSkillEffect?(character: CharacterDef): void;
  onHud(snap: BattleSnapshot, control: BallControlState): void;
  onFloat(x: number, y: number, text: string, color: string, scale: number): void;
  onFlash(color: string, duration: number): void;
  onFinish(phase: 'victory' | 'defeat', snap: BattleSnapshot): void;
  onAim(angleDeg: number, power01: number, charging: boolean): void;
}

const CHARGE_SECONDS = 0.85;
const REARM_DELAY = 0.75;

/**
 * 追打救球的角度范围。首发不瞄准，所以这里只服务救球那条路。
 *
 * 和 `PhysicsBoard` 里的 `SHOOT_MIN/MAX_ANGLE_DEG` 是同一个物理约束的两处表述：
 * 那边是碰撞层夹一次，这边是瞄准层夹一次。少任何一处都会出现
 * 「HUD 显示的角度和球实际飞的方向不一致」。
 */
const SHOOT_MIN_ANGLE_DEG = 42;
const SHOOT_MAX_ANGLE_DEG = 138;
const SHOOT_MIN_POWER = 17;
const SHOOT_MAX_POWER = 30;

export class BattleScene {
  readonly sim: BattleSim;
  readonly stage: ExpandedStage;

  private readonly engine: Engine;
  private readonly physics: Physics;
  private readonly board: PhysicsBoard;
  private readonly view: BoardView;
  private readonly boss: BossView;
  private readonly fx: Fx;
  private readonly cb: BattleCallbacks;
  private readonly skillAim = new SkillAim();
  private readonly strikeView = new StrikeView();
  private stepAccumulator = 0;


  private aimAngle = 90;
  private charging = false;
  private charge = 0;
  /** 已经蓄满并按住不放的时长，够 `PLUNGER.autoRelease` 就自动弹射 */
  private holdTimer = 0;
  private rearmTimer = 0;
  private finished = false;
  private finishTimer: number | null = null;
  /** 破绽标记的点亮状态缓存，只在翻转时推给 BoardView */
  private markedShown = false;
  private pointerBoard = { x: 0, y: 0 };
  private lastImpactAt = 0;
  private readonly ray = new THREE.Raycaster();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private readonly hitPoint = new THREE.Vector3();

  constructor(
    engine: Engine,
    stageDef: Parameters<typeof expandStage>[0],
    team: CharacterDef[],
    links: LinkDef[],
    cb: BattleCallbacks,
  ) {
    this.engine = engine;
    this.cb = cb;
    this.stage = expandStage(stageDef);
    this.sim = new BattleSim(this.stage, team, links);

    // 取景按**外壳**算，不是按 `stage.width`：球道挂在主盘右边之后机台中心不在 0 上，
    // 拿旧宽度取景会把整条弹射道切在画框外面。
    this.engine.fitBattle(this.stage.caseHalfWidth * 2, this.stage.height, this.stage.caseCenterX);
    this.physics = new Physics(this.stage.gravity);
    this.board = new PhysicsBoard(this.physics, this.stage, {
      canLaunch: () => this.sim.snapshot().phase === 'playing' && this.sim.snapshot().ballsLeft > 0,
      onEvent: (ev) => this.onEvent(ev),
      onPegVisuals: () => this.view.syncPegs(),
    });

    this.view = new BoardView(this.stage, this.board);
    this.boss = new BossView(this.stage.boss);
    this.fx = new Fx();
    engine.scene.add(this.view.group, this.boss.group, this.fx.group, this.strikeView.group);

    // 表现层的撞击反馈：追加监听，不能覆盖 PhysicsBoard 已经挂上的盘面事件通道
    this.physics.addImpact((info: ImpactInfo) => {
      if (this.board.state !== 'live') return;
      // 把撞击点传进去：钉子要**朝远离球的方向**退，球要被压扁。
      // 不给方向的话只能做「闪一下」，接触力在画面上就是零。
      this.view.flashPeg(info.tag.id, info.intensity, info.x, info.y);
      if (this.engineElapsed() - this.lastImpactAt > 0.035) {
        this.lastImpactAt = this.engineElapsed();
        audio.peg(info.intensity, info.tag.kind ?? 'normal');
      }
    });

    this.board.armLauncher();
    this.fx.burst(this.stage.plunger.x, this.stage.plunger.restY, 0xffe9a8, 18, 6, 0.3);
  }

  private engineElapsed(): number {
    return performance.now() / 1000;
  }

  /* ---------------------------------------------------------------- 输入 */

  setPointer(clientX: number, clientY: number): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const ndc = new THREE.Vector2((clientX / w) * 2 - 1, -((clientY / h) * 2 - 1));
    this.ray.setFromCamera(ndc, this.engine.camera);
    if (this.ray.ray.intersectPlane(this.plane, this.hitPoint)) {
      this.pointerBoard = { x: this.hitPoint.x, y: this.hitPoint.y };
      if (this.isAimingSkill) this.skillAim.pointAt(this.board.ballX, this.board.ballY, this.hitPoint.x, this.hitPoint.y);
      else this.updateAimFromPointer();
    }
  }

  private updateAimFromPointer(): void {
    // 首发（球在道底）不瞄准：弹射道是竖直的，落点由力度决定。
    // 只有**追打救球**才需要瞄准，而那必然发生在球已经在盘上滚的时候，
    // 所以直接从球当前位置算方向。
    if (this.board.state === 'idle') return;
    // 从**球的当前位置**算角度，不是从发射器。
    // 球滚到盘面中段时，玩家想打的是「从这儿往那边」，从发射器算出来的角度
    // 会偏掉一整个球到发射器的距离，瞄得越远偏得越离谱。
    const dx = this.pointerBoard.x - this.board.ballX;
    // 始终向上发射：用 dy 的下限夹住，避免玩家把角度压到水平以下
    const dy = Math.max(3, this.pointerBoard.y - this.board.ballY);
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    this.aimAngle = clamp(deg, SHOOT_MIN_ANGLE_DEG, SHOOT_MAX_ANGLE_DEG);
  }

  nudgeAim(delta: number): void {
    if (this.isAimingSkill) {
      this.skillAim.rotate(delta);
      return;
    }
    this.aimAngle = clamp(this.aimAngle + delta, SHOOT_MIN_ANGLE_DEG, SHOOT_MAX_ANGLE_DEG);
  }

  /**
   * 按下 = 开始蓄力。**球还在盘上也允许**——这是新玩法的入口。
   *
   * 之前只在 `board.state === 'idle'`（球已落槽）时才允许，于是每次发射之后
   * 玩家有 5~9 秒完全无法操作。现在「按住」在球的整个生命周期里都有意义。
   */
  setCharging(on: boolean): void {
    if (this.isAimingSkill) return;
    if (on) {
      if (!this.finished && !this.charging && this.board.beginCharge()) {
        this.charging = true;
        this.charge = 0;
        this.holdTimer = 0;
      }
      return;
    }
    if (!this.charging) return;
    this.charging = false;
    this.fire();
  }

  cancelCharging(): void {
    this.charging = false;
    this.charge = 0;
    this.holdTimer = 0;
    this.board.cancelCharge();
  }

  /**
   * 松手。**首发和救球走两条完全不同的路**：
   *
   * - 球在道底（idle）→ `plunge`：竖直弹射，不带角度，力度由蓄力决定。
   * - 球在盘上（live）→ `shoot`：从球的当前位置按瞄准角打出去。
   *
   * 这个分流是「随机入口」能成立的关键：首发一旦也接角度，玩家就会退回到
   * 「移动鼠标选方向再点发射」，那正是这次要换掉的操作方式。
   */
  private fire(): void {
    if (!this.board.canShoot || this.finished) return;
    const bx = this.board.ballX;
    const by = this.board.ballY;
    if (this.board.state === 'idle') {
      const power = this.stage.plunger.minPower +
        (this.stage.plunger.maxPower - this.stage.plunger.minPower) * this.charge;
      this.board.plunge(power);
      audio.plunge(this.charge);
      this.fx.burst(bx, by, 0xffe9a8, 14, 9, 0.26);
      this.engine.shake(0.08 + this.charge * 0.14, 0.14);
    } else {
      const power = SHOOT_MIN_POWER + (SHOOT_MAX_POWER - SHOOT_MIN_POWER) * this.charge;
      this.board.shoot(power, this.aimAngle);
      audio.launch(this.charge);
      this.fx.burst(bx, by, 0xffe9a8, 14, 9, 0.26);
      this.engine.shake(0.08 + this.charge * 0.14, 0.14);
    }
    this.charge = 0;
    this.holdTimer = 0;
  }

  releaseSkill(index: number): void {
    const def = this.sim.team[index];
    if (!def || this.finished || this.board.state === 'done') return;
    this.cancelSkill();
    this.exec(this.sim.releaseSkill(def.id, this.board.ballX, this.board.ballY));
  }

  get isAimingSkill(): boolean { return this.skillAim.selected !== null; }
  get selectedSkill(): number | null { return this.skillAim.selected; }

  /**
   * 第 n 个「键位」对应 team 里的第几个人。
   *
   * 被动技能（公孙胜 / 燕青 / 张顺）不占键位，所以 `Digit1` 不能直接当
   * `team[0]` 用——「公孙胜在 1 号位」会把 Digit2 误指给武松，玩家看到
   * 面板上的数字和实际能按的人对不上。这里按**只数主动角色**重新编号，
   * 让面板印的数字和键位永远一致。返回 -1 表示这个键位没人。
   */
  activeSkillSlot(n: number): number {
    let seen = 0;
    for (let i = 0; i < this.sim.team.length; i++) {
      if (this.sim.team[i]?.skill.trigger.auto) continue;
      if (seen === n) return i;
      seen++;
    }
    return -1;
  }

  private syncSkillClock(): void {
    this.skillAim.syncClock(performance.now() / 1000, this.board.state === 'live');
  }

  beginSkill(index: number): boolean {
    this.syncSkillClock();
    const def = this.sim.team[index];
    if (!def || this.finished || this.board.state === 'done') return false;
    const gauge = this.sim.snapshot().gauges.find((g) => g.charId === def.id);
    if (!gauge || gauge.value < gauge.max) return false;
    this.cancelCharging();
    if (!def.skill.strike) {
      this.releaseSkill(index);
      return false;
    }
    return this.skillAim.begin(index, true);
  }

  confirmSkill(index?: number): boolean {
    this.syncSkillClock();
    const selected = this.skillAim.confirm(index);
    if (selected === null) return false;
    this.strikeView.show(null);
    this.cb.onSkillAim?.(null, null, this.skillAim.slowRemaining);
    if (!this.finished && this.board.state !== 'done') {
      const def = this.sim.team[selected]!;
      this.exec(this.sim.releaseSkill(def.id, this.board.ballX, this.board.ballY, this.skillAim.angleDeg));
    }
    return true;
  }

  cancelSkill(): boolean {
    this.syncSkillClock();
    const canceled = this.skillAim.cancel();
    this.strikeView.show(null);
    this.cb.onSkillAim?.(null, null, this.skillAim.slowRemaining);
    return canceled;
  }

  /**
   * 翻板。Z / X 键和屏幕下方的两块触屏按钮都走这里。
   *
   * 不经过 sim：这个动作**不改任何战斗状态**（不给分、不给伤害、不耗资源），
   * 纯粹是「把球打回去」。走 sim 只会让「按板」多一次事件往返和一次判定分支，
   * 而收益是零。球的真实位移由物理层自己结算，sim 只在真的打中时才被通知。
   */
  pressFlipper(side: 'left' | 'right', down: boolean): void {
    if (this.isAimingSkill) return;
    this.board.pressFlipper(side, down);
  }

  toggleLock(linkId: string): boolean {
    const locked = this.sim.toggleLinkLock(linkId);
    audio.ui();
    return locked;
  }

  /* ---------------------------------------------------------------- 流程 */

  private onEvent(ev: BattleEvent): void {
    if (ev.t === 'launch' || ev.t === 'slotEnter' || ev.t === 'ballRetired') this.syncSkillClock();
    if (ev.t === 'pegHit') {
      const strong = ev.intensity > 0.35;
      // 命中火花按钉种上色：枪阵青、金锭金，其余钢白。
      // 这是「刚才撞到了哪种钉」最早的一帧反馈，比后面的飘字早 100ms，
      // 余光扫到也知道该往哪看。
      const spark = ev.pegKind === 'spear' ? 0x7ad7ff : ev.pegKind === 'golden' ? 0xffd24a : 0xd8e4ff;
      this.fx.burst(ev.x, ev.y, spark, strong ? 5 : 2, 5 + ev.intensity * 9, 0.2);
      if (strong) this.engine.shake(0.04 + ev.intensity * 0.1, 0.1);
    }
    this.exec(this.sim.handle(ev));
  }

  private exec(cmds: SimCommand[]): void {
    for (const c of cmds) {
      switch (c.t) {
        case 'strike':
          this.strikeView.strike(c.preview);
          break;
        case 'restorePegs':
          this.board.apply(c);
          this.view.syncPegs();
          for (const id of c.pegIds) this.view.setEnemyHp(id, 1);
          break;
        case 'destroyPegs':
          this.board.apply(c);
          this.view.syncPegs();
          this.fx.burst(this.board.ballX, this.board.ballY, 0xffb454, 12, 8, 0.28);
          break;
        case 'enemyHp':
          this.view.setEnemyHp(c.pegId, c.ratio);
          break;
        case 'setGhostKinds':
        case 'setGravityScale':
        case 'setSpeedScale':
        // 下面四条是技能配方新增的物理通道：弹性 / 阻尼 / 速度下限 / 持续外力。
        // 必须显式落到 PhysicsBoard——switch 没有 default，漏一个 case 不报错，
        // 表现是「技能放出去了但球一点没变」，这种静默失败最难查。
        case 'setBounceScale':
        case 'setDampingScale':
        case 'setSpeedFloor':
        case 'setForce':
        case 'boostBall':
        case 'bossPhase':
          this.board.apply(c);
          if (c.t === 'bossPhase') {
            /*
             * 相位不再有「护甲 / 发飙」两种形态，只剩一条线：这一相位拿走了什么。
             * Boss 铭牌的配色跟着当前吃到的第一个维度走，让盘面、HUD 和 Boss 本体
             * 在同一时刻说同一件事。
             */
            const lead = c.deprive[0] ?? 'none';
            this.boss.setPhase(c.index, lead !== 'aim');
            this.fx.ring(0, 13.5, lead === 'ammo' ? 0xffb347 : lead === 'time' ? 0xff6a5c : 0x7ad7ff, 1, 12, 0.9);
          }
          break;
        case 'fx':
          this.playFx(c);
          break;
        case 'shake':
          this.engine.shake(Math.min(0.14, c.amount * 0.35), Math.min(0.18, c.duration));
          break;
        case 'flash':
          this.cb.onFlash(c.color, Math.min(0.08, c.duration));
          break;
        case 'feverGate':
          // 真的把那张嘴搬到中央口上方，并让视觉同步开合
          this.board.setFeverGate(c.on);
          this.view.setFeverGate(c.on, this.stage.rules.fever.palette);
          if (c.on) {
            this.fx.ring(this.stage.weakPoint.x, this.stage.rules.fever.gate.y, 0xffd24a, 0.4, 4.5, 0.35);
            this.fx.burst(this.stage.weakPoint.x, this.stage.rules.fever.gate.y, 0xffe08a, 12, 6, 0.3);
          }
          break;
        case 'sound':
          this.playSound(c.name, c.value);
          break;
      }
    }
  }

  private playSound(name: string, value?: number): void {
    switch (name) {
      case 'skill':
        audio.skill('berserk');
        break;
      case 'link':
        audio.link();
        break;
      case 'bossHit':
        audio.bossHit(false);
        break;
      case 'zone':
        audio.zone('energy');
        break;
      case 'charge':
        audio.charge();
        break;
      case 'deny':
        audio.deny();
        break;
      case 'shot':
        audio.shot();
        break;
      case 'slot':
        if (value) audio.slot('normal', value);
        break;
      case 'flipper':
        // 翻板是「啪」的一声硬响，不是技能那种带尾音的上扬。
        // 音色必须和技能区分开：玩家闭着眼也该知道刚才那下是按板还是放技能。
        audio.flipper();
        break;
      case 'comboHit':
        // 三段连击：音高逐段往上走，玩家闭着眼也数得出打了几下。
        audio.comboHit(value ?? 0);
        break;
    }
  }

  private playFx(c: Extract<SimCommand, { t: 'fx' }>): void {
    const color = c.color ?? '#ffffff';
    switch (c.fx) {
      case 'flipper':
        // 翻板回击：短促的金环 + 一小簇火花。不做全屏演出——
        // 板可以连着按，每 0.24s 一次，堆量的话画面会一直在闪。
        this.float(c.x, c.y + 0.6, c.text ?? '回 击', color, c.scale ?? 1);
        this.fx.ring(c.x, c.y, new THREE.Color(color).getHex(), 0.16, 2.6, 0.26);
        this.fx.burst(c.x, c.y, new THREE.Color(color).getHex(), 5, 7, 0.16);
        break;
      case 'flipperTime':
        // 还回来的时间单独往上飘一格，和「回击」错开。
        // 两者同点同色的话会糊成一团，玩家读不出「+0.55s」是倒计时而不是分数。
        this.float(c.x, c.y - 0.5, c.text ?? '', color, c.scale ?? 0.9);
        break;
      case 'comboStart':        // 组合技起手：一圈从球身扩出去的大环。**只有这一下做大演出**，
        // 三段的本体是短促的小环——起手负责「要发生事了」，段数负责「在打几下」。
        this.float(c.x, c.y + 1.4, c.text ?? '聚 气', color, c.scale ?? 2);
        this.fx.ring(c.x, c.y, new THREE.Color(color).getHex(), 0.45, 9, 0.55);
        break;
      case 'comboHit':
        // 三段连击的每一段。环的尺寸逐段变大，和伤害递增同一个方向。
        this.float(c.x, c.y + 0.8, c.text ?? '', color, c.scale ?? 1.4);
        this.fx.ring(c.x, c.y, new THREE.Color(color).getHex(), 0.2, 4.5, 0.3);
        this.fx.burst(c.x, c.y, new THREE.Color(color).getHex(), 9, 10, 0.22);
        break;
      case 'recoveryCharge':
        this.float(c.x, c.y + 0.8, c.text ?? '', '#7bf3d4', 0.9);
        this.fx.ring(c.x, c.y, 0x7bf3d4, 0.3, 2.0, 0.5);
        break;
      case 'recoveryBurst':
        this.float(c.x, c.y + 1.6, c.text ?? '', '#b3ffe8', 1.5);
        this.fx.ring(c.x, c.y, 0x7bf3d4, 0.5, 10, 0.9);
        this.fx.burst(c.x, c.y, 0x7bf3d4, 26, 9, 0.3);
        for (const peg of this.stage.pegs.filter((p) => p.kind === 'enemy')) this.fx.ring(peg.x, peg.y, 0x9bffe2, 0.3, 1.9, 0.6);
        break;
      case 'feverStart':
        // 確変入场：役物中心炸开 + 一圈向外扩的冲击环 + 全屏浮字。
        // 一局只可能来这一次，所以敢堆量；平时的小演出不能这么写。
        this.float(c.x, c.y + 1.2, c.text ?? '確変', color, c.scale ?? 2);
        this.fx.ring(c.x, c.y, new THREE.Color(color).getHex(), 0.7, 5, 0.5);
        
        this.fx.burst(c.x, c.y, 0xffd24a, 16, 8, 0.35);
        break;
      case 'feverGate':
        this.float(c.x, c.y + 1.4, c.text ?? '', color, c.scale ?? 1.3);
        break;
      case 'renda':
        this.float(c.x, c.y + 0.8, c.text ?? '', color, c.scale ?? 1.2);
        this.fx.burst(c.x, c.y + 0.4, 0xffd24a, 12, 7, 0.26);
        break;
      case 'feverEnd':
        this.float(0, 15, c.text ?? '', color, c.scale ?? 1.2);
        break;
      case 'enemyHit': {
        // 普通命中：小冲击环 + 小数字。「打中了」的最小反馈单元
        this.float(c.x, c.y + 0.5, c.text ?? '', color, c.scale ?? 1);
        this.fx.ring(c.x, c.y, new THREE.Color(color).getHex(), 0.26, 1.9, 0.3);
        this.fx.burst(c.x, c.y, new THREE.Color(color).getHex(), 7, 5, 0.2);
        break;
      }
      case 'crit': {
        // 会心：数字更大更亮 + 白闪 + 放射线光环 + 重震。
        // 会心必须是**另一个量级**的反馈，否则玩家学不会为什么这次打得疼。
        this.float(c.x, c.y + 0.7, `会心 ${c.text ?? ''}`, '#fff0b8', 1.0);
        this.fx.ring(c.x, c.y, 0xffffff, 0.28, 1.8, 0.25);
        
        
        this.fx.burst(c.x, c.y, 0xfff0b8, 8, 5, 0.2);
        this.engine.shake(0.06, 0.08);
        break;
      }
      case 'attrTag':
        // 相性反馈由敌人颜色与说明表表达，避免与伤害数字叠字。
        break;
      case 'deprivation':
        /*
         * 相位剥夺的宣告。一条一行地往上飘，不做全屏演出：
         * 它要说的是「规则变了」，说清楚了就行，抢戏反而让人读不完。
         */
        this.float(0, 15.5, c.text ?? '', color, c.scale ?? 1.1);
        this.fx.ring(0, 13.5, new THREE.Color(color).getHex(), 0.5, 12, 0.8);
        break;
      case 'enemyHitRing': {
        const hex = new THREE.Color(c.color ?? '#ffffff').getHex();
        this.fx.ring(c.x, c.y, hex, 0.2, 1.3, 0.2);
        break;
      }
      case 'enemyKill': {
        // 击坠：全场最重的一下。白闪 + 双层冲击环 + 大爆发 + 强震 + 推近镜头
        this.float(c.x, c.y + 1, c.text ?? '击坠', c.color ?? '#ffffff', c.scale ?? 1.4);
        this.fx.ring(c.x, c.y, 0xffffff, 0.4, 2.5, 0.35);
        
        this.fx.burst(c.x, c.y, new THREE.Color(color).getHex(), 12, 7, 0.3);
        
        break;
      }
      case 'slot':
        this.float(c.x, c.y, c.text ?? '', color, c.scale ?? 1);
        this.fx.burst(c.x, c.y + 0.4, 0xffe9a8, 16, 8, 0.3);
        this.fx.ring(c.x, c.y + 0.4, 0xffe9a8, 0.3, 2.4, 0.45);
        break;
      case 'bossDamage': {
        this.float(c.x, c.y + 0.6, c.text ?? '', color, c.scale ?? 1.2);
        this.boss.hit(0.6);
        // 破绽特效跟着判定圈走（会漂），不用 stage 里的静态坐标
        const w = this.board.weakPointNow;
        this.fx.burst(w.x, w.y, 0xff5470, 26, 11, 0.36);
        this.fx.ring(w.x, w.y, 0xff5470, 0.6, 4.2, 0.5);
        audio.bossHit(true);
        break;
      }
      case 'skillCast':
        { const caster = this.sim.team.find((character) => character.skill.name === c.text); if (caster) this.cb.onSkillEffect?.(caster); }
        this.float(c.x, c.y, c.text ?? '', color, c.scale ?? 1.6);
        
        this.fx.ring(c.x, c.y, new THREE.Color(color).getHex(), 0.4, 3.5, 0.35);
        this.fx.burst(c.x, c.y, new THREE.Color(color).getHex(), 10, 6, 0.3);
        break;
      case 'linkBreak':
      case 'linkBurst':
      case 'linkChain':
      case 'linkUltimate':
        this.float(c.x, Math.max(6, c.y), c.text ?? '', color, c.scale ?? 2);
        
        this.fx.ring(this.board.ballX, this.board.ballY, new THREE.Color(color).getHex(), 0.7, 5.5, 0.45);
        
        this.fx.burst(this.board.ballX, this.board.ballY, new THREE.Color(color).getHex(), 20, 8, 0.35);
        break;
      case 'shockRing':
        this.fx.ring(c.x, c.y, new THREE.Color(color).getHex(), 0.5, 4.5, 0.35);
        this.fx.burst(c.x, c.y, new THREE.Color(color).getHex(), 14, 7, 0.3);
        this.boss.hit(0.3);
        break;
      case 'detonate':
        this.float(c.x, c.y, c.text ?? '', color, 1.1);
        this.fx.ring(c.x, c.y, new THREE.Color(color).getHex(), 0.3, 3.6, 0.4);
        this.fx.burst(c.x, c.y, new THREE.Color(color).getHex(), 14, 10, 0.3);
        break;
      case 'pierceHit':
      case 'pierceWeak':
        this.float(c.x, c.y, c.text ?? '', color, c.fx === 'pierceWeak' ? 1.3 : 0.9);
        this.fx.burst(c.x, c.y, new THREE.Color(color).getHex(), c.fx === 'pierceWeak' ? 14 : 5, 9, 0.26);
        break;
      case 'gaugeFull':
        this.float(c.x, c.y + 0.8, c.text ?? '', color, 1.1);
        this.fx.ring(c.x, c.y, new THREE.Color(color).getHex(), 0.3, 2.6, 0.5);
        break;
      case 'bounceMilestone':
        // 反弹里程碑：这是全游戏唯一需要「教会玩家」的手感，
        // 所以它必须比普通的伤害数字更响——环形冲击 + 沿球轨迹的粒子。
        this.float(c.x, c.y, c.text ?? '', color, c.scale ?? 1.2);
        this.fx.ring(c.x, c.y, new THREE.Color(color).getHex(), 0.45, 3.8, 0.55);
        this.fx.burst(c.x, c.y, new THREE.Color(color).getHex(), 14, 9, 0.3);
        break;
      case 'golden':
        // 万金钉：金色金屑往上抛，环比普通命中大一圈。
        // 钉子本身是静态的，玩家唯一能判断「这颗值不值」的时刻就是撞上的这一帧，
        // 所以这里的响度要明显高过普通钉——它得让玩家记住「金钉要追」。
        this.float(c.x, c.y, c.text ?? '', color, c.scale ?? 1.4);
        this.fx.ring(c.x, c.y, new THREE.Color(color).getHex(), 0.4, 3.2, 0.5);
        this.fx.burst(c.x, c.y, 0xffd24a, 18, 7, 0.34);
        break;
      case 'linkSummary':
        // 连携名下面那行「它干了什么」，比名字本身小一号、常驻时间短
        
        
        break;
      case 'charge':
        break;
      case 'followUp':
        // 追打：从球的位置炸开一圈冷光 + 一道向上的箭头。
        // 这是「我又救回来一次」的确认动作，视觉上必须和落槽结算明显不同——
        // 落槽是结束感（大金字 + 红环），追打是继续感（冷光 + 上冲）。
        this.float(c.x, c.y + 1.4, c.text ?? '', color, c.scale ?? 1.25);
        this.fx.ring(c.x, c.y, new THREE.Color(color).getHex(), 0.4, 4.2, 0.6);
        this.fx.burst(c.x, c.y, 0x9fe8ff, 14, 10, 0.24);
        break;
      case 'escape':
        // 脱困兜底：钉板短暂虚化让球滑下去，用一圈冷光提示「这里原本是个死角」
        this.fx.ring(c.x, c.y, 0x7ad7ff, 0.35, 3.2, 0.4);
        this.fx.burst(c.x, c.y, 0x7ad7ff, 10, 7, 0.26);
        break;
      case 'zone_energy':
      case 'zone_combo':
      case 'zone_skill':
      case 'zone_multiplier':
      case 'zone_boss':
      case 'zone_normal': {
        const kind = c.fx.replace('zone_', '');
        const hex = ZONE_HEX[kind] ?? 0xffffff;
        this.float(c.x, c.y, c.text ?? '', color, 1.15);
        this.fx.ring(c.x, c.y, hex, 0.4, 3.4, 0.5);
        this.fx.burst(c.x, c.y, hex, 12, 8, 0.3);
        break;
      }
      case 'dash':
        this.float(c.x, c.y, c.text ?? '', color, 1.1);
        this.fx.jet(c.x, c.y, 0x49e6ff, 22, 0, 1, 1.1, 14);
        break;
      case 'victory':
        this.onSettled('victory');
        break;
      case 'defeat':
        this.onSettled('defeat');
        break;
      default:
        if (c.text) this.float(c.x || this.board.ballX, c.y || this.board.ballY, c.text, color, 1);
        break;
    }
  }

  private float(x: number, y: number, text: string, color: string, scale: number): void {
    const v = new THREE.Vector3(x, y, 1.2).project(this.engine.camera);
    const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
    this.cb.onFloat(sx, sy, text, color, scale);
  }

  private onSettled(phase: 'victory' | 'defeat'): void {
    if (this.finished) return;
    this.finished = true;
    this.cancelSkill();
    this.charging = false;
    if (phase === 'victory') {
      audio.victory();
      this.fx.ring(0, 12, 0xffd76a, 1, 22, 1.4);
      this.fx.burst(0, 12, 0xffd76a, 90, 20, 0.5);
      this.boss.setDead(true);
      this.engine.shake(1, 0.9);
    } else {
      audio.defeat();
      this.engine.shake(0.5, 0.6);
    }
    this.finishTimer = window.setTimeout(() => this.cb.onFinish(phase, this.sim.snapshot()), 1200);
  }

  /* ---------------------------------------------------------------- 循环 */

  fixedStep(dt: number): void {
    this.syncSkillClock();
    this.stepAccumulator += this.board.state === 'live' ? this.skillAim.advance(dt) : dt;
    if (this.stepAccumulator + 1e-9 < dt) return;
    this.stepAccumulator = Math.max(0, this.stepAccumulator - dt);
    this.board.step(dt);
    this.exec(this.sim.update(dt));

    if (this.board.state === 'done') {
      this.cancelSkill();
      this.charging = false;
      this.charge = 0;
      this.board.cancelCharge();
    }
    if (this.board.state === 'done' && !this.finished) {
      if (this.rearmTimer <= 0) this.rearmTimer = REARM_DELAY;
    }
    if (this.rearmTimer > 0) {
      this.rearmTimer -= dt;
      if (this.rearmTimer <= 0) {
        const snap = this.sim.snapshot();
        if (snap.phase === 'playing' && snap.ballsLeft > 0) {
          this.board.armLauncher();
          this.skillAim.newBall();
          this.view.setBallVisible(true);
          this.fx.burst(this.stage.plunger.x, this.stage.plunger.restY, 0xffe9a8, 12, 5, 0.26);
        }
      }
    }
  }

  frame(dt: number, _time: number): void {
    this.syncSkillClock();
    if (this.charging) {
      this.charge = Math.min(1, this.charge + dt / CHARGE_SECONDS);
      // 蓄满后一直不松手的兜底。弹簧拉到底会自己弹回去，物理上也该如此——
      // 没有它，玩家可以把杆拉满然后放着不管，这一局就卡死在这。
      if (this.charge >= 1 && this.holdTimer >= PLUNGER.autoRelease) {
        this.charging = false;
        this.fire();
      } else if (this.charge < 1) {
        this.holdTimer = 0;
      }
    }
    if (this.charging) this.holdTimer += dt;
    const snap = this.sim.snapshot();
    // 能打 = 盘没结束 + 冷却好了。**球还在盘上也是 true**，这是新玩法的入口。
    const canFire = this.board.canShoot && !this.finished;
    // 击射点：首发画道底（蓄力条就在那儿），救球画球自己的位置
    const onLauncher = this.board.state === 'idle';
    const ox = this.board.ballX;
    const oy = this.board.ballY;

    this.view.setCooldown(this.board.cooldownRatio);
    // 首发不画弹道预测线：落点是随机的，画一条确定的线就是在骗玩家。
    // 只有救球（球在盘上）才有瞄准线。
    const showAimLine = !onLauncher && !this.isAimingSkill;
    this.view.setAim(this.aimAngle, this.charge, this.charging, showAimLine && canFire, ox, oy, this.board.isReady);
    this.view.setPlungerPull(onLauncher ? this.charge : 0, this.charging && onLauncher);
    const selected = this.skillAim.selected;
    const preview = selected === null ? null : this.sim.previewSkill(this.sim.team[selected]!.id, this.board.ballX, this.board.ballY, this.skillAim.angleDeg);
    if (selected !== null && !preview) this.cancelSkill();
    this.strikeView.show(preview);
    this.cb.onSkillAim?.(preview, this.skillAim.selected, this.skillAim.slowRemaining);
    this.strikeView.update(dt);
    this.view.setBallsLeft(snap.ballsLeft);
    this.view.setRecovery(snap.recovery);
    // 本球带没带破绽标记：这是「飞过带子 → 落槽 ×1.5」那个两步连招的状态，
    // 不搬到盘面上，玩家瞄底口时根本无从知道自己这颗球有没有标记。
    if (snap.enemy.marked !== this.markedShown) {
      this.markedShown = snap.enemy.marked;
      this.view.setMarked(snap.enemy.marked);
    }
    this.cb.onAim(this.aimAngle, this.charge, this.charging);
    this.view.update(dt, this.board, this.fx);
    this.fx.update(dt);
    this.boss.setHp(snap.bossHp / snap.bossMaxHp);
    this.boss.setWeakX(this.board.weakPointNow.x);
    this.boss.update(dt, this.board.phaseSway);
    /*
     * 「时间」剥夺的镜头反馈：极小幅、每帧续期的抖动。
     *
     * `Engine.shake` 是「取更强的一次 + 自然衰减」，所以这里每帧喂一个小值
     * 就得到一段恒定的余震；幅度必须压在 0.03 以下——玩家读的是「整盘在晃」，
     * 晃到看不清球就变成另一种难度（而且是看不见的那种）。
     */
    if (this.board.phaseSway > 0.05 && this.board.phaseCameraShake > 0) {
      this.engine.shake(0.03 * this.board.phaseSway * this.board.phaseCameraShake * 10, 0.12);
    }

    this.cb.onHud(snap, {
      state: this.board.state,
      secondsLeft: this.board.secondsLeft,
      canShoot: canFire,
      rescueHeld: this.board.rescueHeld,
      noRescue: this.board.noRescue,
    });
  }

  get energyMax(): number {
    return COMBAT.energyMax;
  }

  dispose(): void {
    this.cancelSkill();
    this.stepAccumulator = 0;
    if (this.finishTimer !== null) window.clearTimeout(this.finishTimer);
    this.board.dispose();
    this.view.dispose();
    this.boss.dispose();
    this.fx.dispose();
    this.strikeView.dispose();
    this.engine.scene.remove(this.view.group, this.boss.group, this.fx.group, this.strikeView.group);
    this.physics.dispose();
    this.engine.clearBattleFraming();
  }
}

const ZONE_HEX: Record<string, number> = {
  energy: 0x49e6ff,
  combo: 0xffa63d,
  skill: 0xb184ff,
  multiplier: 0xffd76a,
  boss: 0xff5470,
  normal: 0x7f8db0,
};
