import * as THREE from 'three';

const MAX_PARTICLES = 900;
const MAX_RINGS = 14;
const MAX_BEAMS = 6;

function dotTexture(): THREE.Texture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.72)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function ringTexture(): THREE.Texture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(s / 2, s / 2, s * 0.26, s / 2, s / 2, s * 0.5);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.72, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.88, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  size: number;
  r: number;
  g: number;
  b: number;
}

interface Ring {
  mesh: THREE.Mesh;
  life: number;
  max: number;
  from: number;
  to: number;
}

interface Beam {
  mesh: THREE.Mesh;
  life: number;
  max: number;
}

/** 通用打击反馈层：粒子、冲击波环、光柱。全部对象池化，不在战斗中分配。 */
export class Fx {
  readonly group = new THREE.Group();
  private readonly points: THREE.Points;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly pool: Particle[] = [];
  private readonly rings: Ring[] = [];
  private readonly beams: Beam[] = [];
  private readonly ringTex = ringTexture();

  constructor() {
    this.group.name = 'fx';
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    this.sizes = new Float32Array(MAX_PARTICLES);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));

    const mat = new THREE.PointsMaterial({
      size: 0.4,
      map: dotTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.group.add(this.points);

    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.pool.push({
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        life: 0, max: 1, size: 0.4, r: 1, g: 1, b: 1,
      });
    }

    const ringGeo = new THREE.RingGeometry(0.7, 1, 64);
    for (let i = 0; i < MAX_RINGS; i++) {
      const mat2 = new THREE.MeshBasicMaterial({
        map: this.ringTex,
        color: 0xffffff,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(ringGeo, mat2);
      mesh.visible = false;
      this.group.add(mesh);
      this.rings.push({ mesh, life: 0, max: 1, from: 0.6, to: 4 });
    }

    const beamGeo = new THREE.PlaneGeometry(2.2, 1, 1, 1);
    for (let i = 0; i < MAX_BEAMS; i++) {
      const mat2 = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(beamGeo, mat2);
      mesh.visible = false;
      this.group.add(mesh);
      this.beams.push({ mesh, life: 0, max: 1 });
    }
  }

  private free(): Particle | null {
    for (const p of this.pool) if (p.life <= 0) return p;
    return null;
  }

  burst(x: number, y: number, color: number, count: number, speed: number, size = 0.34): void {
    const c = new THREE.Color(color);
    for (let i = 0; i < count; i++) {
      const p = this.free();
      if (!p) return;
      const a = Math.random() * Math.PI * 2;
      const el = (Math.random() - 0.3) * 1.5;
      const sp = speed * (0.35 + Math.random() * 0.9);
      p.x = x;
      p.y = y;
      p.z = 0.9;
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp + el * sp * 0.4;
      p.vz = (Math.random() - 0.5) * 3;
      p.max = 0.4 + Math.random() * 0.45;
      p.life = p.max;
      p.size = size * (0.6 + Math.random() * 0.8);
      p.r = c.r;
      p.g = c.g;
      p.b = c.b;
    }
  }

  /** 定向喷射：技能冲击波、球拖尾 */
  jet(x: number, y: number, color: number, count: number, dirX: number, dirY: number, spread: number, speed: number): void {
    const c = new THREE.Color(color);
    const base = Math.atan2(dirY, dirX);
    for (let i = 0; i < count; i++) {
      const p = this.free();
      if (!p) return;
      const a = base + (Math.random() - 0.5) * spread;
      const sp = speed * (0.5 + Math.random() * 0.8);
      p.x = x;
      p.y = y;
      p.z = 0.9;
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.vz = (Math.random() - 0.5) * 2;
      p.max = 0.3 + Math.random() * 0.4;
      p.life = p.max;
      p.size = 0.26 + Math.random() * 0.3;
      p.r = c.r;
      p.g = c.g;
      p.b = c.b;
    }
  }

  ring(x: number, y: number, color: number, from: number, to: number, duration: number): void {
    const r = this.rings.find((v) => v.life <= 0) ?? this.rings[0]!;
    r.life = duration;
    r.max = duration;
    r.from = from;
    r.to = to;
    r.mesh.visible = true;
    r.mesh.position.set(x, y, 1.1);
    r.mesh.scale.setScalar(from);
    (r.mesh.material as THREE.MeshBasicMaterial).color.set(color);
  }

  beam(x: number, color: number, height: number, duration: number): void {
    const b = this.beams.find((v) => v.life <= 0) ?? this.beams[0]!;
    b.life = duration;
    b.max = duration;
    b.mesh.visible = true;
    b.mesh.position.set(x, 16, 1.6);
    b.mesh.scale.set(1, height, 1);
    (b.mesh.material as THREE.MeshBasicMaterial).color.set(color);
  }

  update(dt: number): void {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.pool[i]!;
      const o = i * 3;
      if (p.life <= 0) {
        this.positions[o] = 0;
        this.positions[o + 1] = -999;
        this.positions[o + 2] = 0;
        this.sizes[i] = 0;
        continue;
      }
      p.life -= dt;
      p.vy -= 16 * dt;
      p.vx *= 1 - 2.2 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.z < 0.2) {
        p.z = 0.2;
        p.vz *= -0.5;
      }
      const k = Math.max(0, p.life / p.max);
      this.positions[o] = p.x;
      this.positions[o + 1] = p.y;
      this.positions[o + 2] = p.z;
      this.colors[o] = p.r * k;
      this.colors[o + 1] = p.g * k;
      this.colors[o + 2] = p.b * k;
      this.sizes[i] = p.size * (0.4 + k * 0.6);
    }
    const geo = this.points.geometry;
    geo.attributes.position!.needsUpdate = true;
    geo.attributes.color!.needsUpdate = true;
    geo.attributes.size!.needsUpdate = true;

    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      const k = 1 - Math.max(0, r.life) / r.max;
      const e = 1 - Math.pow(1 - k, 3);
      r.mesh.scale.setScalar(r.from + (r.to - r.from) * e);
      const m = r.mesh.material as THREE.MeshBasicMaterial;
      m.opacity = Math.max(0, 1 - k) * 0.95;
      if (r.life <= 0) r.mesh.visible = false;
    }

    for (const b of this.beams) {
      if (b.life <= 0) continue;
      b.life -= dt;
      const k = Math.max(0, b.life) / b.max;
      const m = b.mesh.material as THREE.MeshBasicMaterial;
      m.opacity = k * 0.7;
      b.mesh.scale.x = 0.6 + k * 0.9;
      if (b.life <= 0) b.mesh.visible = false;
    }
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    for (const r of this.rings) (r.mesh.material as THREE.Material).dispose();
    for (const b of this.beams) (b.mesh.material as THREE.Material).dispose();
    this.ringTex.dispose();
  }
}
