import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { enemyCardFor, type EnemyCardDef } from '../data/EnemyCards.ts';
import { CARD_BACK_ENEMY } from '../data/cardBacks.ts';
import { WUXING_HEX, type Wuxing } from '../data/schema.ts';
import { bindOpponentView, createOpponentMaterial, type OpponentMaterial, type OpponentTextures } from './OpponentMaterial.ts';

type TextureLoad = (path: string, onLoad: (texture: THREE.Texture) => void,
  onError?: (error: unknown) => void) => THREE.Texture;
type LayerName = keyof OpponentTextures;
const LAYERS: readonly LayerName[] = ['subject', 'background', 'frame'];
interface LayerResource {
  texture: THREE.Texture;
  ready: boolean;
  error: string | null;
  listeners: Set<() => void>;
}

/** Shared images are keyed by URL, not element; each unit owns only its materials and geometry. */
export class EnemyCardDeck {
  private readonly textures = new Map<string, LayerResource>();
  private readonly ownedTextures = new Set<THREE.Texture>();
  private readonly released = new Set<THREE.Texture>();
  private disposed = false;
  private readonly load: TextureLoad;

  constructor(load: TextureLoad = (path, onLoad, onError) => new THREE.TextureLoader().load(path, onLoad, undefined, onError)) {
    this.load = load;
  }

  create(radius: number, wuxing: Wuxing, enemyId?: string): EnemyCardVisual {
    if (this.disposed) throw new Error('EnemyCardDeck already disposed');
    const def = enemyCardFor(wuxing, enemyId);
    const resources = Object.fromEntries(LAYERS.map((name) => [name, this.layer(def.layers[name])])) as Record<LayerName, LayerResource>;
    const textures = Object.fromEntries(LAYERS.map((name) => [name, resources[name].texture])) as unknown as OpponentTextures;
    // The back plate is a flat sRGB photograph, not a hand-built shader layer, so
    // it keeps the renderer's own decode instead of the NoColorSpace convention
    // the opponent layer stack uses.
    const backResource = this.layer(CARD_BACK_ENEMY, THREE.SRGBColorSpace);
    const visual = new EnemyCardVisual(radius, def, textures, backResource.texture, () => {
      for (const resource of Object.values(resources)) resource.listeners.delete(sync);
      backResource.listeners.delete(sync);
    });
    const sync = () => {
      visual.group.userData.card.ready = LAYERS.every((name) => resources[name].ready);
      visual.group.userData.card.error = LAYERS.map((name) => resources[name].error).filter(Boolean).join('; ') || null;
      visual.face.material.uniforms.tSubject.value = resources.subject.texture;
      visual.face.material.uniforms.tBackground.value = resources.background.texture;
      visual.face.material.uniforms.tFrame.value = resources.frame.texture;
      visual.setBackPlate(backResource.texture, backResource.ready);
    };
    for (const resource of [...Object.values(resources), backResource]) resource.listeners.add(sync);
    sync();
    return visual;
  }

  private layer(path: string, colorSpace: THREE.ColorSpace = THREE.NoColorSpace): LayerResource {
    const cached = this.textures.get(path);
    if (cached) return cached;
    // TextureLoader returns a texture immediately; callbacks only update shared
    // resource state. No asynchronous callback ever adds scene objects.
    const resource: LayerResource = { texture: undefined as unknown as THREE.Texture,
      ready: false, error: null, listeners: new Set() };
    const notify = () => { for (const listener of resource.listeners) listener(); };
    const texture = this.load(path, (ready) => {
      if (this.disposed) { this.release(ready); return; }
      this.ownedTextures.add(ready);
      ready.colorSpace = colorSpace;
      ready.anisotropy = 4;
      resource.texture = ready;
      resource.ready = true;
      resource.error = null;
      notify();
    }, (error) => {
      if (this.disposed) return;
      resource.error = `${path}: ${String(error)}`;
      resource.ready = false;
      notify();
    });
    this.ownedTextures.add(texture);
    texture.colorSpace = colorSpace;
    texture.anisotropy = 4;
    if (!resource.texture) resource.texture = texture;
    this.textures.set(path, resource);
    return resource;
  }

  private release(texture: THREE.Texture): void {
    if (this.released.has(texture)) return;
    this.released.add(texture);
    texture.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const resource of this.textures.values()) resource.listeners.clear();
    for (const texture of this.ownedTextures) this.release(texture);
    this.ownedTextures.clear();
    this.textures.clear();
  }
}

export class EnemyCardVisual {
  readonly group = new THREE.Group();
  readonly face: THREE.Mesh<THREE.PlaneGeometry, OpponentMaterial>;
  readonly back: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly hitRing: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  readonly hpFill: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly body: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private readonly materials = new Set<THREE.Material>();
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly hpWidth: number;
  private hp = 1;
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(radius: number, def: EnemyCardDef, textures: OpponentTextures, backPlate: THREE.Texture,
    unsubscribe: () => void = () => {}) {
    this.unsubscribe = unsubscribe;
    this.group.name = def.name;
    this.group.userData.card = { id: def.id, ready: false, error: null, layers: def.layers };
    const color = WUXING_HEX[def.wuxing];
    const h = radius * 2.7, w = h * 2 / 3;
    this.hpWidth = w;
    this.body = new THREE.Mesh(new RoundedBoxGeometry(w + .07, h + .07, .12, 2, .025),
      new THREE.MeshStandardMaterial({ color, metalness: .68, roughness: .3 }));
    this.body.position.set(0, radius * .23, .35);
    this.body.castShadow = true;
    this.face = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      createOpponentMaterial(textures));
    this.face.position.set(0, radius * .23, .419);
    bindOpponentView(this.face);
    // The body slab spans z .29..41, so the back plate sits just outside it and
    // faces away from the camera. Turning the quad 180 degrees about Y both
    // presents it and un-mirrors the plate, so the artwork reads correctly.
    this.back = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: backPlate, toneMapped: false }));
    this.back.position.set(0, radius * .23, .285);
    this.back.rotation.y = Math.PI;
    this.back.visible = false;
    // The circle, not the tall illustration, is the unchanged physical target.
    this.hitRing = new THREE.Mesh(new THREE.TorusGeometry(radius, .027, 6, 40),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .72, depthWrite: false }));
    this.hitRing.position.z = .44;
    const hpBack = new THREE.Mesh(new THREE.PlaneGeometry(w + .08, .14),
      new THREE.MeshBasicMaterial({ color: '#160e13' }));
    hpBack.position.set(0, -radius * 1.2, .5);
    this.hpFill = new THREE.Mesh(new THREE.PlaneGeometry(w, .065),
      new THREE.MeshBasicMaterial({ color, toneMapped: false }));
    this.hpFill.position.set(0, -radius * 1.2, .51);
    this.group.add(this.body, this.face, this.back, this.hitRing, hpBack, this.hpFill);
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      this.geometries.add(object.geometry);
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) this.materials.add(material);
    });
  }

  /** The plate arrives asynchronously; until it does the slab's own back face shows. */
  setBackPlate(texture: THREE.Texture, ready: boolean): void {
    this.back.material.map = texture;
    this.back.visible = ready;
  }

  setHp(ratio: number): void {
    this.hp = THREE.MathUtils.clamp(ratio, 0, 1);
    this.hpFill.scale.x = this.hp;
    this.hpFill.position.x = this.hp === 1 ? 0 : -this.hpWidth * (1 - this.hp) / 2;
    this.hpFill.visible = this.hp > 0;
  }

  setAlive(alive: boolean): void { this.group.visible = alive; }

  update(_dt: number, flash: number, ghosted: boolean): void {
    const shade = .72 + this.hp * .28;
    this.face.material.uniforms.uTint.value.setRGB(shade, shade * (1 - flash * .3), shade * (1 - flash * .3));
    this.face.material.uniforms.uOpacity.value = ghosted ? .25 : 1;
    this.face.material.transparent = ghosted;
    this.face.material.depthWrite = !ghosted;
    this.face.material.opacity = ghosted ? .25 : 1;
    this.body.material.transparent = ghosted;
    this.body.material.opacity = ghosted ? .25 : 1;
    this.back.material.transparent = ghosted;
    this.back.material.opacity = ghosted ? .25 : 1;
    this.body.material.emissive.setHex(0xffe0a3);
    this.body.material.emissiveIntensity = flash * .6;
    this.hitRing.material.opacity = ghosted ? .25 : .72;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.face.onBeforeRender = () => {};
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.group.clear();
  }
}
