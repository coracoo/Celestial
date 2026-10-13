import * as THREE from 'three';
import type { StrikePreview } from '../sim/types.ts';

/** Reused meshes keep moving previews allocation-free on the GPU. */
class StrikeLayer {
  readonly group = new THREE.Group();
  private readonly shapes: { group: THREE.Group; shape: 'line' | 'circle' }[] = [];
  private readonly targets: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly fill = new THREE.MeshBasicMaterial({ transparent: true, opacity: .13, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
  private readonly edge = new THREE.LineBasicMaterial({ transparent: true, opacity: .9, depthWrite: false, depthTest: false });

  set(preview: StrikePreview): void {
    this.group.visible = true;
    this.fill.color.set(preview.color);
    this.edge.color.set(preview.color);
    preview.primitives.forEach((p, index) => {
      let slot = this.shapes[index];
      if (slot && slot.shape !== p.shape) {
        this.clearShape(slot.group);
        this.group.remove(slot.group);
        slot = undefined!;
      }
      if (!slot) {
        const group = new THREE.Group();
        const geometry = p.shape === 'circle' ? new THREE.CircleGeometry(1, 80) : new THREE.PlaneGeometry(2, 2);
        group.add(new THREE.Mesh(geometry, this.fill));
        const points = p.shape === 'circle'
          ? Array.from({ length: 80 }, (_, i) => new THREE.Vector3(Math.cos(i / 80 * Math.PI * 2), Math.sin(i / 80 * Math.PI * 2), 0))
          : [new THREE.Vector3(-1, -1, 0), new THREE.Vector3(1, -1, 0), new THREE.Vector3(1, 1, 0), new THREE.Vector3(-1, 1, 0)];
        group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), this.edge));
        slot = { group, shape: p.shape };
        this.shapes[index] = slot;
        this.group.add(group);
      }
      slot.group.visible = true;
      slot.group.position.set(p.x, p.y, .9);
      slot.group.rotation.z = p.shape === 'line' ? THREE.MathUtils.degToRad(p.angleDeg) : 0;
      slot.group.scale.set(p.shape === 'line' ? p.halfLength : p.radius, p.shape === 'line' ? p.halfWidth : p.radius, 1);
    });
    this.shapes.forEach((slot, i) => { slot.group.visible = i < preview.primitives.length; });
    preview.targets.forEach((target, index) => {
      let ring = this.targets[index];
      if (!ring) {
        ring = new THREE.Mesh(new THREE.RingGeometry(1, 1.13, 36), new THREE.MeshBasicMaterial({ transparent: true, opacity: .95, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
        ring.renderOrder = 12;
        this.targets[index] = ring;
        this.group.add(ring);
      }
      ring.visible = true;
      ring.position.set(target.x, target.y, 1.1);
      ring.scale.setScalar(target.r + .15);
      ring.material.color.set(target.kill ? '#ffde7a' : preview.color);
    });
    this.targets.forEach((ring, i) => { ring.visible = i < preview.targets.length; });
  }

  fade(ratio: number): void {
    this.fill.opacity = .32 * ratio;
    this.edge.opacity = ratio;
    this.targets.forEach((ring) => { ring.material.opacity = ratio; });
  }

  private clearShape(group: THREE.Group): void {
    group.traverse((object) => { if (object instanceof THREE.Mesh || object instanceof THREE.Line) object.geometry.dispose(); });
  }

  dispose(): void {
    this.shapes.forEach((slot) => this.clearShape(slot.group));
    this.targets.forEach((ring) => { ring.geometry.dispose(); ring.material.dispose(); });
    this.fill.dispose();
    this.edge.dispose();
    this.group.clear();
  }
}

export class StrikeView {
  readonly group = new THREE.Group();
  private readonly preview = new StrikeLayer();
  private readonly flashes: { layer: StrikeLayer; left: number }[] = [];

  constructor() {
    this.preview.group.visible = false;
    this.group.add(this.preview.group);
  }

  show(preview: StrikePreview | null): void {
    if (preview) this.preview.set(preview);
    else this.preview.group.visible = false;
  }

  strike(preview: StrikePreview): void {
    const layer = new StrikeLayer();
    layer.set(preview);
    layer.fade(1);
    this.group.add(layer.group);
    this.flashes.push({ layer, left: .36 });
  }

  update(dt: number): void {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const flash = this.flashes[i]!;
      flash.left -= dt;
      flash.layer.fade(Math.max(0, flash.left / .36));
      if (flash.left <= 0) {
        this.group.remove(flash.layer.group);
        flash.layer.dispose();
        this.flashes.splice(i, 1);
      }
    }
  }

  dispose(): void {
    this.preview.dispose();
    this.flashes.forEach((flash) => flash.layer.dispose());
    this.flashes.length = 0;
    this.group.clear();
  }
}
