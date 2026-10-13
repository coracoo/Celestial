import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BOARD, PHYSICS, clamp } from './constants.ts';

/** 变步长回调（渲染帧） */
export type FrameFn = (dt: number, elapsed: number) => void;
/** 定步长回调（物理步） */
export type FixedFn = (dt: number) => void;

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;

  private frames: FrameFn[] = [];
  private fixed: FixedFn[] = [];
  private raf = 0;
  private last = 0;
  private acc = 0;
  private elapsed = 0;
  private running = false;

  /** 镜头抖动 */
  private shakeAmp = 0;
  private shakeLeft = 0;
  private shakeDur = 1;
  private basePos = new THREE.Vector3();
  private lookTarget = new THREE.Vector3(0, BOARD.centerY, 0);
  private tmp = new THREE.Vector3();
  private zoom = 1;
  private zoomTarget = 1;
  private manual: { pos: THREE.Vector3; look: THREE.Vector3 } | null = null;
  /** 跟球视差偏移，见 setCameraFollow */
  private followX = 0;
  private followY = 0;
  private battleFrame: { width: number; height: number; centerX: number } | null = null;
  private measuredFrames = 0;
  private measuredTime = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.setClearColor(0x171315, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    // 机台是个亮内舱，不是户外夜景。雾一浓，铬合金和背玻璃的细节全被吃掉。
    this.scene.fog = new THREE.FogExp2(0x171315, 0.002);
    this.buildEnvironment();

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 260);
    this.buildLights();
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  /**
   * 金属材质没有环境贴图会渲染成近黑色。这里用一张程序化环境做 PMREM，
   * 让钉板、侧轨和钢珠的镀铬质感出光，不需要任何外部 HDR 资源。
   *
   * 关键是**顶部要亮**：机台顶灯打在铬件上是一条贯穿的高光带，
   * 顶部压暗的话钢珠和钢钉就只是几块灰。
   */
  private buildEnvironment(): void {
    // A modeled softbox room provides real high/low reflection structure for chrome.
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    this.scene.environmentIntensity = 0.22;
    room.dispose();
    pmrem.dispose();
  }

  private buildLights(): void {
    const hemi = new THREE.HemisphereLight(0xf5ead9, 0x26181b, 0.48);
    this.scene.add(hemi);

    // 主灯当机台顶灯：从正前上方打，让铬件出高光
    const key = new THREE.DirectionalLight(0xfff4e2, 2.1);
    key.position.set(-15, 31, 32);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 4;
    key.shadow.camera.far = 90;
    key.shadow.camera.left = -20;
    key.shadow.camera.right = 20;
    key.shadow.camera.top = 21;
    key.shadow.camera.bottom = -21;
    key.shadow.bias = -0.0005;
    key.shadow.radius = 3;
    key.shadow.normalBias = 0.03;
    key.target.position.set(0, 16, 0);
    this.scene.add(key, key.target);

    // 冷色背光，把钉板和侧轨从背玻璃上剥离出来
    const rim = new THREE.DirectionalLight(0xc8d6ea, 0.65);
    rim.position.set(11, 6, -14);
    this.scene.add(rim);

    // 暖色正面补光，避免下半盘面死黑
    const fill = new THREE.PointLight(0xffe7c2, 24, 38, 2);
    fill.position.set(0, 3.4, 6.5);
    this.scene.add(fill);

    // 底部反射光：模拟落槽区自己的灯，让下半盘面有向上的辉光
    const bounce = new THREE.PointLight(0xffd27a, 22, 26, 2);
    bounce.position.set(0, -1.5, 4);
    this.scene.add(bounce);
  }

  onFrame(fn: FrameFn): void {
    this.frames.push(fn);
  }

  onFixed(fn: FixedFn): void {
    this.fixed.push(fn);
  }

  shake(amp: number, duration = 0.35): void {
    // 取更强的一次，避免小抖动打断大抖动
    if (amp >= this.shakeAmp || this.shakeLeft <= 0) {
      this.shakeAmp = amp;
      this.shakeDur = Math.max(0.08, duration);
      this.shakeLeft = this.shakeDur;
    }
  }

  /** 1 = 原始取景，>1 拉近（用于命中时的镜头推进） */
  setZoom(z: number): void {
    this.zoomTarget = clamp(z, 0.6, 1.6);
  }

  lookAtBoard(y = BOARD.centerY): void {
    this.lookTarget.set(0, y, 0);
  }

  /** 覆盖自动取景：抽卡 / 图鉴展示用 */
  setManualCamera(pos: THREE.Vector3, look: THREE.Vector3): void {
    this.manual = { pos: pos.clone(), look: look.clone() };
  }

  /**
   * 把一个 worldW × worldH 的盒子居中框进指定的 CSS 像素矩形。
   * 抽卡 / 图鉴的卡牌用它避开左右 UI 面板，横屏窄缝里也不会被裁掉。
   */
  frameInRect(
    worldW: number,
    worldH: number,
    rect: { x: number; y: number; w: number; h: number },
    margin = 1.06,
  ): void {
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    const halfH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const halfW = halfH * this.camera.aspect;

    // 目标框只占整屏的 (rect.w/vw, rect.h/vh)，所以两个方向要各自按自己的占比缩放，
    // 各自算完再取最大值——不能先取 max 再统一乘，否则窄缝会被缩两次。
    const fitH = ((worldH / 2) * margin / halfH) * (vh / Math.max(1, rect.h));
    const fitW = ((worldW / 2) * margin / halfW) * (vw / Math.max(1, rect.w));
    const dist = Math.max(fitH, fitW);

    // 让世界原点落在矩形中心：反解 NDC 偏移。
    // 注意 look 必须跟 pos 的 XY 相同、Z 取 0 —— 相机要平移并且**不看**原点。
    // 只挪 pos 而 look 仍写 (0,0,0) 的话，相机是绕着原点转的，原点照样钉在屏幕正中，
    // 横向偏移只会被抵消成一次透视歪斜，永远避不开左右面板。
    const ndcX = ((rect.x + rect.w / 2) / vw) * 2 - 1;
    const ndcY = 1 - ((rect.y + rect.h / 2) / vh) * 2;
    const offX = -ndcX * dist * halfW;
    const offY = -ndcY * dist * halfH;
    this.manual = {
      pos: new THREE.Vector3(offX, offY, dist),
      look: new THREE.Vector3(offX, offY, 0),
    };
  }

  clearManualCamera(): void {
    this.manual = null;
  }

  /** 固定的机台取景，保留顶部血条与底部操作区，并随窗口重新计算。 */
  fitBattle(width: number, height: number, centerX = 0): void {
    this.battleFrame = { width, height, centerX };
    this.manual = null;
    this.zoom = this.zoomTarget = 1;
    this.followX = this.followY = 0;
    this.resize();
  }

  clearBattleFraming(): void {
    this.battleFrame = null;
    this.manual = null;
    this.zoom = this.zoomTarget = 1;
    this.followX = this.followY = 0;
    this.resize();
  }

  private fitCabinet(w: number, h: number): void {
    const dims = this.battleFrame!;
    // 窄屏技能移到下方，横屏两边预留 HUD。透视包围盒也包含机台厚度。
    const narrow = w <= 800;
    const side = narrow ? 12 : Math.min(252, w * 0.215);
    const top = narrow ? 222 : 56;
    const bottom = narrow ? 192 : 50;
    const rect = { x: side, y: top, w: Math.max(180, w - side * 2), h: Math.max(220, h - top - bottom) };
    const pitch = narrow ? 0.08 : 0.18;
    const direction = new THREE.Vector3(0, -Math.sin(pitch), Math.cos(pitch));
    // 机台中心不在 0 上：弹射道挂在主盘右边，主盘内容仍然以 0 为中心。
    // 取景必须跟着 `centerX` 走，否则球道被切在画框外。
    const focus = new THREE.Vector3(dims.centerX, dims.height / 2, 0);
    const up = new THREE.Vector3(0, Math.cos(pitch), Math.sin(pitch));
    const verticalNdc = 1 - 2 * (rect.y + rect.h / 2) / h;
    const halfFov = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    let distance = Math.max((dims.height + 3) / (2 * halfFov * rect.h / h), (dims.width + 4.4) / (2 * halfFov * rect.w / h));
    const candidate = this.camera.clone();
    const corner = new THREE.Vector3();
    // Project all eight corners to account for perspective (including rails in front).
    for (let iteration = 0; iteration < 4; iteration++) {
      candidate.position.copy(focus).addScaledVector(direction, distance);
      candidate.lookAt(focus);
      candidate.updateMatrixWorld(true);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const x of [dims.centerX - (dims.width + 4.4) / 2, dims.centerX + (dims.width + 4.4) / 2]) {
        for (const y of [-1.4, dims.height + 1.4]) {
          for (const z of [-4.35, 1.4]) {
            corner.set(x, y, z).project(candidate);
            minX = Math.min(minX, corner.x);
            maxX = Math.max(maxX, corner.x);
            minY = Math.min(minY, corner.y);
            maxY = Math.max(maxY, corner.y);
          }
        }
      }
      focus.addScaledVector(up, ((minY + maxY) / 2 - verticalNdc) * distance * halfFov);
      distance *= Math.max((maxX - minX) / (2 * rect.w / w), (maxY - minY) / (2 * rect.h / h)) * 1.01;
    }
    this.basePos.copy(focus).addScaledVector(direction, distance);
    this.lookTarget.copy(focus);
  }

  private resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.battleFrame) {
      this.fitCabinet(w, h);
      return;
    }

    const portrait = this.camera.aspect < BOARD.portraitAspect;
    const viewH = portrait ? BOARD.portraitViewHeight : BOARD.viewHeight;
    const viewW = portrait ? BOARD.portraitViewWidth : BOARD.viewWidth;
    const centerY = portrait ? BOARD.portraitCenterY : BOARD.viewCenterY;

    const halfH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const distH = viewH / 2 / halfH;
    const distW = viewW / 2 / (halfH * this.camera.aspect);
    const dist = Math.max(distH, distW);

    this.basePos.set(0, centerY, dist);
    this.lookTarget.set(0, centerY, 0);
    this.camera.updateProjectionMatrix();
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      // 大幅卡顿时钳制 dt，避免物理爆炸
      const raw = (now - this.last) / 1000;
      this.last = now;
      const dt = Math.min(raw, 0.1);
      this.elapsed += dt;

      this.acc += dt;
      let steps = 0;
      while (this.acc >= PHYSICS.fixedDt && steps < PHYSICS.maxSubSteps) {
        for (const fn of this.fixed) fn(PHYSICS.fixedDt);
        this.acc -= PHYSICS.fixedDt;
        steps++;
      }
      if (steps === PHYSICS.maxSubSteps) this.acc = 0;

      this.updateCamera(dt);
      for (const fn of this.frames) fn(dt, this.elapsed);
      this.renderer.render(this.scene, this.camera);
      this.measuredFrames++;
      this.measuredTime += raw;
      if (this.measuredTime >= 1) {
        // DOM diagnostics for browser QA; no debug controls in the player interface.
        this.canvas.dataset.fps = (this.measuredFrames / this.measuredTime).toFixed(1);
        this.canvas.dataset.drawCalls = String(this.renderer.info.render.calls);
        this.canvas.dataset.triangles = String(this.renderer.info.render.triangles);
        this.measuredFrames = this.measuredTime = 0;
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private updateCamera(dt: number): void {
    this.zoom += (this.zoomTarget - this.zoom) * Math.min(1, dt * 6);

    let ox = 0;
    let oy = 0;
    if (this.shakeLeft > 0) {
      this.shakeLeft -= dt;
      const k = Math.max(0, this.shakeLeft / this.shakeDur);
      const amp = this.shakeAmp * k * k;
      const t = this.elapsed * 46;
      ox = Math.sin(t * 1.7) * amp + Math.sin(t * 3.9) * amp * 0.4;
      oy = Math.cos(t * 2.3) * amp + Math.sin(t * 5.1) * amp * 0.3;
      if (this.shakeLeft <= 0) this.shakeAmp = 0;
    }

    // 跟球视差偏移。和 manual 是**两条独立通道**：
    // manual 是给抽卡/图鉴那种「相机摆到指定位置」用的，一旦设上就绕开
    // 自动取景和 zoom 逻辑；跟球偏移要的是「在自动取景的基础上平移一点」，
    // 走 manual 会把 zoom 一起废掉。两条混用的话，抽卡进图鉴时相机会跳。
    ox += this.followX;
    oy += this.followY;

    const base = this.manual ? this.manual.pos : this.tmp.copy(this.basePos).sub(this.lookTarget).multiplyScalar(1 / this.zoom);
    const look = this.manual ? this.manual.look : this.lookTarget;
    if (this.manual) this.camera.position.copy(this.manual.pos);
    else this.camera.position.set(look.x + base.x + ox, look.y + base.y + oy, look.z + base.z);
    if (this.manual) {
      this.camera.position.x += ox;
      this.camera.position.y += oy;
    }
    this.camera.lookAt(look);
  }

  /**
   * 跟球视差偏移（世界单位）。战斗层每帧按球的位置给过来。
   *
   * 这是「立体视觉」的核心：摄像机**不动**就没有视差，没有视差空间感就是零。
   * 球往左滚，摄像机微微左移，钉阵和背玻璃之间就产生了相对位移，
   * 玩家的大脑会自动把这个相对位移解读成「这些东西在不同深度上」。
   *
   * 幅度必须小。超过约 1bu 取景框会跟着晃，瞄准会变得极其难受——
   * 玩家在追一个自己也在动的目标，那不是难度，是操作惩罚。
   */
  setCameraFollow(x: number, y: number): void {
    this.followX = x;
    this.followY = y;
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.resize);
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    this.renderer.dispose();
  }
}
