import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BOARD, PLUNGER, SLOT_COLORS, ZONE_COLORS } from '../core/constants.ts';
import { WUXING_HEX, WUXING_LABEL, type PegKind, type Wuxing } from '../data/schema.ts';
import type { ExpandedStage } from '../sim/board.ts';
import type { PhysicsBoard, PegMeta } from '../sim/PhysicsBoard.ts';
import type { Fx } from './Fx.ts';
import { EnemyCardDeck, type EnemyCardVisual } from './EnemyCardView.ts';

interface PegVisual {
  root: THREE.Group;
  material: THREE.MeshStandardMaterial;
  hp?: THREE.Mesh;
  enemyCard?: EnemyCardVisual;
  flash: number;
  kind: PegKind;
}

/** Physical cabinet presentation. Every peg, wall and slot uses the simulation's coordinates. */

/**
 * 追打救球的力度范围。首发走弹射道不用这一组（见 `PLUNGER`），
 * 这里只负责把蓄力条映射成救球那一发的实际力度。
 */
const SHOOT_MIN_POWER = 17;
const SHOOT_MAX_POWER = 30;

export class BoardView {
  readonly group = new THREE.Group();
  private readonly stage: ExpandedStage;
  private readonly board: PhysicsBoard;
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly textures = new Set<THREE.Texture>();
  private readonly pegs = new Map<string, PegVisual>();
  private readonly enemyCards = new EnemyCardDeck();
  private readonly slotFaces = new Map<string, THREE.MeshStandardMaterial>();
  private readonly zoneFaces = new Map<string, THREE.MeshBasicMaterial>();
  private readonly ball: THREE.Mesh;
  /** 翻板网格：id → 组。角度每帧从物理层同步，渲染层不自算。 */
  private readonly flipperMeshes = new Map<string, THREE.Group>();
  /** 落槽整排的容器。每帧读 `board.slotOffset` 整体平移，槽口必须跟着传感器走 */
  private readonly slotRow: THREE.Group;
  private readonly readyRing: THREE.Mesh;
  private readonly aim: THREE.Line;
  private readonly trail: THREE.Line;
  private readonly trailPoints: { x: number; y: number; age: number }[] = [];
  private lastPrediction = -1;
  private predictionKey = '';
  private readonly poolRipples: THREE.Mesh[] = [];
  private poolWater!: THREE.MeshPhysicalMaterial;
  private poolProgress!: THREE.Mesh;
  private poolCharge = -1;
  private recoveryPulse = 0;
  /**
   * 弹射杆。**这是首发唯一的操作反馈**：玩家按住时杆头下拉，
   * 拉得越低弹簧张力越大，松手球弹得越高。
   *
   * 旧版这里是个顶部居中的「蓄球杯」，球直接浮在杯里等发射——
   * 那套结构和「拉杆蓄力」的手感是冲突的：杯子暗示球已经在盘上了，
   * 而弹射道要求玩家清楚地知道「球还在机台外面，我还没放它进去」。
   */
  private readonly plungerGroup = new THREE.Group();
  private readonly plungerHead!: THREE.Mesh;
  private readonly plungerSpring!: THREE.Mesh;
  private plungerPull = 0;
  private readonly gate = new THREE.Group();
  private readonly gateJaws: THREE.Mesh[] = [];
  private readonly bossSlot: THREE.MeshStandardMaterial;
  private time = 0;
  private cooldown = 1;
  private fever = false;
  private marked = false;
  private disposed = false;

  constructor(stage: ExpandedStage, board: PhysicsBoard) {
    this.stage = stage;
    this.board = board;
    this.group.name = 'Celestial · 漆木弹珠台';
    // 外壳跨度由 `buildPlunger` 算：球道挂在主盘右边，所以机台中心不在 0 上。
    // 用 `stage.width / 2` 会让木框只盖住主盘、球道浮在机台外面（实机截图 stage_01）。
    const hw = stage.caseHalfWidth;
    const cx = stage.caseCenterX;
    const hh = stage.height / 2;
    const lacquer = this.ownMaterial(new THREE.MeshStandardMaterial({
      color: 0xffdfc2, metalness: 0.0, roughness: 0.43, envMapIntensity: 0.4, bumpScale: 0.024,
    }));
    const brass = this.ownMaterial(new THREE.MeshStandardMaterial({ color: 0xc6a36d, metalness: 0.78, roughness: 0.3 }));
    const darkBrass = this.ownMaterial(new THREE.MeshStandardMaterial({ color: 0x64503b, metalness: 0.68, roughness: 0.38 }));
    const backMaterial = this.ownMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xf0c1b0, metalness: 0.02, roughness: 0.48, clearcoat: 0.18, clearcoatRoughness: 0.4, specularIntensity: 0.25, envMapIntensity: 0.3,
    }));
    const loader = new THREE.TextureLoader();
    loader.load(new URL('art/scene/lacquer.png', document.baseURI).href, (texture) => {
      if (this.disposed) { texture.dispose(); return; }
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
      this.textures.add(texture);
      backMaterial.map = texture;
      backMaterial.needsUpdate = true;
    });
    const floorMaterial = this.ownMaterial(new THREE.MeshStandardMaterial({ color: 0xe5c7ac, roughness: 0.85, metalness: 0.03, envMapIntensity: 0.3 }));
    loader.load(new URL('art/scene/walnut.png', document.baseURI).href, (texture) => {
      if (this.disposed) { texture.dispose(); return; }
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
      this.textures.add(texture);
      lacquer.map = texture;
      lacquer.bumpMap = texture;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.y = 10;
      lacquer.needsUpdate = true;
      const floorTexture = texture.clone();
      floorTexture.wrapS = floorTexture.wrapT = THREE.RepeatWrapping;
      floorTexture.repeat.set(8, 8);
      floorTexture.needsUpdate = true;
      this.textures.add(floorTexture);
      floorMaterial.map = floorTexture;
      floorMaterial.needsUpdate = true;
    });

    // A solid case, recessed board, raised wooden rails and narrow machined brass lips.
    this.box(hw * 2 + 4.0, stage.height + 2.5, 3.2, cx, hh, -2.75, lacquer, 0.25);
    const back = this.mesh(new THREE.PlaneGeometry(hw * 2, stage.height), backMaterial);
    back.position.set(cx, hh, -0.77);
    back.receiveShadow = true;
    for (const side of [-1, 1]) {
      this.box(1.9, stage.height + 2.3, 2.5, cx + side * (hw + 0.98), hh, -0.72, lacquer, 0.17);
      this.box(0.24, stage.height + 2.15, 0.48, cx + side * (hw + 0.16), hh, 0.37, brass, 0.055);
      this.box(0.15, stage.height + 2.0, 0.27, cx + side * (hw + 1.78), hh, 0.5, brass, 0.035);
    }
    this.box(hw * 2 + 2.5, 1.05, 2.5, cx, stage.height + 0.5, -0.72, lacquer, 0.16);
    this.box(hw * 2 + 0.8, 0.12, 0.22, cx, stage.height + 0.2, 0.18, brass, 0.025);
    this.box(hw * 2 + 3.8, 1.3, 3.0, cx, -0.45, -0.75, lacquer, 0.16);
    this.box(hw * 2 + 0.8, 0.16, 0.32, cx, -0.12, 0.1, brass, 0.035);

    // Small screw heads show the case depth without adding large decoration to the ball path.
    const screwGeometry = this.ownGeometry(new THREE.SphereGeometry(0.10, 10, 6));
    for (const x of [cx - hw - 1.04, cx + hw + 1.04]) {
      for (const y of [0.4, stage.height * 0.33, stage.height * 0.67, stage.height - 0.3]) {
        const screw = this.mesh(screwGeometry, brass);
        screw.scale.z = 0.35;
        screw.position.set(x, y, 0.56);
      }
    }

    const ground = this.mesh(new THREE.PlaneGeometry(220, 240), floorMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -1.5, -30);
    ground.receiveShadow = true;
    const groundShadow = this.mesh(new THREE.PlaneGeometry(220, 240), this.ownMaterial(new THREE.ShadowMaterial({ opacity: 0.28 })));
    groundShadow.rotation.x = -Math.PI / 2;
    groundShadow.position.set(0, -1.495, -30);
    groundShadow.receiveShadow = true;
    const floorLight = new THREE.SpotLight(0xffd4a3, 680, 90, 0.68, 0.9, 2);
    floorLight.position.set(-12, 15, 14);
    floorLight.target.position.set(0, -1.5, 0);
    this.group.add(floorLight, floorLight.target);
    const cabinetFill = new THREE.SpotLight(0xffdcc0, 110, 100, Math.PI / 4, 0.85, 2);
    cabinetFill.position.set(-8, 34, 22);
    cabinetFill.target.position.set(0, 15, -0.6);
    this.group.add(cabinetFill, cabinetFill.target);

    this.group.add(this.plungerGroup);

    /*
     * 可操作翻板。
     *
     * 形状照 Windows 3D 弹球的翻板做：**一头粗一头尖的锥形板**，
     * 枢轴端带一个明显的圆轴套。做成方条的话它和上面那圈导流板长得一模一样，
     * 玩家根本不会意识到这俩能按——而「看得出能按」是这条机制的前提。
     *
     * 板沿板身中线摆放，所以 pivot 在 x=0、尖端在 x=+len，旋转直接落在组根上。
     */
    for (const f of stage.flippers) {
      const grp = new THREE.Group();
      grp.name = `翻板 · ${f.side === 'left' ? '左' : '右'}`;
      grp.position.set(f.px, f.py, 0.42);
      grp.rotation.z = f.restRad;

      const shape = new THREE.Shape();
      shape.moveTo(0, -f.half * 1.5);
      shape.lineTo(f.len * 0.62, -f.half);
      shape.lineTo(f.len, 0);
      shape.lineTo(f.len * 0.62, f.half);
      shape.lineTo(0, f.half * 1.5);
      shape.closePath();
      const blade = new THREE.Mesh(
        new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 2 }),
        this.ownMaterial(new THREE.MeshStandardMaterial({
          color: f.side === 'left' ? 0xffcf6a : 0xffc15a,
          metalness: 0.72,
          roughness: 0.28,
          emissive: 0x3a1e00,
          emissiveIntensity: 0.35,
        })),
      );
      blade.castShadow = true;
      grp.add(blade);

      // 枢轴轴套：静态的参照物。板转起来时它不动，玩家一眼能看出「是板在动不是整块在动」。
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(f.half * 2.6, f.half * 2.6, 0.7, 20), darkBrass);
      hub.rotation.x = Math.PI / 2;
      hub.position.z = 0.1;
      grp.add(hub);

      // 铜牌挂在板**上方**（不是下方）。下方那一带是五个落槽的铭牌，
      // 挂下去会和「铜钱 / 聚气 / 破绽」这几个名字叠在一起——
      // 实机截图里 Z 正好压在「聚气」上，玩家根本读不出那是键位牌。
      const tag = new THREE.Group();
      tag.position.set(f.px, f.py + 1.9, 0.5);
      tag.add(this.box(0.86, 0.86, 0.18, 0, 0, 0, darkBrass, 0.1));
      tag.add(this.label(f.side === 'left' ? 'Z' : 'X', 0, 0, 0.62, 0.62, '#ffe6ad', 0.12));
      this.group.add(grp, tag);
      this.flipperMeshes.set(f.id, grp);
    }

    for (const wall of board.walls) {
      const isDivider = wall.id.startsWith('divider_');
      const isLane = wall.id.startsWith('lane_');
      if (wall.role !== 'deflector' && !isDivider && !isLane) continue;
      const rail = this.box(wall.w * 2, wall.h * 2, 0.75, wall.x, wall.y, 0.0, brass, 0.1);
      rail.rotation.z = THREE.MathUtils.degToRad(wall.rotDeg);
      if (isDivider) continue;
      for (const side of [-1, 1]) {
        const screw = new THREE.Mesh(screwGeometry, darkBrass);
        screw.position.set(side * Math.max(0, wall.w - 0.24), 0, 0.39);
        screw.scale.z = 0.4;
        rail.add(screw);
      }
    }

    /*
     * 弹射杆。杆头 + 弹簧都挂在球道正下方，玩家按住时杆头下移 `pullStroke`。
     *
     * 视觉上它必须**明显低过球道地板**（地板在 y≈0.54），否则杆头会插进球道里，
     * 看起来像球搁在杆头上而不是在道底等着——那正是旧「蓄球杯」的读法，要避开。
     */
    {
      const p = stage.plunger;
      const rodY = 0.4;
      this.plungerHead = this.box(1.5, 0.34, 0.5, p.x, rodY, 0.34, brass, 0.06);
      this.plungerGroup.add(this.plungerHead);
      // 弹簧：拉杆时压扁。用一根可缩放的圆柱代替真实螺旋线——
      // 机台上没人看得清螺旋的圈数，但压扁的粗细变化一眼就懂「有张力」。
      this.plungerSpring = this.box(0.5, 1.0, 0.3, p.x, rodY - 0.7, 0.2, darkBrass, 0.02);
      this.plungerGroup.add(this.plungerSpring);
      this.label('拉杆', p.x, rodY - 1.35, 1.25, 0.37, '#c2a575');
    }

    for (const zone of stage.zones) {
      const mat = this.ownMaterial(new THREE.MeshBasicMaterial({ color: ZONE_COLORS[zone.kind], transparent: true, opacity: 0.045, depthWrite: false }));
      const marker = this.mesh(new THREE.PlaneGeometry(zone.w, zone.h), mat);
      marker.position.set(zone.x, zone.y, -0.68);
      this.zoneFaces.set(zone.id, mat);
      this.label(zone.label.split('·').pop()?.trim() ?? zone.label, zone.x, zone.y, Math.min(zone.w, 3.4), 0.4, '#b2a097', -0.59);
    }
    let bossSlot!: THREE.MeshStandardMaterial;
    /*
     * 落槽整排挂在一个 `slotRow` 组里：物理那边整排是一个运动学刚体组，
     * 这里整排一起平移，**槽口和传感器永远是同一个位置**。
     * 早先槽口是直接画在 `group` 上的静态网格，物理一旦动起来画面就对不上了。
     */
    this.slotRow = new THREE.Group();
    this.group.add(this.slotRow);
    for (const slot of stage.slots) {
      const target = slot.kind === 'boss';
      const color = SLOT_COLORS[slot.kind] ?? 0xc8ae7e;
      const well = this.ownMaterial(new THREE.MeshStandardMaterial({
        color: target ? 0x330b13 : 0x13080b, roughness: 0.7, metalness: 0,
        emissive: target ? 0x5c0715 : 0x000000, emissiveIntensity: target ? 0.35 : 0,
      }));
      this.slotFaces.set(slot.id, well);
      if (target) bossSlot = well;
      this.box(slot.w - 0.12, slot.h, 0.15, slot.x, slot.y, -0.55, well, 0.035, this.slotRow);
      for (const side of [-1, 1]) {
        this.box(0.32, slot.h, 1.2, slot.x + side * (slot.w / 2 - 0.12), slot.y, -0.05, lacquer, 0.045, this.slotRow);
      }
      this.box(slot.w + 0.05, 0.14, 1.0, slot.x, slot.y - slot.h / 2, 0, brass, 0.035, this.slotRow);
      const plaque = this.ownMaterial(new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(target ? 0.3 : 0.085), metalness: 0.25, roughness: 0.3, emissive: color, emissiveIntensity: target ? 0.14 : 0.025 }));
      this.box(slot.w - 0.04, 0.91, 0.7, slot.x, slot.y + slot.h / 2 + 0.27, -0.02, plaque, 0.06, this.slotRow);
      this.label(slot.label, slot.x, slot.y + slot.h / 2 + 0.29, slot.w - 0.18, 1.03, target ? '#fff5df' : '#f0dcb4', 0.43, this.slotRow);
    }
    /*
     * 收口漏斗是**静态几何**，随 `stage.walls` 一起在别处画好了 —— 它不跟着排漂移，
     * 整排是在它嘴里面滑的。端墙一度挂在 slotRow 上，跟着排走会在另一侧腾出漏缝，
     * 而且和侧壁之间会留出 ≈ 一个球径的夹球缝（stage_01 实测 28% 球卡到超时）。
     */
    this.bossSlot = bossSlot;
    this.buildElementRegions();
    this.buildRecoveryPool(brass);
    for (const peg of board.pegs) this.addPeg(peg);

    this.ball = this.mesh(new THREE.SphereGeometry(0.33, 32, 20), this.ownMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xf4f7ff, metalness: 0.93, roughness: 0.16, clearcoat: 0.8, envMapIntensity: 1.25,
    })));
    this.ball.castShadow = true;
    this.ball.position.set(stage.plunger.x, stage.plunger.restY, BOARD.ballZ);
    this.readyRing = this.mesh(new THREE.TorusGeometry(0.53, 0.046, 8, 40), this.ownMaterial(new THREE.MeshBasicMaterial({
      color: 0xffd16b, transparent: true, opacity: 0.95, depthWrite: false,
    })));
    this.readyRing.visible = false;
    const aimGeometry = this.ownGeometry(new THREE.BufferGeometry());
    aimGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(240 * 3), 3));
    this.aim = new THREE.Line(aimGeometry, this.ownMaterial(new THREE.LineDashedMaterial({ color: 0xffe3a3, transparent: true, opacity: 0.7, dashSize: 0.18, gapSize: 0.14 })));
    this.aim.frustumCulled = false;
    this.group.add(this.aim);
    const trailGeometry = this.ownGeometry(new THREE.BufferGeometry());
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(96 * 3), 3));
    trailGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(96 * 3), 3));
    this.trail = new THREE.Line(trailGeometry, this.ownMaterial(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false })));
    this.trail.frustumCulled = false;
    this.group.add(this.trail);
    const gate = stage.rules.fever.gate;
    this.gate.position.set(0, gate.y, 0.65);
    this.gate.visible = false;
    this.group.add(this.gate);
    for (const side of [-1, 1]) {
      const jaw = new THREE.Mesh(this.ownGeometry(new RoundedBoxGeometry(gate.w / 2, 0.22, 0.38, 2, 0.055)), brass);
      jaw.position.x = side * gate.w * 0.38;
      this.gateJaws.push(jaw);
      this.gate.add(jaw);
    }
  }

  private ownGeometry<T extends THREE.BufferGeometry>(geometry: T): T { this.geometries.add(geometry); return geometry; }
  private ownMaterial<T extends THREE.Material>(material: T): T { this.materials.add(material); return material; }
  private mesh(geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D = this.group): THREE.Mesh {
    this.geometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    parent.add(mesh);
    return mesh;
  }
  private box(w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material, radius = 0.05, parent: THREE.Object3D = this.group): THREE.Mesh {
    const mesh = this.mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, w / 3, h / 3, d / 3)), material, parent);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }
  private label(text: string, x: number, y: number, w: number, h: number, color: string, z = 0.48, parent: THREE.Object3D = this.group): THREE.Mesh {
    const canvas = document.createElement('canvas');
    canvas.height = 128;
    canvas.width = Math.max(128, Math.round(128 * w / h));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 106px "KaiTi", "Noto Serif SC", serif';
    ctx.fillText(text, canvas.width / 2, 64, canvas.width - 24);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.textures.add(texture);
    const mesh = this.mesh(new THREE.PlaneGeometry(w, h), this.ownMaterial(new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false })), parent);
    mesh.position.set(x, y, z);
    return mesh;
  }
  private pegColor(peg: PegMeta): number | string {
    if (peg.kind === 'enemy') return WUXING_HEX[peg.wuxing ?? 'metal'];
    if (peg.kind === 'golden') return 0xcfad59;
    if (peg.kind === 'spear') return 0x6a9faa;
    if (peg.kind === 'destructible') return 0xab784b;
    if (peg.kind === 'weak') return 0xb84b61;
    if (peg.kind === 'armored') return 0x74777f;
    return 0xd5d8de;
  }

  private buildElementRegions(): void {
    const glyph: Record<Wuxing, string> = { metal: '金 · 锋', wood: '木 · 生', water: '水 · 流', fire: '火 · 焰', earth: '土 · 镇' };
    for (const key of Object.keys(glyph) as Wuxing[]) {
      const members = this.stage.pegs.filter((p) => p.kind === 'enemy' && p.wuxing === key);
      if (!members.length) continue;
      const x = members.reduce((n, p) => n + p.x, 0) / members.length;
      const y = members.reduce((n, p) => n + p.y, 0) / members.length;
      const radius = Math.max(1.6, ...members.map((p) => Math.hypot(p.x - x, p.y - y) + p.r + 0.5));
      const color = new THREE.Color(WUXING_HEX[key]);
      const base = this.mesh(new THREE.CircleGeometry(radius, key === 'metal' ? 6 : key === 'earth' ? 4 : 48), this.ownMaterial(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.055, depthWrite: false })));
      base.position.set(x, y, -0.66);
      if (key === 'earth') base.rotation.z = Math.PI / 4;
      const segments = key === 'metal' ? 6 : key === 'earth' ? 4 : key === 'fire' ? 10 : 64;
      const points: THREE.Vector3[] = [];
      for (let i = 0; i <= segments; i++) {
        const a = i / segments * Math.PI * 2;
        const r = radius * (key === 'fire' && i % 2 ? 0.78 : 1);
        points.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
      }
      const line = new THREE.Line(this.ownGeometry(new THREE.BufferGeometry().setFromPoints(points)), this.ownMaterial(new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.36, depthWrite: false })));
      line.position.set(x, y, -0.64);
      if (key === 'earth') line.rotation.z = Math.PI / 4;
      this.group.add(line);
      if (key === 'water' || key === 'wood') {
        const ring = this.mesh(new THREE.RingGeometry(radius * 0.78, radius * 0.8, 48), this.ownMaterial(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, depthWrite: false })));
        ring.position.set(x, y, -0.63);
      }
      this.label(glyph[key], x, y - radius - 0.35, 2.7, 0.5, WUXING_HEX[key], -0.55);
    }
  }

  private buildRecoveryPool(brass: THREE.Material): void {
    const p = this.stage.recovery;
    const shape = new THREE.Shape();
    shape.absellipse(0, 0, p.width / 2, p.height / 2, 0, Math.PI * 2, false, 0);
    const hole = new THREE.Path();
    hole.absellipse(0, 0, p.width * 0.43, p.height * 0.36, 0, Math.PI * 2, true, 0);
    shape.holes.push(hole);
    const rim = this.mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.16, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.04, bevelThickness: 0.04, curveSegments: 32 }), brass);
    rim.position.set(p.x, p.y, -0.39);
    rim.castShadow = true;
    this.poolWater = this.ownMaterial(new THREE.MeshPhysicalMaterial({ color: 0x156e6a, emissive: 0x19cba7, emissiveIntensity: 0.18, metalness: 0.18, roughness: 0.15, clearcoat: 0.8, transparent: true, opacity: 0.85 }));
    const water = this.mesh(new THREE.CircleGeometry(1, 48), this.poolWater);
    water.scale.set(p.width * 0.43, p.height * 0.36, 1);
    water.position.set(p.x, p.y, -0.26);
    for (let i = 0; i < 3; i++) {
      const ripple = this.mesh(new THREE.RingGeometry(0.8, 0.82, 48), this.ownMaterial(new THREE.MeshBasicMaterial({ color: 0x9fffe8, transparent: true, opacity: 0.18, depthWrite: false })));
      ripple.position.set(p.x, p.y, -0.23);
      this.poolRipples.push(ripple);
    }
    this.poolProgress = this.mesh(new THREE.RingGeometry(0.92, 1, 48, 1, 0, 0.01), this.ownMaterial(new THREE.MeshBasicMaterial({ color: 0x8cffd7, transparent: true, opacity: 0.8, depthWrite: false })));
    this.poolProgress.position.set(p.x, p.y, -0.16);
    this.poolProgress.scale.set(p.width / 2, p.height / 2, 1);
    this.label('恢复池', p.x, p.y, 2.4, 0.52, '#baffea', -0.08);
  }

  setRecovery(state: { charge: number; max: number; pulse: number }): void {
    this.recoveryPulse = state.pulse;
    const ratio = state.charge / Math.max(1, state.max);
    this.poolWater.emissiveIntensity = 0.15 + ratio * 0.45 + state.pulse * 0.4;
    if (state.charge !== this.poolCharge) {
      this.poolCharge = state.charge;
      this.geometries.delete(this.poolProgress.geometry);
      this.poolProgress.geometry.dispose();
      this.poolProgress.geometry = this.ownGeometry(new THREE.RingGeometry(0.92, 1, 48, 1, Math.PI / 2, Math.max(0.01, ratio * Math.PI * 2)));
    }
  }
  private addPeg(peg: PegMeta): void {
    const root = new THREE.Group();
    root.position.set(peg.x, peg.y, 0.0);
    this.group.add(root);
    const enemy = peg.kind === 'enemy';
    const mat = this.ownMaterial(new THREE.MeshStandardMaterial({ color: this.pegColor(peg), metalness: enemy ? 0.25 : 1, roughness: enemy ? 0.22 : 0.12, envMapIntensity: enemy ? 0.28 : 2.4 }));
    if (enemy) {
      const card = this.enemyCards.create(peg.r, peg.wuxing ?? 'metal', peg.enemyId);
      root.add(card.group);
      const badge = this.label(WUXING_LABEL[peg.wuxing ?? 'metal'], peg.r * .65, -peg.r * .84,
        peg.r * .6, peg.r * .5, '#ffffff', .47);
      this.group.remove(badge);
      root.add(badge);
      this.pegs.set(peg.id, { root, material: mat, enemyCard: card, flash: 0, kind: peg.kind });
      return;
    }
    const stem = new THREE.Mesh(this.ownGeometry(new THREE.CylinderGeometry(peg.r * 0.43, peg.r * 0.5, 0.65, 12)), mat);
    stem.rotation.x = Math.PI / 2;
    stem.position.z = -0.25;
    root.add(stem);
    const head = new THREE.Mesh(this.ownGeometry(new THREE.SphereGeometry(peg.r, enemy ? 28 : 18, enemy ? 18 : 12)), mat);
    if (enemy) head.scale.z = 0.26;
    head.position.z = 0.17;
    head.castShadow = true;
    head.receiveShadow = true;
    root.add(head);
    const view: PegVisual = { root, material: mat, flash: 0, kind: peg.kind };
    this.pegs.set(peg.id, view);
  }

  setEnemyHp(id: string, ratio: number): void {
    const view = this.pegs.get(id);
    if (view?.enemyCard) { view.enemyCard.setHp(ratio); return; }
    const meta = this.board.pegs.find((p) => p.id === id);
    if (!view?.hp || !meta) return;
    view.hp.geometry.dispose();
    this.geometries.delete(view.hp.geometry);
    view.hp.geometry = this.ownGeometry(new THREE.TorusGeometry(meta.r + 0.08, 0.035, 6, 28, Math.PI * 2 * Math.max(0.001, ratio)));
    view.hp.visible = ratio > 0;
  }
  syncPegs(): void {
    for (const peg of this.board.pegs) {
      const view = this.pegs.get(peg.id);
      if (!view) continue;
      view.root.visible = peg.alive;
      if (view.kind !== peg.kind) {
        view.kind = peg.kind;
        view.material.color.set(this.pegColor(peg));
      }
    }
  }
  flashPeg(id: string, intensity: number, _fromX?: number, _fromY?: number): void {
    const peg = this.pegs.get(id);
    if (peg) peg.flash = Math.min(1, 0.3 + intensity * 0.5);
  }
  setCooldown(ratio: number): void { this.cooldown = ratio; }
  setBallsLeft(_count: number): void { /* The HUD is the single readable shot counter. */ }
  setBallVisible(visible: boolean): void { this.ball.visible = visible; }
  setMarked(marked: boolean): void { this.marked = marked; }
  setFeverGate(on: boolean, _palette: { led: string; yakumono: string; accent: string }): void {
    this.fever = on;
    this.gate.visible = on;
  }
  setAim(angle: number, power01: number, charging: boolean, armed: boolean, x: number, y: number, ready: boolean): void {
    const power = THREE.MathUtils.lerp(SHOOT_MIN_POWER, SHOOT_MAX_POWER, power01);
    const key = `${angle.toFixed(1)}:${power.toFixed(1)}:${x.toFixed(1)}:${y.toFixed(1)}:${this.board.pegs.filter((p) => p.alive && !p.ghosted).length}`;
    if (armed && (key !== this.predictionKey || this.time - this.lastPrediction > 0.15)) {
      const result = this.board.preview(power, angle);
      const pos = this.aim.geometry.getAttribute('position') as THREE.BufferAttribute;
      const count = Math.min(result.points.length, pos.count);
      for (let i = 0; i < count; i++) pos.setXYZ(i, result.points[i]!.x, result.points[i]!.y, BOARD.ballZ);
      pos.needsUpdate = true;
      this.aim.geometry.setDrawRange(0, count);
      this.aim.computeLineDistances();
      this.predictionKey = key;
      this.lastPrediction = this.time;
    }
    this.aim.visible = armed && (ready || charging) && this.board.state === 'live';
    this.readyRing.visible = armed && (ready || charging) && this.board.state === 'live';
    this.readyRing.position.set(x, y, BOARD.ballZ + 0.11);
    (this.readyRing.material as THREE.MeshBasicMaterial).opacity = this.cooldown * (0.82 + Math.sin(this.time * 5) * 0.12);
  }

  /**
   * 弹射杆下拉。`pull01` 是归一化蓄力，`charging` 决定杆是否真的沉下去。
   *
   * 杆沉下去的同时弹簧压扁——**这两个必须同步**：只让杆动而弹簧不动，
   * 玩家读不出「张力在积累」，蓄力就退化成一个纯计时条。
   */
  setPlungerPull(pull01: number, charging: boolean): void {
    this.plungerPull = charging ? pull01 : 0;
  }
  update(dt: number, board: PhysicsBoard, _fx: Fx): void {
    this.time += dt;
    /*
     * 翻板角度直接抄物理层的 `angle`。
     *
     * 不能在渲染层按 `t` 自己插一遍：物理体的运动是有「预约→求解」一帧延时的
     * （`setNextKinematicRotation`），两边各算各的会让板看起来比球慢半拍，
     * 而那半拍正好是玩家判断「我这一板打早了还是打晚了」的全部依据。
     */
    for (const f of board.flippers) {
      const mesh = this.flipperMeshes.get(f.geom.id);
      if (mesh) mesh.rotation.z = f.angle;
    }
    this.ball.visible = board.state !== 'done';
    // 弹射杆只在球待发时露出来。球已经在盘上滚的时候杆缩回去，
    // 玩家就不会分不清「现在该拉杆还是该瞄准」。
    this.plungerGroup.visible = board.state === 'idle';
    if (this.plungerGroup.visible) {
      const drop = PLUNGER.pullStroke * this.plungerPull;
      this.plungerHead.position.y = 0.4 - drop;
      // 弹簧跟着压缩：杆下移时弹簧变矮，不能跟着一起沉下去（那看着像整体平移）
      const squash = 1 - 0.55 * this.plungerPull;
      this.plungerSpring.scale.y = squash;
      this.plungerSpring.position.y = 0.4 - 0.7 * squash - drop * 0.25;
    }
    this.ball.position.set(board.ballX, board.ballY, BOARD.ballZ);
    this.ball.rotation.x += board.ballVY * dt;
    this.ball.rotation.y += board.ballVX * dt;
    if (board.state === 'live') {
      for (const point of this.trailPoints) point.age += dt;
      this.trailPoints.push({ x: board.ballX, y: board.ballY, age: 0 });
      while (this.trailPoints.length > 90 || (this.trailPoints[0]?.age ?? 0) > 0.65) this.trailPoints.shift();
    } else this.trailPoints.length = 0;
    const positions = this.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colors = this.trail.geometry.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < this.trailPoints.length; i++) {
      const point = this.trailPoints[i]!;
      const light = Math.max(0, 1 - point.age / 0.65);
      positions.setXYZ(i, point.x, point.y, BOARD.ballZ - 0.07);
      colors.setXYZ(i, light * 0.6, light * 0.85, light);
    }
    positions.needsUpdate = colors.needsUpdate = true;
    this.trail.geometry.setDrawRange(0, this.trailPoints.length);
    this.trail.visible = this.trailPoints.length > 1;
    const pool = this.stage.recovery;
    for (let i = 0; i < this.poolRipples.length; i++) {
      const phase = (this.time * 0.45 + i / 3) % 1;
      this.poolRipples[i]!.scale.set(pool.width * 0.44 * phase, pool.height * 0.36 * phase, 1);
      (this.poolRipples[i]!.material as THREE.MeshBasicMaterial).opacity = (1 - phase) * (0.22 + this.recoveryPulse * 0.4);
    }
    for (const meta of board.pegs) {
      const view = this.pegs.get(meta.id);
      if (!view) continue;
      view.flash = Math.max(0, view.flash - dt * 5);
      view.material.emissive.setHex(0xffd99b);
      view.material.emissiveIntensity = view.flash * 0.7;
      view.material.transparent = meta.ghosted;
      view.material.opacity = meta.ghosted ? 0.2 : 1;
      view.root.visible = meta.alive;
      view.enemyCard?.update(dt, view.flash, meta.ghosted);
    }
    for (const slot of board.slots) {
      const material = this.slotFaces.get(slot.id);
      if (material) material.emissiveIntensity = (slot.kind === 'boss' ? 0.35 : 0) + slot.flash * 0.55;
    }
    // 移动落槽：整排跟着物理层的偏移走，渲染层不自算相位
    this.slotRow.position.x = board.slotOffset;
    for (const zone of board.zones) {
      const material = this.zoneFaces.get(zone.id);
      if (material) material.opacity = 0.04 + zone.glow * 0.12;
    }
    if (this.bossSlot) this.bossSlot.emissiveIntensity += (this.marked ? 0.24 : 0) + (this.fever ? 0.18 : 0);
  }
  dispose(): void {
    this.disposed = true;
    for (const view of this.pegs.values()) view.enemyCard?.dispose();
    this.enemyCards.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.group.clear();
  }
}
