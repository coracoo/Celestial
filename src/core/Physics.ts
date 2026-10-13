import * as RAPIER from '@dimforge/rapier2d-compat';
import { PHYSICS, FLIPPER } from './constants.ts';

export type ColliderRole = 'ball' | 'peg' | 'wall' | 'deflector' | 'slot' | 'boss' | 'sensor' | 'fever' | 'recovery' | 'flipper';

export interface ColliderTag {
  role: ColliderRole;
  id: string;
  /** 钉板类型，与 PegKind 对应 */
  kind?: string;
  destructible?: boolean;
  /** 落槽数值 */
  value?: number;
  slotKind?: string;
  /** 是否为 Boss 弱点 */
  weak?: boolean;
  alive: boolean;
}

export interface ImpactInfo {
  tag: ColliderTag;
  /** 归一化冲击强度 0..1 */
  intensity: number;
  rawForce: number;
  x: number;
  y: number;
}

let ready = false;

function isImpactTag(tag: ColliderTag | undefined): tag is ColliderTag {
  /*
   * `'flipper'` 故意不在这个名单里。
   *
   * 在的话，按一次 Z 会同时结算一次撞击伤害——于是翻板变成了「花键位刷伤害」，
   * 和「弹板是延长本球打击时间、不是伤害来源」的定位正好相反。
   * 翻板的价值全在**把球打回去**：球多飞一会儿，钉子自己会挨更多次。
   */
  return !!tag && (tag.role === 'peg' || tag.role === 'deflector' || tag.role === 'boss');
}

export async function initPhysics(): Promise<void> {
  if (ready) return;
  await RAPIER.init();
  ready = true;
}

/**
 * Rapier2D 封装。物理只跑在 (x, y) 平面，Three.js 负责把它渲染成有厚度的 3D。
 * 碰撞体自带 tag 表，避免依赖引擎的 userData 字段版本差异。
 */
export class Physics {
  readonly world: RAPIER.World;
  private queue: RAPIER.EventQueue;
  readonly tags = new Map<number, ColliderTag>();
  private ballHandle: number | null = null;
  private ballPos = { x: 0, y: 0 };
  private ballSpeed = 0;
  /**
   * 撞击 / 碰撞监听。**只能通过 addImpact / addCollide 追加。**
   * 盘面层（PhysicsBoard）与表现层（BattleScene）挂在同一个物理世界上，
   * 任何一方用赋值覆盖都会把另一方的事件通道掐断。
   */
  onImpact: ((info: ImpactInfo) => void)[] = [];
  onCollide: ((a: ColliderTag | undefined, b: ColliderTag | undefined, started: boolean) => void)[] = [];
  /** 全局重力缩放（技能可改写物理规则） */
  gravityScale = 1;
  /** 横向重力（Boss 怒目阶段用） */
  lateralGravity = 0;

  private readonly baseGravity: number;

  constructor(baseGravity: number = PHYSICS.gravity) {
    this.baseGravity = baseGravity;
    this.world = new RAPIER.World({ x: 0, y: baseGravity });
    this.world.timestep = PHYSICS.fixedDt;
    this.queue = new RAPIER.EventQueue(true);
  }

  tagOf(handle: number): ColliderTag | undefined {
    return this.tags.get(handle);
  }

  setBall(collider: RAPIER.Collider): void {
    this.ballHandle = collider.handle;
  }

  addImpact(fn: (info: ImpactInfo) => void): void {
    this.onImpact.push(fn);
  }

  addCollide(fn: (a: ColliderTag | undefined, b: ColliderTag | undefined, started: boolean) => void): void {
    this.onCollide.push(fn);
  }

  getBallPos(): { x: number; y: number } {
    return this.ballPos;
  }

  step(): void {
    this.world.gravity = {
      x: this.lateralGravity,
      y: this.baseGravity * this.gravityScale,
    };
    this.world.step(this.queue);
    // 1) 先取接触的开始/结束：一次接触只结算一次撞击
    const startedNow = new Set<number>();
    this.queue.drainCollisionEvents((h1, h2, started) => {
      const a = this.tags.get(h1);
      const b = this.tags.get(h2);
      for (const fn of this.onCollide) fn(a, b, started);
      if (!started) return;
      if (isImpactTag(a)) startedNow.add(h1);
      if (isImpactTag(b)) startedNow.add(h2);
    });

    // 2) 收集本次接触的冲击力
    const forceByHandle = new Map<number, number>();
    this.queue.drainContactForceEvents((ev) => {
      const h1 = ev.collider1();
      const h2 = ev.collider2();
      const isBall1 = h1 === this.ballHandle;
      const isBall2 = h2 === this.ballHandle;
      if (!isBall1 && !isBall2) return;
      const otherHandle = isBall1 ? h2 : h1;
      const tag = this.tags.get(otherHandle);
      if (!tag || !tag.alive || !isImpactTag(tag)) return;
      const f = ev.totalForceMagnitude();
      if (f > (forceByHandle.get(otherHandle) ?? 0)) forceByHandle.set(otherHandle, f);
    });

    // 3) 只对「本步刚开始接触」的钉板结算撞击，避免球贴着钉板时每帧刷一次
    for (const handle of startedNow) {
      const tag = this.tags.get(handle);
      if (!tag || !tag.alive) continue;
      const force = forceByHandle.get(handle) ?? this.ballSpeed * 5;
      const info: ImpactInfo = {
        tag,
        intensity: Math.min(1, force / PHYSICS.impactReference),
        rawForce: force,
        x: this.ballPos.x,
        y: this.ballPos.y,
      };
      for (const fn of this.onImpact) fn(info);
    }
  }

  setBallState(x: number, y: number, vx: number, vy: number): void {
    this.ballPos = { x, y };
    this.ballSpeed = Math.hypot(vx, vy);
  }

  createPeg(x: number, y: number, r: number, tag: Omit<ColliderTag, 'alive'>): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.ball(r)
      .setTranslation(x, y)
      .setRestitution(PHYSICS.pegRestitution)
      .setFriction(PHYSICS.pegFriction)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(PHYSICS.contactForceThreshold);
    return this.attach(desc, tag);
  }

  createWall(
    x: number,
    y: number,
    hx: number,
    hy: number,
    rot: number,
    tag: Omit<ColliderTag, 'alive'>,
  ): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy)
      .setTranslation(x, y)
      .setRotation(rot)
      .setRestitution(0.28)
      .setFriction(0.1);
    return this.attach(desc, tag);
  }

  createSensor(
    x: number,
    y: number,
    hx: number,
    hy: number,
    tag: Omit<ColliderTag, 'alive'>,
  ): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy)
      .setTranslation(x, y)
      .setSensor(true)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    return this.attach(desc, tag);
  }

  createBall(x: number, y: number, r = PHYSICS.ballRadius): { body: RAPIER.RigidBody; collider: RAPIER.Collider } {
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y)
      .setLinearDamping(PHYSICS.ballLinearDamping)
      .setAngularDamping(PHYSICS.ballAngularDamping)
      .setCcdEnabled(true)
      .setCanSleep(false);
    const body = this.world.createRigidBody(bodyDesc);
    const desc = RAPIER.ColliderDesc.ball(r)
      .setRestitution(PHYSICS.ballRestitution)
      .setFriction(PHYSICS.ballFriction)
      .setDensity(1.1)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(0.4);
    const collider = this.world.createCollider(desc, body);
    this.tags.set(collider.handle, { role: 'ball', id: 'ball', alive: true });
    this.setBall(collider);
    this.ballPos = { x, y };
    return { body, collider };
  }

  /**
   * 可操作翻板：挂在**运动学刚体**上的板条，绕枢轴转。
   *
   * 为什么是运动学而不是直接每帧 `setTranslation` 一块固定碰撞体：
   * Rapier 只对运动学体计算表面速度并传给接触中的球——这正是真弹球翻板
   * 把球「抽」出去的那一下。固定体无论怎么动，传给球的都只是普通的反弹。
   *
   * `setNextKinematicRotation` 必须在 `world.step()` **之前**调，
   * 告诉 Rapier「这一帧我要转到这个角度」，由它推出速度；
   * 顺序反了就会变成瞬移，球会被体穿过去。
   */
  createFlipper(
    px: number,
    py: number,
    halfLen: number,
    halfThick: number,
    rot: number,
    tag: Omit<ColliderTag, 'alive'>,
  ): { body: RAPIER.RigidBody; collider: RAPIER.Collider } {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(px, py).setRotation(rot),
    );
    /*
     * 碰撞盒沿局部 +x 铺开，但**内端从枢轴后退一段**。
     *
     * 为什么必须内缩（这是「球被轴挡住、一直往后弹」的根）：
     * 旧版 `setTranslation(halfLen, 0)` 让板的**内端正好落在枢轴上**，
     * 于是枢轴附近就是一块垂直端面。球从中央沿导流墙滑下来、落点稍偏外侧时，
     * 先撞上的是这个端面而不是板面——端面法线指向机台外侧，
     * 球被直接弹回外侧死角，在 y=6.5~6.9 之间反复蹭好几下才脱身。
     *
     * 实测（stage_04 左板 pivot=(-3.18,5.90)，球从 pivot 正上方自由落体）：
     *   dx=0（正对枢轴）→ 球卡在 x∈[-4.4,-3.2] 反复弹 5 次才脱身
     *   dx=0.3（偏内 0.3）→ 一路顺畅滑到中区，一次都不弹
     * 内缩之后枢轴侧留空，球要么落进这块空当继续下落，要么直接压上板面被抽走，
     * 两种结果都比「撞端面弹飞」好。
     *
     * 内缩量取一个球径：小于它球照样能蹭到端面，大于它会削掉太多有效板面。
     * 板尖位置不变（中心 +halfLen、内缩的是内端），所以摆幅和手感不变。
     *
     * 另一个容易踩的坑在这里保留说明：`cuboid(hx, hy)` 的 hx 是**局部 x** 的半长，
     * 写反会得到一根立在枢轴上的竖条，板看起来在那儿而球从旁边直穿过去。
     */
    const inset = PHYSICS.ballRadius * 2 * FLIPPER.pivotInsetBallDia;
    const usable = Math.max(halfLen - inset, halfLen * 0.4);
    const desc = RAPIER.ColliderDesc.cuboid(usable, halfThick)
      .setTranslation(inset + usable, 0)
      .setRestitution(0.34)
      .setFriction(0.12)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(PHYSICS.contactForceThreshold);
    const collider = this.world.createCollider(desc, body);
    this.tags.set(collider.handle, { ...tag, alive: true });
    return { body, collider };
  }

  /**
   * 可整体平移的盒子：挂在**运动学刚体**上，碰撞盒以刚体原点为中心。
   *
   * 移动落槽的整排（5 个传感器 + 4 道隔板 + 2 块端墙）就是这么做的。
   * 用运动学体而不是每帧 `setTranslation` 一块固定碰撞体，原因和 `createFlipper`
   * 同源：Rapier 只对运动学体算表面速度并传给接触中的球，固定体怎么动都只是
   * 普通反弹——球会被端墙「穿」过去。
   *
   * 移动用 `setNextKinematicTranslation`，且必须在 `world.step()` **之前**调。
   */
  createKinematicBox(
    hx: number,
    hy: number,
    x: number,
    y: number,
    tag: Omit<ColliderTag, 'alive'>,
    sensor = false,
  ): { body: RAPIER.RigidBody; collider: RAPIER.Collider } {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y),
    );
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy)
      .setSensor(sensor)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const collider = this.world.createCollider(desc, body);
    this.tags.set(collider.handle, { ...tag, alive: true });
    return { body, collider };
  }

  private attach(desc: RAPIER.ColliderDesc, tag: Omit<ColliderTag, 'alive'>): RAPIER.Collider {
    const collider = this.world.createCollider(desc);
    this.tags.set(collider.handle, { ...tag, alive: true });
    return collider;
  }

  removeCollider(collider: RAPIER.Collider): void {
    const t = this.tags.get(collider.handle);
    if (t) t.alive = false;
    this.world.removeCollider(collider, true);
    this.tags.delete(collider.handle);
  }

  removeBody(body: RAPIER.RigidBody): void {
    for (const [handle, tag] of [...this.tags]) {
      if (tag.role === 'ball' || this.isAttachedTo(body, handle)) {
        tag.alive = false;
        this.tags.delete(handle);
      }
    }
    this.world.removeRigidBody(body);
    this.ballHandle = null;
  }

  private isAttachedTo(body: RAPIER.RigidBody, colliderHandle: number): boolean {
    try {
      return this.world.getCollider(colliderHandle).parent()?.handle === body.handle;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.tags.clear();
    this.queue.free();
    this.world.free();
  }
}
