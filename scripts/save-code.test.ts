/**
 * 存档码（导出/导入）的判据。
 *
 * 这套东西存在的理由是「进度只在 localStorage 里，换设备就没了」。所以判据不
 * 是「能导出能导入」——那太容易过——而是**坏码不许弄坏存档**。手工复制一段
 * 文本，截断、漏字符、粘到聊天软件里被加了零宽字符，都是日常。
 *
 * 反向对照：每一条「拒绝」都必须证明**当前存档原封不动**。只断言返回 false
 * 的话，一个「先清空再报错」的实现照样全绿，而那正是最糟的失败模式。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* localStorage 桩。Profile 在模块加载时不读它，构造时才读，所以装在 import 前。 */
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store][i] ?? null,
  get length() { return store.size; },
} as unknown as Storage;

const { Profile } = await import('../src/game/Profile.ts');
const KEY = 'celestial.save.v3';
/** 解构 import 只带回了值，类型要重新取一次。 */
type ProfileInstance = InstanceType<typeof Profile>;

function fresh(): ProfileInstance {
  store.clear();
  return new Profile(['wusong', 'linchong', 'luzhishen']);
}

test('导出再导入，进度一字不差', () => {
  const p = fresh();
  p.grant({ silver: 777, stones: 8888, shards: 99 });
  p.recordClear('stage_03');
  p.selectStage('stage_03', ['stage_01', 'stage_02', 'stage_03']);
  const code = p.exportCode();
  assert.match(code, /^NS1\./, '必须带版本前缀');
  assert.ok(!/[^A-Za-z0-9._-]/.test(code), `存档码必须能安全复制，实际含非法字符：${code}`);

  store.clear();
  const q = new Profile();
  const r = q.importCode(code);
  assert.equal(r.ok, true, r.error ?? '导入失败但没给原因');
  const a = p.snapshot(), b = q.snapshot();
  assert.deepEqual(b, a);
  assert.equal(q.stones, 8888 + 600, 'grant 是加法：默认 600 + 8888');
  assert.equal(q.clearedCount(), 1);
});

test('码被截断时拒绝，且当前存档一动不动', () => {
  const p = fresh();
  p.grant({ silver: 5, stones: 600, shards: 0 });
  const good = p.exportCode();

  for (const cut of [good.length - 1, Math.floor(good.length / 2), 20]) {
    const r = p.importCode(good.slice(0, cut));
    assert.equal(r.ok, false, `截到 ${cut} 字符还接受了`);
    assert.ok(r.error, '失败必须带原因');
    assert.equal(p.stones, 600 + 600, `截断导入后存档被改了（第 ${cut} 字符）`);
    assert.equal(p.silver, 5);
  }
});

test('单字符篡改会被校验和抓住', () => {
  const p = fresh();
  const code = p.exportCode();
  const body = code.slice(0, -1);
  // 换个合法的 base64url 字符，结构和长度都还像那么回事
  const flipped = body.slice(0, -1) + (body.endsWith('A') ? 'B' : 'A') + body.slice(-1);
  assert.equal(flipped.length, code.length, '反向对照：长度必须一样，否则不是这条判据在起作用');
  const r = p.importCode(flipped);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /校验/);
});

test('版本号不认识就拒绝，不去猜', () => {
  const p = fresh();
  const code = p.exportCode();
  const r = p.importCode('NS9' + code.slice(3));
  assert.equal(r.ok, false);
  assert.match(String(r.error), /版本/);
});

test('缺字段 / 类型不对 / owned 是 null 一律拒绝', () => {
  const p = fresh();
  const good = p.exportCode();
  const payload = good.split('.')[1]!;
  const sum = good.split('.')[2]!;
  // 造几段「结构看着像但内容坏掉」的 JSON，重新算校验和，绕开校验这一层，
  // 好让判据说清「形状不对也过不去」——否则永远只是在校验和上打转。
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fnv = (t: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  };
  const wrap = (obj: unknown) => {
    const j = JSON.stringify(obj);
    return `NS1.${b64(j)}.${fnv(j)}`;
  };
  const base = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'),
    'base64').toString('utf8')) as Record<string, unknown>;

  const bad = [
    ['owned 是 null', { ...base, owned: null }],
    ['owned 是数组', { ...base, owned: [] }],
    ['副本数是小数', { ...base, owned: { wusong: 1.5 } }],
    ['副本数是负数', { ...base, owned: { wusong: -3 } }],
    ['team 里混了数字', { ...base, team: ['wusong', 7] }],
    ['clearedStages 不是数组', { ...base, clearedStages: 'stage_01' }],
    ['整个是数组不是对象', [1, 2, 3]],
    ['是 null', null],
  ];
  for (const [why, obj] of bad) {
    const r = p.importCode(wrap(obj));
    assert.equal(r.ok, false, `${why} 竟然被接受了`);
    assert.equal(p.ownedCount('wusong'), 1, `${why} 被拒后存档却变了`);
  }
  assert.ok(good.length > 0 && sum.length === 8, '反向对照：原码本身应当是合法的');
});

test('队伍超过 3 人会被截到 3，不报错', () => {
  const p = fresh();
  const base = p.snapshot();
  p.importCode((() => {
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    let h = 0x811c9dc5;
    const j = JSON.stringify({ ...base, team: ['a', 'b', 'c', 'd', 'e'] });
    for (let i = 0; i < j.length; i++) { h ^= j.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return `NS1.${b64(j)}.${h.toString(16).padStart(8, '0')}`;
  })());
  assert.equal(p.team.length, 3);
});

test('导入后真的落盘，刷新还在（不是只改了内存）', () => {
  const p = fresh();
  p.grant({ silver: 1, stones: 4242, shards: 0 });
  const code = p.exportCode();
  store.clear();
  new Profile().importCode(code);
  assert.ok(store.has(KEY), '导入后 localStorage 里必须有东西');
  const reread = new Profile();
  assert.equal(reread.stones, 4242 + 600, 'grant 是加法：默认 600 + 4242');
});
