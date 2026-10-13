import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadBundle } from '../src/data/GameData.ts';
import { DialogueRun } from '../src/story/storyData.ts';
import { Profile } from '../src/game/Profile.ts';

const publicDir = join(import.meta.dirname, '../public');
const bundle = await loadBundle(async (p) => JSON.parse(await readFile(join(publicDir, p), 'utf8')));

test('每个战役关卡都可找到完整剧情和真实透明立绘', async () => {
  // 章节表走 public/data/story.json，由 loadBundle 读进 bundle.story。
  // 断言只表达真正的需求——**每个关卡都要有章节**（缺了就是新关静默没有剧情入口），
  // 而不是拿两边的 id 做双向深比较：那个写法下新增一关会同时让 stages.json 和
  // 章节表都「不完整」，报错信息指不出到底缺的是哪一边。孤儿章节由 loadBundle 拒掉。
  const noChapter = bundle.stages.filter((s) => !bundle.story.some((c) => c.stageId === s.id));
  assert.deepEqual(noChapter.map((s) => s.id), [], '这些关卡在 story.json 里没有对应章节');
  const ids = new Set(bundle.characters.map((c) => c.id));
  for (const chapter of bundle.story) {
    assert.ok(chapter.before.length >= 3, `${chapter.stageId}: 战前至少三句`);
    assert.ok(chapter.after.length >= 2, `${chapter.stageId}: 战后至少两句`);
    assert.ok(chapter.summary.length > 0);
    for (const id of chapter.cast) {
      assert.ok(ids.has(id), `不存在的角色 ${id}`);
      // 角色纹理合并成一张之后，public/art/layers/<id>/subject.png 不再发布，
// 运行时和这个断言都只看 subject-bleed.png（出血画布，1280x1920）。
// 这里要验的是「这个角色的图真的存在」，不是「存在哪一档」。
await access(join(publicDir, 'art/layers', id, 'subject-bleed.png'));
    }
    for (const line of [...chapter.before, ...chapter.after]) {
      assert.ok(line.text.trim().length > 0);
      assert.ok(line.speaker === 'narrator' || chapter.cast.includes(line.speaker), `${chapter.stageId}: 说话者应在场`);
    }
  }
});

test('逐句推进到末句后只进入一次战斗，随后跳过或推进不重复触发', () => {
  let battles = 0;
  const run = new DialogueRun([{ speaker: 'wusong', text: '一' }, { speaker: 'linchong', text: '二' }], () => battles++);
  assert.equal(run.current?.text, '一');
  run.advance();
  assert.equal(run.current?.text, '二');
  assert.equal(battles, 0);
  run.advance();
  run.skip();
  run.advance();
  assert.equal(battles, 1);
});

test('跳过战后对话只继续一次，取消战前对话不触发出战', () => {
  let continuations = 0;
  const lines = [{ speaker: 'songjiang', text: '归来' }];
  const after = new DialogueRun(lines, () => continuations++);
  after.skip();
  after.skip();
  after.advance();
  assert.equal(continuations, 1);
  const before = new DialogueRun(lines, () => continuations++);
  before.cancel();
  before.skip();
  before.advance();
  assert.equal(continuations, 1);
});

test('章节权限继承战役通关进度，对话重看不会发奖励或解锁后续关', () => {
  const profile = new Profile(['wusong', 'linchong', 'luzhishen']);
  const ids = bundle.stages.map((s) => s.id);
  assert.equal(profile.stageUnlocked(0, ids), true);
  assert.equal(profile.stageUnlocked(1, ids), false);
  profile.recordClear('stage_01');
  const stones = profile.stones;
  const clears = profile.clearedCount();
  const after = new DialogueRun(bundle.story[0]?.after ?? [], () => {});
  after.skip();
  assert.equal(profile.stageUnlocked(1, ids), true);
  assert.equal(profile.stageUnlocked(2, ids), false);
  assert.equal(profile.stones, stones);
  assert.equal(profile.clearedCount(), clears);
});
