import type { CharacterDef, GameDataBundle, GachaDef, LinkDef, StageDef, StoryChapter, Wuxing } from './schema.ts';
import { WUXING_LABEL } from './schema.ts';

/** 合法的五行成员集合。数据里的 wuxing 字段是 string，类型系统管不住它。 */
const WUXING_SET = new Set<string>(Object.keys(WUXING_LABEL));

export type ReadJson = (path: string) => Promise<unknown>;

/**
 * 出战名单：决定加载哪些角色文件，顺序即图鉴与抽卡池的排列顺序。
 *
 * 为什么是一份 JSON 而不是数组常量：浏览器端是静态托管，**没法列目录**，
 * 所以「有哪些角色」这件事本身也必须是数据。加到第 108 将时只往这个文件里加一行，
 * 角色文件、连携、抽卡概率池自动跟着走，Runtime 一行都不用改。
 */
export const ROSTER_FILE = 'data/roster.json';

/**
 * 关卡名单，理由和 roster.json 完全一样。
 *
 * 顺序即战役推进顺序，前一关通关才解锁后一关（见 Profile.stageUnlocked）。
 * 剧情线走《水浒传》正传：鲁提辖拳打镇关西 → 林教头风雪山神庙 → 智取生辰纲 →
 * 三打祝家庄 → 智取大名府 → 浔阳楼题反诗 → 排座次 → 招安 → 征方腊。
 */
export const STAGE_FILE = 'data/stages.json';

/** 单个数据文件的读取超时（毫秒）。 */
const READ_TIMEOUT = 8000;

/** 同时在途的请求上限。 */
const READ_CONCURRENCY = 4;

/**
 * 浏览器端读取器：路径相对文档，兼容任意部署子路径。
 *
 * 带超时是有原因的：静态托管偶尔会把某几个并发连接卡住不返回（代理、连接池耗尽、
 * 弱网都见过）。没有超时时 `Promise.all` 会永远挂着，页面停在「正在铸造 Celestial 第一阵…」
 * 且**一行报错都没有**——玩家和排查的人都被骗。超时报出来的错误至少指名道姓。
 *
 * fetch 本身失败也必须包一层。裸的 `TypeError: Failed to fetch` 什么都不说：
 * 不知道是哪个文件、不知道是服务没起来还是断网还是连接被掐。
 * 实机真的撞到过一次——dev server 重启的间隙里打开页面，整局就死在
 * 「启动失败 TypeError: Failed to fetch」这一行上。
 */
export function createBrowserReader(): ReadJson {
  return async (path) => {
    const url = new URL(path, document.baseURI).href;
    const timer = new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error(`读不到（等了 ${READ_TIMEOUT / 1000} 秒没回应）`)), READ_TIMEOUT);
    });
    let res: Response;
    try {
      res = await Promise.race([fetch(url, { cache: 'no-cache' }), timer]);
    } catch (err) {
      throw new Error(`${path} — ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new Error(`${path} 返回了 HTTP ${res.status}`);
    return res.json();
  };
}

/**
 * 限流批量读取，保持结果顺序。
 *
 * 为什么不用 `Promise.all`：浏览器对同一 host 的 HTTP/1.1 并发连接数是 6，
 * 一次打 28 个文件（4 基础 + 12 关卡 + 12 武将）必然要排队，只要其中几个被卡住，
 * 后面整排都跟着停。分批跑虽然总时长略长，但每一批都有明确进度，
 * 也不会把连接池一次性占满。
 */
async function readAll(read: ReadJson, paths: string[]): Promise<unknown[]> {
  const out: unknown[] = new Array(paths.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= paths.length) return;
      out[i] = await read(paths[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, worker));
  return out;
}

export async function loadBundle(read: ReadJson): Promise<GameDataBundle> {
  const [roster, stageList, links, gacha] = await Promise.all([
    read(ROSTER_FILE),
    read(STAGE_FILE),
    read('data/links.json'),
    read('data/gacha.json'),
  ]);

  const stageIds = stageList as string[];
  const stages = (await readAll(read, stageIds.map((f) => `data/stages/${f}.json`))) as StageDef[];
  const badStages = stageIds.filter((f, i) => stages[i]?.id !== f);
  if (badStages.length) throw new Error(`stages.json 列了但文件对不上：${badStages.join(', ')}`);

  const files = roster as string[];
  const chars = (await readAll(read, files.map((f) => `data/characters/${f}.json`))) as CharacterDef[];
  // 名单与文件对不上必须当场炸：少一个 id 意味着这名将从抽卡池与图鉴里静默消失，
  // 玩家看到的是「这将没抽到」，排查起来比启动报错难一百倍。
  const missing = files.filter((f) => !chars.some((c) => c && c.id === f));
  if (missing.length) throw new Error(`roster.json 列了但文件读不到：${missing.join(', ')}`);
  if (chars.length !== files.length) throw new Error(`角色文件数与 roster.json 不符：${chars.length} vs ${files.length}`);

  const ids = new Set(chars.map((c) => c.id));
  const dup = chars.map((c) => c.id).filter((id, i, a) => a.indexOf(id) !== i);
  if (dup.length) throw new Error(`角色 id 重复：${dup.join(', ')}`);

  // 连携只保留「成员都在角色表里」的组：玩家没抽到的人不该出现在连携列表
  const linkList = (links as LinkDef[]).filter((l) => l.members.every((m) => ids.has(m)));

  // 每关的敌人钉必须把五行铺满：面板要按五行分组算克制倍率，
  // 某一关只放一种五行的话，那个面板就只剩一行，玩家永远看不到四档判定。
  for (const st of stages) {
    const enemies = st.board.pegFormations.filter((f) => f.kind === 'enemy');
    // 成员资格也要断言：下面只查了「铺没铺满四种」，没查「是不是合法的五行」。
    // 拼错一个值，wux.size 照样 ≥4 能过校验，然后一路带到战斗里炸在
    // enemyCardFor(...).name —— 加载期一句话能说清的问题，变成战斗中抛异常。
    const bad = enemies.map((f) => f.wuxing).filter((w) => !WUXING_SET.has(w as Wuxing));
    if (bad.length) throw new Error(`${st.id} 的敌人钉五行非法：${[...new Set(bad)].join(', ')}`);
    const wux = new Set(enemies.map((f) => f.wuxing));
    if (st.id !== 'stage_01' && enemies.length && wux.size < 4) {
      throw new Error(`${st.id} 的敌人钉只覆盖了 ${[...wux].join(',')}，不足四种五行`);
    }
  }

  // 剧情章节：每关都得有一章，而且章里的角色必须真的在 roster 里。
  // 两条都当场炸——剧情里点开一张不存在的角色卡，比没有剧情更难排查。
  const story = ((await readAll(read, ['data/story.json'])) as StoryChapter[])[0];
  if (!Array.isArray(story) || !story.length) throw new Error('story.json 缺失或为空');
  const stageIdSet = new Set(stages.map((s) => s.id));
  const orphanChapters = story.filter((c) => !stageIdSet.has(c.stageId)).map((c) => c.stageId);
  if (orphanChapters.length) throw new Error(`story.json 里有对不上关卡的章节：${orphanChapters.join(', ')}`);
  const noChapter = stages.filter((s) => !story.some((c) => c.stageId === s.id)).map((s) => s.id);
  if (noChapter.length) throw new Error(`这些关卡没有剧情章节：${noChapter.join(', ')}`);
  const badCast = story.flatMap((c) => c.cast).filter((id) => !ids.has(id));
  if (badCast.length) throw new Error(`剧情章节引用了不存在的角色：${[...new Set(badCast)].join(', ')}`);

  return {
    characters: chars,
    links: linkList,
    stages,
    gacha: gacha as GachaDef,
    story,
  };
}
