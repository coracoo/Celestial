import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SkillAim } from '../src/runtime/SkillAim.ts';
import { StrikeView } from '../src/runtime/StrikeView.ts';
import type { StrikePreview } from '../src/sim/types.ts';
import * as THREE from 'three';

test('only the selected ready skill can be confirmed by its matching key', () => {
  const aim = new SkillAim();
  assert.equal(aim.begin(0, true), true);
  assert.equal(aim.begin(1, false), false);
  assert.equal(aim.selected, 0);
  aim.begin(1, true);
  assert.equal(aim.confirm(0), null);
  assert.equal(aim.selected, 1);
  assert.equal(aim.confirm(1), 1);
  assert.equal(aim.confirm(1), null);
});

test('cancel never confirms and reselection cannot refresh the real-time slowdown budget', () => {
  const aim = new SkillAim();
  aim.syncClock(0, true);
  aim.begin(0, true);
  assert.equal(aim.advance(2), .4);
  aim.syncClock(2, true);
  assert.equal(aim.cancel(), true);
  assert.equal(aim.confirm(), null);
  assert.equal(aim.advance(5), 5);
  aim.syncClock(7, true);
  aim.begin(2, true);
  assert.equal(aim.advance(1), .2);
  aim.syncClock(8, true);
  assert.equal(aim.selected, 2, 'budget expiry preserves preview without releasing');
  assert.equal(aim.advance(1), 1);
  aim.cancel();
  aim.begin(0, true);
  assert.equal(aim.advance(1), 1);
  aim.newBall();
  aim.syncClock(8, true);
  assert.equal(aim.selected, null);
  aim.begin(0, true);
  assert.equal(aim.advance(1), .2);
});

test('aim rotates a full circle independently from launcher angle limits', () => {
  const aim = new SkillAim();
  aim.begin(0, true);
  assert.equal(aim.angleDeg, 90);
  aim.pointAt(0, 0, 0, -5);
  assert.equal(aim.angleDeg, 270);
  aim.rotate(180);
  assert.equal(aim.angleDeg, 90);
  aim.pointAt(0, 0, 0, 0);
  assert.equal(aim.angleDeg, 90);
  aim.cancel();
  aim.begin(1, true);
  assert.equal(aim.angleDeg, 90);
});

test('slowdown accrues one unchanged physics step per five real fixed ticks', () => {
  const aim = new SkillAim();
  aim.syncClock(0, true);
  aim.begin(0, true);
  const dt = 1 / 120;
  let accumulator = 0;
  let steps = 0;
  for (let i = 0; i < 360; i++) {
    accumulator += aim.advance(dt);
    if (accumulator + 1e-9 >= dt) { accumulator = Math.max(0, accumulator - dt); steps++; }
    aim.syncClock((i + 1) * dt, true);
  }
  assert.equal(steps, 72);
  assert.ok(aim.slowRemaining < 1e-9);
  assert.ok(Math.abs(aim.advance(dt) - dt) < 1e-9);
});

test('three wall-clock seconds exhaust slowdown even when low FPS drops fixed ticks', () => {
  for (const fps of [5, 10]) {
    const aim = new SkillAim();
    aim.syncClock(0, true);
    aim.begin(0, true);
    for (let frame = 1; frame <= fps * 3; frame++) {
      aim.syncClock(frame / fps, true);
      const remaining = aim.slowRemaining;
      for (let tick = 0; tick < 8; tick++) aim.advance(1 / 120);
      assert.equal(aim.slowRemaining, remaining, 'fixed ticks never double-charge wall-clock budget');
      if (frame < fps * 3) assert.equal(aim.advance(1 / 120), (1 / 120) * .2);
    }
    assert.ok(aim.slowRemaining < 1e-9, `${fps} FPS must use only three real seconds`);
    assert.equal(aim.advance(1 / 120), 1 / 120);
    assert.equal(aim.selected, 0, 'clock expiry must preserve selection');
  }
});

test('wall clock excludes idle and canceled time but preserves budget across switches', () => {
  const aim = new SkillAim();
  aim.syncClock(0, false);
  aim.begin(0, true);
  aim.syncClock(10, false);
  assert.equal(aim.slowRemaining, 3);
  aim.syncClock(10, true);
  aim.syncClock(11, true);
  aim.cancel();
  aim.syncClock(20, true);
  aim.begin(1, true);
  aim.syncClock(21, true);
  aim.begin(2, true);
  aim.syncClock(22, true);
  assert.equal(aim.slowRemaining, 0);
  aim.newBall();
  aim.syncClock(22, false);
  aim.begin(0, true);
  aim.syncClock(30, false);
  assert.equal(aim.slowRemaining, 3);
});

test('strike view reuses preview geometry and disposes short-lived impact materials', () => {
  const preview: StrikePreview = {
    charId: 'test', name: 'test', color: '#aaddff', x: 1, y: 2, angleDeg: 135,
    primitives: [{ shape: 'line', x: 1, y: 2, halfLength: 9, halfWidth: .65, angleDeg: 45 }],
    targets: [{ pegId: 'enemy', x: 2, y: 3, r: .5, hp: 80, damage: 80, kill: true }],
    totalDamage: 80, totalKills: 1,
  };
  const view = new StrikeView();
  view.show(preview);
  const shape = view.group.children[0]!.children[0]!;
  assert.deepEqual(shape.position.toArray(), [1, 2, .9]);
  assert.deepEqual(shape.scale.toArray(), [9, .65, 1]);
  assert.equal(shape.rotation.z, Math.PI / 4);
  view.show({ ...preview, primitives: [{ ...preview.primitives[0]!, x: 3 }] });
  assert.equal(view.group.children[0]!.children[0], shape);
  assert.equal(shape.position.x, 3);
  view.strike(preview);
  assert.equal(view.group.children.length, 2);
  let disposed = 0;
  const materials = new Set<THREE.Material>();
  view.group.children[1]!.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
      const material = object.material as THREE.Material;
      if (!materials.has(material)) material.addEventListener('dispose', () => disposed++);
      materials.add(material);
    }
  });
  view.update(.37);
  assert.equal(view.group.children.length, 1);
  assert.equal(disposed, materials.size);
  view.show(null);
  assert.equal(view.group.children[0]!.visible, false);
  view.dispose();
  assert.equal(view.group.children.length, 0);
});
