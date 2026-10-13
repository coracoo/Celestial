"""Import the official RuiC viewer shaders into the game's stable card API.

Shader provenance: https://github.com/HRuiCcc/RuiC-card-skill
The small substitutions align the browser expression with the skill's Blender
parallax invariant (0.14 / max(abs(view.z), 0.35), scaling before offset).
"""
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
source = (root / '.agents/skills/RuiC-card-skill/assets/web-template/app.js').read_text(encoding='utf8')
names = ['vertex', 'common', 'frontFragment', 'edgeFragment', 'backFragment']
shaders = []
for name in names:
    match = re.search(r'const ' + name + r'\s*=\s*(common\s*\+\s*)?`(.*?)`;', source, re.S)
    body = match.group(2)
    if name == 'common':
        body = body.replace('max(abs(uView.z), .4) * depth * .10', 'max(abs(uView.z), .35) * depth * .14')
    if name == 'frontFragment':
        body = body.replace('((parallax(uv,uDepth)-.5)*uScale/uFit+.5)', '(parallax((uv-.5)*uScale/uFit+.5,uDepth))')
    shaders.append('const ' + name + ' = ' + ('common + ' if match.group(1) else '') + '/* glsl */ `' + body + '`;')

header = '''import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { WUXING_LABEL, type CharacterDef, type HoloMode } from '../data/schema.ts';

export const CARD_H = 3.6;
export const CARD_ASPECT = 2 / 3;
export const CARD_W = CARD_H * CARD_ASPECT;

export interface CardVisual {
  group: THREE.Group;
  readonly holoMode: HoloMode;
  setTilt(nx: number, ny: number): void;
  setFlip(t: number): void;
  setReveal(t: number): void;
  setGlow(v: number): void;
  setShimmer(v: number): void;
  setBase(pose: { x: number; y: number; z: number; scale?: number; rotY?: number }): void;
  update(dt: number, time: number): void;
  dispose(): void;
}

/** Official RuiC GLSL, rebuilt from its Blender material graph.
 * glTF carries the real beveled mesh and material roles, not the shader graph.
 * Text/frame has fixed UVs; subject and background have signed view parallax.
 */
'''
runtime = '''
type CardConfig = {
  parameters?: { foil?: number; subjectScale?: number; subjectDepth?: number; backgroundDepth?: number; effectsDepth?: number };
  safeArea?: { scale?: number; offset?: [number, number] };
};
const textureLoader = new THREE.TextureLoader();
const textures = new Map<string, Promise<THREE.Texture>>();
const configs = new Map<string, Promise<CardConfig>>();
let model: Promise<THREE.Group> | undefined;
const MODEL_URL = '/art/layers/card.glb';
function loadTexture(url: string): Promise<THREE.Texture> {
  let pending = textures.get(url);
  if (!pending) {
    pending = textureLoader.loadAsync(url).then((texture) => {
      // Official shader handles sRGB conversion explicitly.
      texture.colorSpace = THREE.NoColorSpace;
      texture.anisotropy = 4;
      return texture;
    });
    textures.set(url, pending);
  }
  return pending;
}
function loadConfig(id: string): Promise<CardConfig> {
  let pending = configs.get(id);
  if (!pending) {
    pending = fetch(`/art/layers/${id}/card-config.json`).then((response) => {
      if (!response.ok) throw new Error(`Card configuration ${id}: HTTP ${response.status}`);
      return response.json() as Promise<CardConfig>;
    });
    configs.set(id, pending);
  }
  return pending;
}
function loadModel(): Promise<THREE.Group> {
  model ??= new GLTFLoader().loadAsync(MODEL_URL).then((gltf) => gltf.scene);
  return model;
}
function solidTexture(r: number, g: number, b: number, a: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array([r,g,b,a]),1,1);
  texture.needsUpdate = true;
  return texture;
}
function backTexture(def: CharacterDef): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 1536;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#17101d'; ctx.fillRect(0,0,1024,1536);
  ctx.strokeStyle = def.accent; ctx.lineWidth = 5;
  ctx.strokeRect(56,56,912,1424); ctx.lineWidth = 2; ctx.strokeRect(74,74,876,1388);
  ctx.textAlign = 'center'; ctx.fillStyle = '#e6cc96';
  ctx.font = '500 330px KaiTi, serif'; ctx.fillText('娘',512,840);
  ctx.font = '64px KaiTi, serif'; ctx.fillText('Celestial Heroes',512,1020);
  ctx.font = '32px sans-serif'; ctx.fillText(`${def.rarity} · ${WUXING_LABEL[def.wuxing]}`,512,1130);
  ctx.font = '26px sans-serif'; ctx.fillText(`No.${String(def.number).padStart(3,'0')} / 108`,512,1400);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

export function createCard(def: CharacterDef): CardVisual {
  const group = new THREE.Group();
  group.name = `RuiC card · ${def.id}`;
  group.userData.card = { id: def.id, ready: false, model: MODEL_URL, error: null };
  const back = backTexture(def);
  const empty = solidTexture(0,0,0,0);
  const white = solidTexture(255,255,255,255);
  const uniforms = {
    tSubject: { value: empty as THREE.Texture }, tBackground: { value: white as THREE.Texture },
    tText: { value: empty as THREE.Texture }, tLine: { value: white as THREE.Texture },
    tEffects: { value: empty as THREE.Texture }, tBack: { value: back },
    uTime: { value: 0 }, uView: { value: new THREE.Vector3(0,0,1) },
    uFit: { value: new THREE.Vector2(1,1) }, uFoil: { value: 0 },
    uScale: { value: 1 }, uDepth: { value: .4 }, uBgDepth: { value: -.25 },
    uSafeScale: { value: 1 }, uSafeOffset: { value: new THREE.Vector2() },
    uFxDepth: { value: .5 }, uHasFx: { value: 0 }, uHasLine: { value: 1 },
    uFinish: { value: def.card.holo === 'none' ? 2 : def.card.holo === 'gold' ? 3 : 0 },
    uRelief: { value: 0 },
  };
  const shader = (fragmentShader: string) => new THREE.ShaderMaterial({
    uniforms, vertexShader: vertex, fragmentShader, side: THREE.FrontSide, toneMapped: false,
  });
  const materials: Record<string, THREE.Material> = {
    web_front: shader(frontFragment), web_edge: shader(edgeFragment), web_back: shader(backFragment),
    web_gold: new THREE.MeshBasicMaterial({ color: '#c9a24a', toneMapped: false }),
  };
  const inverse = new THREE.Matrix4();
  let disposed = false, targetX = 0, targetY = 0, tiltX = 0, tiltY = 0;
  let reveal = 1, flip = 0, glow = 0, shimmer = 0, foil = .62;
  let baseY = 0, baseScale = 1, baseRotY = 0;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  Promise.all([loadModel(), loadConfig(def.id), ...['subject','background','text','lineart'].map((name) =>
    loadTexture(`/art/layers/${def.id}/${name}.png`))]).then(([template, config, subject, background, text, line]) => {
    if (disposed) return;
    const cfg = config as CardConfig;
    const p = cfg.parameters || {};
    foil = p.foil ?? .62;
    uniforms.uScale.value = p.subjectScale ?? 1;
    uniforms.uDepth.value = p.subjectDepth ?? .4;
    uniforms.uBgDepth.value = p.backgroundDepth ?? -.25;
    uniforms.uSafeScale.value = cfg.safeArea?.scale ?? 1;
    const offset = cfg.safeArea?.offset ?? [0,0];
    uniforms.uSafeOffset.value.set(offset[0],1-uniforms.uSafeScale.value-offset[1]);
    uniforms.tSubject.value = subject as THREE.Texture;
    uniforms.tBackground.value = background as THREE.Texture;
    uniforms.tText.value = text as THREE.Texture;
    uniforms.tLine.value = line as THREE.Texture;
    const geometry = (template as THREE.Group).clone(true);
    let faces = 0;
    geometry.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const source = object.material as THREE.Material;
      if (source.name === 'web_front') faces++;
      object.material = materials[source.name] ?? materials.web_edge!;
      // Export's mesh local frame has X=90 degrees. Derive view in the card's
      // canonical root frame, so local Y remains vertical after glTF Y-up export.
      object.onBeforeRender = (_renderer, _scene, camera) => {
        camera.getWorldPosition(uniforms.uView.value);
        uniforms.uView.value.applyMatrix4(inverse.copy(group.matrixWorld).invert()).normalize();
      };
    });
    if (!faces) throw new Error('Official GLB is missing web_front geometry');
    const bounds = new THREE.Box3().setFromObject(geometry);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const scale = CARD_H / size.y;
    geometry.scale.setScalar(scale);
    geometry.position.copy(center).multiplyScalar(-scale);
    group.add(geometry);
    group.userData.card.ready = true;
    group.userData.card.uniforms = uniforms;
  }).catch((error: unknown) => {
    if (disposed) return;
    group.userData.card.error = String(error);
    console.error(`RuiC card ${def.id} failed to load`, error);
  });

  return {
    group, holoMode: def.card.holo,
    setTilt(nx,ny) { targetX = THREE.MathUtils.clamp(nx,-1,1); targetY = THREE.MathUtils.clamp(ny,-1,1); },
    setFlip(t) { flip = THREE.MathUtils.clamp(t,0,1); },
    setReveal(t) { reveal = THREE.MathUtils.clamp(t,0,1); },
    setGlow(v) { glow = THREE.MathUtils.clamp(v,0,1); },
    setShimmer(v) { shimmer = THREE.MathUtils.clamp(v,0,1); },
    setBase(pose) {
      group.position.set(pose.x,pose.y,pose.z);
      baseY = pose.y; baseScale = pose.scale ?? 1; baseRotY = pose.rotY ?? 0;
      group.scale.setScalar(baseScale); group.rotation.y = baseRotY;
    },
    update(dt,time) {
      const ease = reducedMotion.matches ? 1 : 1-Math.exp(-dt*9);
      tiltX += (targetX-tiltX)*ease; tiltY += (targetY-tiltY)*ease;
      const e = 1-Math.pow(1-reveal,3);
      group.rotation.x = tiltY*.29 + (1-e)*.35;
      group.rotation.y = baseRotY+tiltX*.45+(1-e)*-Math.PI*.85+flip*Math.PI;
      group.position.y = baseY+(1-e)*-1.4;
      group.scale.setScalar(baseScale*(.55+e*.45+glow*.035));
      // Spectrum/sweep phase comes only from uView. Time is used exclusively
      // for sparse microflakes, respecting the reduced-motion preference.
      uniforms.uTime.value = reducedMotion.matches ? 0 : time;
      uniforms.uFoil.value = def.card.holo === 'none' ? 0 : foil*(.85+.15*shimmer+.12*glow)*e;
    },
    dispose() {
      disposed = true;
      for (const material of Object.values(materials)) material.dispose();
      back.dispose(); empty.dispose(); white.dispose(); group.clear();
      // Model geometry and loaded layer textures are immutable shared caches.
    },
  };
}

export function cardDescriptor(def: CharacterDef): Record<string,unknown> {
  return {
    id: def.id, number: def.number, name: def.name, rarity: def.rarity, holo: def.card.holo,
    model: MODEL_URL, source: 'RuiC-card-skill / Blender exported geometry',
    config: `/art/layers/${def.id}/card-config.json`,
    layers: [
      { name: 'background', depth: -.25, url: `/art/layers/${def.id}/background.png` },
      { name: 'subject', depth: .4, url: `/art/layers/${def.id}/subject.png` },
      { name: 'lineart', depth: .4, url: `/art/layers/${def.id}/lineart.png` },
      { name: 'text-and-frame', depth: 0, url: `/art/layers/${def.id}/text.png` },
      { name: 'foil', source: 'official RuiC view-dependent GLSL' },
    ],
  };
}
'''
(root / 'src/runtime/CardFactory.ts').write_text(header + '\n\n'.join(shaders) + runtime, encoding='utf8')
print('Imported official shader source and stable CardVisual adapter')
