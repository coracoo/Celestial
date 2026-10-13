import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EnemyCardDeck, type EnemyCardVisual } from '../src/runtime/EnemyCardView.ts';

/** Only image I/O is substituted: geometry, materials and lifecycle use production code. */
function textureFixture() {
  const requests: {
    path: string;
    texture: THREE.Texture;
    loaded: (texture: THREE.Texture) => void;
    failed?: (error: unknown) => void;
    disposed: number;
  }[] = [];
  const deck = new EnemyCardDeck((path, loaded, failed?: (error: unknown) => void) => {
    const texture = new THREE.Texture();
    const request = { path, texture, loaded, failed, disposed: 0 };
    texture.addEventListener('dispose', () => request.disposed++);
    requests.push(request);
    return texture;
  });
  return { deck, requests };
}

function material(card: EnemyCardVisual): THREE.ShaderMaterial {
  assert.ok(card.face.material instanceof THREE.ShaderMaterial, 'enemy faces compose independent art layers');
  return card.face.material;
}

function renderView(card: EnemyCardVisual, camera: THREE.Camera): THREE.Vector3 {
  card.group.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  card.face.onBeforeRender({} as THREE.WebGLRenderer, new THREE.Scene(), camera,
    card.face.geometry, card.face.material, null as never);
  return (material(card).uniforms.uView!.value as THREE.Vector3).clone();
}

test('enemy layers load by identity URL, sharing one identity without collapsing its same-element neighbour', () => {
  const { deck, requests } = textureFixture();
  const a = deck.create(.55, 'metal', 'metal_sentry');
  assert.equal(requests.length, 4, 'subject, background, frame and the shared back plate must each load');
  const b = deck.create(.55, 'metal', 'metal_sentry');
  const c = deck.create(.55, 'metal', 'metal_swordswoman');
  assert.equal(requests.length, 5, 'each identity owns its portrait; same-element backgrounds, frames and the back plate are shared');
  assert.ok(requests.some((r) => r.path.includes('/metal_sentry/')));
  assert.ok(requests.some((r) => r.path.includes('/metal_swordswoman/')));
  for (const name of ['tSubject', 'tBackground', 'tFrame']) {
    assert.equal(material(a).uniforms[name]!.value, material(b).uniforms[name]!.value);
    if (name === 'tSubject') assert.notEqual(material(a).uniforms[name]!.value, material(c).uniforms[name]!.value);
    else assert.equal(material(a).uniforms[name]!.value, material(c).uniforms[name]!.value);
  }
  assert.equal(a.group.name, '金甲哨卫');
  assert.equal(c.group.name, '银刃游侠');
  assert.notEqual(a.face.material, b.face.material, 'damage uniforms belong to a single unit');
  for (const card of [a, b, c]) card.dispose();
  deck.dispose();
});

test('damage and ghosting affect one unit while collision geometry, restoration and opaque portraits remain intact', () => {
  const { deck } = textureFixture();
  const a = deck.create(.55, 'fire'), b = deck.create(.55, 'fire');
  const hpX = a.hpFill.position.x;
  const positions = a.hitRing.geometry.getAttribute('position').array.slice();
  assert.equal(material(a).transparent, false, 'portrait alpha cuts the subject, not the composed card');
  a.setHp(.35);
  a.update(.016, .8, false);
  assert.equal(a.hpFill.scale.x, .35);
  assert.ok(a.hpFill.position.x < hpX, 'HP remains left anchored');
  assert.notDeepEqual(material(a).uniforms.uTint!.value, material(b).uniforms.uTint!.value);
  assert.deepEqual(material(b).uniforms.uTint!.value, new THREE.Color(1, 1, 1));
  assert.deepEqual(a.hitRing.geometry.getAttribute('position').array, positions);
  assert.equal(a.hitRing.geometry.parameters.radius, .55);
  assert.equal(a.group.scale.x, 1);
  a.update(.1, 0, true);
  assert.equal(material(a).uniforms.uOpacity!.value, .25);
  assert.equal(material(a).transparent, true);
  a.setHp(0); assert.equal(a.hpFill.visible, false);
  a.setAlive(false); assert.equal(a.group.visible, false);
  a.setAlive(true); a.setHp(1); a.update(.1, 0, false);
  assert.equal(a.group.visible, true);
  assert.equal(a.hpFill.visible, true);
  assert.equal(a.hpFill.position.x, hpX);
  assert.equal(material(a).uniforms.uOpacity!.value, 1);
  assert.equal(material(a).transparent, false);
  assert.deepEqual(material(a).uniforms.uTint!.value, new THREE.Color(1, 1, 1));
  a.dispose(); b.dispose(); deck.dispose();
});

test('view-driven layers use card-local camera direction after world translation and rotation', () => {
  const { deck } = textureFixture();
  const card = deck.create(.55, 'wood');
  card.group.position.set(10, 20, 30);
  card.group.rotation.set(.2, -.5, .15);
  card.group.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera();
  for (const sign of [-1, 1]) {
    camera.position.copy(card.face.localToWorld(new THREE.Vector3(sign * 4, 2, 8)));
    const direction = renderView(card, camera);
    assert.ok(direction.distanceTo(new THREE.Vector3(sign * 4, 2, 8).normalize()) < 1e-6,
      'camera on the local right must remain positive X after transforming the card');
  }
  const before = (material(card).uniforms.uView!.value as THREE.Vector3).clone();
  card.update(500, 0, false);
  assert.deepEqual(material(card).uniforms.uView!.value, before, 'elapsed time must not cycle the foil or parallax');
  card.dispose(); deck.dispose();
});

test('orthographic viewing direction is constant when a card moves across the screen', () => {
  const { deck } = textureFixture();
  const card = deck.create(.55, 'earth');
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, .1, 100);
  camera.position.set(3, 5, 10); camera.lookAt(0, 0, 0);
  const left = renderView(card, camera);
  card.group.position.x = 8;
  assert.ok(renderView(card, camera).distanceTo(left) < 1e-6);
  card.dispose(); deck.dispose();
});

test('layer readiness and load errors are observable without reattaching a disposed card', () => {
  const { deck, requests } = textureFixture();
  const card = deck.create(.55, 'metal');
  assert.equal(card.group.userData.card?.ready, false);
  requests[0]!.loaded(requests[0]!.texture);
  requests[1]!.loaded(requests[1]!.texture);
  assert.equal(card.group.userData.card.ready, false);
  requests[2]!.failed?.(new Error('missing frame'));
  assert.match(String(card.group.userData.card.error), /frame/);
  const destroyedState = { ...card.group.userData.card };
  card.dispose();
  requests[2]!.loaded(requests[2]!.texture);
  assert.deepEqual(card.group.userData.card, destroyedState, 'late callbacks cannot change the disposed view');
  assert.equal(card.group.children.length, 0);
  deck.dispose();
});

test('shared layers are owned by the deck and released exactly once even when callbacks finish after exit', () => {
  const { deck, requests } = textureFixture();
  const a = deck.create(.55, 'water'), b = deck.create(.55, 'water');
  // Three layered front images plus the one shared back plate, each fetched
  // exactly once even though two cards asked for the same opponent.
  assert.equal(requests.length, 4);
  a.dispose(); b.dispose();
  assert.ok(requests.every((r) => r.disposed === 0), 'cards do not own shared layer images');
  deck.dispose(); deck.dispose();
  for (const request of requests) {
    request.loaded(request.texture);
    assert.equal(request.disposed, 1);
  }
  const late = new THREE.Texture();
  let lateDisposals = 0;
  late.addEventListener('dispose', () => lateDisposals++);
  requests[0]!.loaded(late); requests[0]!.loaded(late);
  assert.equal(lateDisposals, 1, 'a distinct late texture is also released once');
  assert.throws(() => deck.create(.55, 'water'), /disposed/);
});
