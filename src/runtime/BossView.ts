import * as THREE from 'three';
import type { BossDef } from '../data/schema.ts';

/** Boss identity sits on the cabinet header; damage feedback stays at the scoring mouth. */
export class BossView {
  readonly group = new THREE.Group();
  private readonly crest: THREE.Mesh;
  private readonly crestMaterial: THREE.MeshStandardMaterial;
  private readonly mouth: THREE.Mesh;
  private readonly mouthMaterial: THREE.MeshBasicMaterial;
  private readonly labelTexture: THREE.Texture;
  private flash = 0;
  private hp = 1;
  private dead = false;
  private shielded = false;

  constructor(def: BossDef) {
    this.group.name = '守将铭牌';
    this.crestMaterial = new THREE.MeshStandardMaterial({
      color: 0xc6a369, metalness: 0.74, roughness: 0.35,
    });
    this.crest = new THREE.Mesh(new THREE.CylinderGeometry(0.77, 0.77, 0.12, 36), this.crestMaterial);
    this.crest.rotation.x = Math.PI / 2;
    this.crest.position.set(0, 30.65, -0.57);
    this.crest.castShadow = true;
    this.group.add(this.crest);
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#33201a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 148px KaiTi, "Noto Serif SC", serif';
    ctx.fillText(def.name.includes('虎') ? '虎' : def.name.slice(0, 1), 128, 137);
    ctx.strokeStyle = '#614229';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(128, 128, 114, 0, Math.PI * 2);
    ctx.stroke();
    this.labelTexture = new THREE.CanvasTexture(canvas);
    this.labelTexture.colorSpace = THREE.SRGBColorSpace;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(1.44, 1.44), new THREE.MeshBasicMaterial({ map: this.labelTexture, transparent: true, depthWrite: false, toneMapped: false }));
    face.position.set(0, 30.65, -0.49);
    this.group.add(face);
    this.mouthMaterial = new THREE.MeshBasicMaterial({ color: 0xe77972, transparent: true, opacity: 0.3, depthWrite: false });
    this.mouth = new THREE.Mesh(new THREE.TorusGeometry(def.weakPoint.r * 0.6, 0.035, 6, 32), this.mouthMaterial);
    this.mouth.position.set(def.weakPoint.x, def.weakPoint.y, -0.1);
    this.group.add(this.mouth);
  }
  hit(intensity: number): void { this.flash = Math.min(1, this.flash + intensity); }
  setHp(ratio: number): void { this.hp = THREE.MathUtils.clamp(ratio, 0, 1); }
  setPhase(_index: number, shielded: boolean): void { this.shielded = shielded; }
  /**
   * 破绽口对位。破绽判定圈跟着落槽排漂移，Boss 的嘴必须跟着一起走，
   * 否则玩家看到的嘴和实际吃 ×weakSlotMult 的位置差出小半个槽距。
   */
  setWeakX(x: number): void { this.mouth.position.x = x; }
  setDead(dead: boolean): void { this.dead = dead; }
  update(dt: number, frenzy: number): void {
    this.flash = Math.max(0, this.flash - dt * 3);
    this.crestMaterial.color.setHex(this.shielded ? 0x9bbbc4 : 0xc6a369);
    this.crestMaterial.emissive.setHex(0xd35c43);
    this.crestMaterial.emissiveIntensity = this.flash * 0.3;
    this.mouthMaterial.opacity = this.dead ? 0 : 0.22 + this.flash * 0.65 + (1 - this.hp) * 0.1;
    this.mouth.scale.setScalar(1 + this.flash * 0.08);
    this.mouthMaterial.color.setHex(frenzy > 0.1 ? 0xff9360 : 0xe77972);
  }
  dispose(): void {
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    });
    this.labelTexture.dispose();
    this.group.clear();
  }
}
