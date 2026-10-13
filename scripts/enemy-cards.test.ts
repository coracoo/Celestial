import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { ENEMY_CARD_LIST, enemyCardFor } from '../src/data/EnemyCards.ts';
import { EnemyCardDeck } from '../src/runtime/EnemyCardView.ts';

test('五行敌人卡面逐一对应真实WebP，独立于武将抽卡名单', async () => {
  const roster = JSON.parse(await readFile(new URL('../public/data/roster.json', import.meta.url), 'utf8')) as string[];
  assert.equal(ENEMY_CARD_LIST.length, 30);
  assert.equal(new Set(ENEMY_CARD_LIST.map((c) => c.id)).size, 30);
  for (const card of ENEMY_CARD_LIST) {
    assert.equal(roster.includes(card.id), false);
    assert.equal(enemyCardFor(card.wuxing, card.id).id, card.id);
    const buf = await readFile(new URL(`../public/${card.art}`, import.meta.url));
    // Runtime uses compressed previews; full generated cutouts stay in cards/opponents/sources.
    // scripts/audit_opponents.py separately verifies dimensions and real alpha on all layers.
    assert.equal(buf.subarray(0, 4).toString(), 'RIFF');
    assert.equal(buf.subarray(8, 12).toString(), 'WEBP');
    assert.ok(card.art.endsWith('.webp'), card.art);
    assert.ok(buf.byteLength < 400 * 1024, `${card.art} 仍有 ${buf.byteLength} 字节，疑似未压缩`);
  }
});

test('非法五行不得让取卡函数返回 undefined', () => {
  // 返回类型是 EnemyCardDef 而非 | undefined，所有调用点都直接 .name / .art。
  // 真防线在 loadBundle（会拒掉非法的 wuxing），但这里仍要求显式兜底，
  // 免得哪天校验被绕过就变成「战斗进行中抛异常」。
  for (const bad of [undefined, 'air', 'WIND', '']) {
    const card = enemyCardFor(bad as never);
    assert.ok(card, `非法五行 ${String(bad)} 不该返回空`);
    assert.equal(card.id, 'metal_sentry', '未知五行应回落到 metal');
  }
});

test('小怪卡片保留固定碰撞圈，血量/隐身变化不改变几何或共享纹理', () => {
  const texture = new THREE.Texture();
  const deck = new EnemyCardDeck(() => texture);
  const a = deck.create(.55, 'fire'), b = deck.create(.55, 'fire');
  const radius = a.hitRing.geometry.parameters.radius;
  const vertices = a.hitRing.geometry.getAttribute('position').count;
  a.setHp(.35); a.update(.016, .8, false);
  assert.equal(a.hitRing.geometry.parameters.radius, radius);
  assert.equal(a.hitRing.geometry.getAttribute('position').count, vertices);
  assert.equal(a.group.scale.x, 1);
  assert.equal(a.face.material.uniforms.tSubject.value, b.face.material.uniforms.tSubject.value);
  assert.notEqual(a.face.material, b.face.material, '单体受伤不能染暗同属性全队');
  assert.equal(a.hpFill.scale.x, .35);
  assert.equal(b.hpFill.scale.x, 1);
  a.update(.1, 0, true);
  assert.ok(a.face.material.opacity < 1);
  a.setHp(1); a.update(.1, 0, false);
  assert.equal(a.face.material.opacity, 1);
  assert.equal(a.hpFill.scale.x, 1);
  a.setAlive(false); assert.equal(a.group.visible, false);
  a.setAlive(true); assert.equal(a.group.visible, true);
  let disposed = 0; texture.addEventListener('dispose', () => disposed++);
  a.dispose(); b.dispose(); deck.dispose();
  assert.equal(disposed, 1, '每份共享资源只释放一次');
});

test('异步卡面加载在退出后释放纹理，不重新挂载销毁场景', () => {
  let loaded: ((texture: THREE.Texture) => void) | undefined;
  const texture = new THREE.Texture();
  let disposed = 0; texture.addEventListener('dispose', () => disposed++);
  const deck = new EnemyCardDeck((_path, onLoad) => { loaded = onLoad; return texture; });
  const card = deck.create(.95, 'metal');
  card.dispose(); deck.dispose();
  loaded?.(texture);
  assert.equal(disposed, 1);
});
