import { Rng } from '../core/Rng.ts';
import type { CharacterDef, GachaDef, Rarity } from '../data/schema.ts';

/**
 * 存档键。改版本号 = 旧存档作废、按 DEFAULT_SAVE + seedOwned 重发。
 *
 * v2：v1 是「三卡测试武将」时代的存档，里面 owned 只有 3 个人。
 * 角色扩到 12 张之后继续读它，新玩家进来图鉴里 9 张全是剪影，
 * 看着像没做完而不是像没抽。垂直切片阶段直接作废重来，比写迁移划算。
 *
 * v3：加战役进度 `clearedStages` / `currentStage`。
 * v2 里只有 `clears` 一个总数——12 关上线后它既不能决定「哪一关解锁了」，
 * 也不能在关卡选择屏上标进度，得从零重记一次。
 */
const KEY = 'celestial.save.v3';

export interface SaveData {
  stones: number;
  silver: number;
  shards: number;
  owned: Record<string, number>;
  team: string[];
  pity: number;
  pulls: number;
  clears: number;
  bestScore: number;
  tutorialSeen: boolean;
  /** 已通关的关卡 id（按 stages.json 的 id，不是序号） */
  clearedStages: string[];
  /** 当前选中的关卡 id */
  currentStage: string;
}

const DEFAULT_SAVE: SaveData = {
  stones: 600,
  silver: 0,
  shards: 0,
  owned: {},
  team: [],
  pity: 0,
  pulls: 0,
  clears: 0,
  bestScore: 0,
  tutorialSeen: false,
  clearedStages: [],
  currentStage: '',
};

export interface PullResult {
  def: CharacterDef;
  isNew: boolean;
  rarity: Rarity;
  upgraded: boolean;
}

const RARITY_ORDER: Rarity[] = ['UR', 'SSR', 'SR', 'R'];

/** 抽卡 / 图鉴 / 队伍 / 资源。localStorage 存档，量化后端接入时只替换读写实现。 */
export class Profile {
  private data: SaveData;

  constructor(seedOwned: string[] = []) {
    let loaded: Partial<SaveData> = {};
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) loaded = JSON.parse(raw) as Partial<SaveData>;
    } catch {
      loaded = {};
    }
    this.data = { ...DEFAULT_SAVE, ...loaded, owned: { ...loaded.owned } };
    this.data.team = Array.isArray(this.data.team) ? this.data.team : [];
    this.data.clearedStages = Array.isArray(this.data.clearedStages) ? this.data.clearedStages : [];
    if (seedOwned.length && Object.keys(this.data.owned).length === 0) {
      for (const id of seedOwned) this.data.owned[id] = 1;
      this.data.team = seedOwned.slice(0, 3);
      // 发完种子卡必须立刻落盘。以前这里只改内存，于是**只逛不抽**的新档
      // 从来没往 localStorage 里写过任何东西——刷新、换个标签页打开、
      // 或者换一个浏览器档案，三张起手卡就凭空消失，而界面上看不出
      // 「这只是个内存默认值」。下面那段迁移分支的 persist() 只在
      // team 恰好等于某串旧值时才走到，盖不住这条路。
      this.persist();
    }
    // 仅迁移从未抽卡/通关的旧演示初始队伍，保留收藏、资源与玩家自选队伍。
    const starter = ['wusong', 'linchong', 'luzhishen'];
    if (this.data.clears === 0 && this.data.pulls === 0 &&
      this.data.team.join(',') === 'songjiang,wuyong,linchong' &&
      starter.every((id) => this.ownedCount(id) > 0)) {
      this.data.team = starter;
      this.persist();
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* 隐私模式下忽略写入失败 */
    }
  }

  get stones(): number {
    return this.data.stones;
  }
  get silver(): number {
    return this.data.silver;
  }
  get shards(): number {
    return this.data.shards;
  }
  get pity(): number {
    return this.data.pity;
  }
  get pulls(): number {
    return this.data.pulls;
  }
  get clears(): number {
    return this.data.clears;
  }
  get bestScore(): number {
    return this.data.bestScore;
  }
  get tutorialSeen(): boolean {
    return this.data.tutorialSeen;
  }
  get team(): string[] {
    return this.data.team;
  }

  markTutorialSeen(): void {
    this.data.tutorialSeen = true;
    this.persist();
  }

  ownedCount(id: string): number {
    return this.data.owned[id] ?? 0;
  }

  ownedList(): string[] {
    return Object.keys(this.data.owned).filter((k) => this.data.owned[k] > 0);
  }

  setTeam(ids: string[]): void {
    this.data.team = ids.slice(0, 3);
    this.persist();
  }

  /* ------------------------------------------------ 分解 / 灵宝兑换 */

  /** 碎一张这种稀有度的卡值多少灵宝。没配 melt 就返回 0（功能未开）。 */
  meltValue(rarity: string, gacha: GachaDef): number {
    return gacha.melt?.shardsByRarity[rarity] ?? 0;
  }

  /**
   * 分解一张卡，换成灵宝。返回拿到的灵宝数，0 表示没碎成。
   * 保留至少一张：全碎掉之后这张卡就从图鉴消失了，
   * 玩家会发现自己把唯一的卡玩没了——这不是设计，是事故。
   */
  melt(id: string, def: CharacterDef, gacha: GachaDef): number {
    const each = this.meltValue(def.rarity, gacha);
    const have = this.ownedCount(id);
    if (each <= 0 || have <= 1) return 0;
    this.data.owned[id] = have - 1;
    this.data.shards += each;
    this.persist();
    return each;
  }

  /** 一键全碎：把这张卡多余的副本一次性换成灵宝。 */
  meltAll(id: string, def: CharacterDef, gacha: GachaDef): number {
    const each = this.meltValue(def.rarity, gacha);
    const spare = this.ownedCount(id) - 1;
    if (each <= 0 || spare <= 0) return 0;
    this.data.owned[id] = 1;
    this.data.shards += each * spare;
    this.persist();
    return each * spare;
  }

  /**
   * 花灵宝换一张指定稀有度的卡。
   * 刻意保持随机（不指定武将）——108 将规模下兑换必须还是随机，
   * 否则它就变成第二个抽卡，而不是重复卡的回收出口。
   */
  exchange(tierId: string, characters: CharacterDef[], gacha: GachaDef, rng: Rng): CharacterDef | null {
    const tier = gacha.melt?.exchange.find((e) => e.id === tierId);
    if (!tier || this.data.shards < tier.shards) return null;
    const pool = characters.filter((c) => tier.rarities.includes(c.rarity));
    if (!pool.length) return null;
    this.data.shards -= tier.shards;
    const got = pool[Math.floor(rng.next() * pool.length)]!;
    this.data.owned[got.id] = (this.data.owned[got.id] ?? 0) + 1;
    this.persist();
    return got;
  }

  grant(reward: { silver: number; stones: number; shards: number }): void {
    this.data.silver += reward.silver;
    this.data.stones += reward.stones;
    this.data.shards += reward.shards;
    this.persist();
  }

  recordRun(cleared: boolean, score: number): void {
    if (cleared) this.data.clears++;
    this.data.bestScore = Math.max(this.data.bestScore, score);
    this.persist();
  }

  /* ------------------------------------------------------------ 战役进度 */

  /**
   * 某一关是否已解锁：第一关永远开着，之后每关都要前一关通关。
   *
   * 判据用**顺序位置**而不是「通关数 ≥ 序号」：通关数是累计的，
   * 玩家重打老关会把它加上去，用通关数判就会出现「跳关」。
   */
  stageUnlocked(index: number, stageIds: string[]): boolean {
    if (index <= 0) return true;
    const prev = stageIds[index - 1];
    return prev !== undefined && this.data.clearedStages.includes(prev);
  }

  isStageCleared(id: string): boolean {
    return this.data.clearedStages.includes(id);
  }

  clearedCount(): number {
    return this.data.clearedStages.length;
  }

  /** 当前该打的关：存档里的选择，没选过就是「第一个没通关的」 */
  resolveStage(stageIds: string[]): number {
    const cur = this.data.currentStage;
    const at = cur ? stageIds.indexOf(cur) : -1;
    if (at >= 0) return at;
    const first = stageIds.findIndex((id) => !this.data.clearedStages.includes(id));
    return first < 0 ? stageIds.length - 1 : first;
  }

  selectStage(id: string, stageIds: string[]): boolean {
    const at = stageIds.indexOf(id);
    if (at < 0 || !this.stageUnlocked(at, stageIds)) return false;
    this.data.currentStage = id;
    this.persist();
    return true;
  }

  /** 通关记录。重复通关不重复计入。 */
  recordClear(stageId: string): boolean {
    if (this.data.clearedStages.includes(stageId)) {
      this.persist();
      return false;
    }
    this.data.clearedStages.push(stageId);
    this.persist();
    return true;
  }

  canPull(gacha: GachaDef): boolean {
    return this.data.stones >= gacha.costStones;
  }

  /** 稀有度池当前只有三名测试武将，缺失稀有度会向下顺延，108 将接入后自动生效。 */
  pull(characters: CharacterDef[], gacha: GachaDef, rng: Rng): PullResult | null {
    if (!this.canPull(gacha)) return null;
    this.data.stones -= gacha.costStones;
    this.data.pulls++;
    this.data.pity++;

    const owned = new Set(Object.keys(this.data.owned));
    const hasNew = characters.some((c) => !owned.has(c.id));

    let rarity = this.rollRarity(gacha, rng);
    // 保底：连续未出 SSR 及以上时强制提升
    if (this.data.pity >= gacha.pity && !['SSR', 'UR'].includes(rarity)) {
      rarity = rng.chance(0.25) ? 'UR' : 'SSR';
    }

    let pool = characters.filter((c) => c.rarity === rarity);
    if (!pool.length) {
      for (const r of RARITY_ORDER) {
        const idx = RARITY_ORDER.indexOf(r);
        if (idx <= RARITY_ORDER.indexOf(rarity)) {
          const alt = characters.filter((c) => c.rarity === r);
          if (alt.length) {
            pool = alt;
            rarity = r;
            break;
          }
        }
      }
    }
    if (!pool.length) pool = characters;

    // 首抽必新：收藏驱动优先给没见过的
    if (gacha.firstOfKind && hasNew) {
      const fresh = pool.filter((c) => !owned.has(c.id));
      if (fresh.length) pool = fresh;
    }

    const def = rng.pick(pool);
    const isNew = !owned.has(def.id);
    if (isNew) {
      this.data.owned[def.id] = 1;
    } else {
      this.data.owned[def.id] = (this.data.owned[def.id] ?? 0) + 1;
    }
    if (def.rarity === 'SSR' || def.rarity === 'UR') this.data.pity = 0;
    this.persist();

    return { def, isNew, rarity: def.rarity, upgraded: !isNew };
  }

  private rollRarity(gacha: GachaDef, rng: Rng): Rarity {
    const r = rng.next();
    let acc = 0;
    for (const [rarity, rate] of Object.entries(gacha.rates) as [Rarity, number][]) {
      acc += rate;
      if (r < acc) return rarity;
    }
    return 'R';
  }

  reset(): void {
    this.data = { ...DEFAULT_SAVE, owned: {}, team: [], clearedStages: [], currentStage: '' };
    this.persist();
  }

  /* ------------------------------------------------------ 存档码（导入/导出） */

  /**
   * 为什么要这个：进度只存在 localStorage 里。换浏览器、换设备、清一次站点数据，
   * 几百抽的图鉴就没了，而且**没有任何找回途径**。接后端之前至少给玩家一条
   * 自己能操作的退路——一段可以复制走的文本，不依赖服务器、不依赖账号。
   *
   * 格式 `NS1.<base64url(json)>.<fnv1a(json)>`：
   *   - 版本前缀：以后改结构时旧码能被认出来而不是当垃圾解出来。
   *   - 校验和：存档码是手工复制的，截掉一截 / 少贴一个字符极其常见。
   *     没有校验的话，截断的 JSON 会解出半个对象，owned 变成 undefined，
   *     图鉴页当场炸。宁可明确说「码不完整」，也不要半份存档。
   */
  snapshot(): SaveData {
    return { ...this.data, owned: { ...this.data.owned },
             team: [...this.data.team], clearedStages: [...this.data.clearedStages] };
  }

  exportCode(): string {
    const json = JSON.stringify(this.snapshot());
    return `${SAVE_CODE_VERSION}.${toBase64Url(json)}.${fnv1a(json)}`;
  }

  /**
   * 导入一段存档码。**先验后写**：任何一步不对都返回失败且**不动**当前存档。
   * 半份存档比旧存档糟得多——旧存档至少还是能玩的。
   */
  importCode(code: string): { ok: boolean; error?: string; summary?: string } {
    const raw = code.trim().replace(/\s+/g, '');
    const parts = raw.split('.');
    if (parts.length !== 3) return { ok: false, error: '存档码格式不对（应为三段）' };
    const [version, payload, sum] = parts as [string, string, string];
    if (version !== SAVE_CODE_VERSION) {
      return { ok: false, error: `存档码版本是 ${version}，只认 ${SAVE_CODE_VERSION}` };
    }
    let json: string;
    try {
      json = fromBase64Url(payload);
    } catch {
      return { ok: false, error: '存档码不是有效的编码（多半是复制时少了字符）' };
    }
    if (fnv1a(json) !== sum) return { ok: false, error: '校验不过，存档码不完整或被改过' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { ok: false, error: '存档码内容不是合法 JSON' };
    }
    const clean = sanitizeSave(parsed);
    if (!clean) return { ok: false, error: '存档码里缺字段或类型不对' };

    this.data = clean;
    this.persist();
    return { ok: true, summary: `已导入：${Object.keys(clean.owned).length} 张卡 / ` +
                                 `${clean.clearedStages.length} 关通关 / ${clean.pulls} 抽` };
  }
}

const SAVE_CODE_VERSION = 'NS1';

/* ---------------------------------------------------------------- 编解码 */

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** FNV-1a 32 位。够用来抓复制粘贴事故，不需要密码学强度。 */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v);

/**
 * 把任意 JSON 收成合法 SaveData，**不合法就整体返回 null**。
 * 逐字段收而不是就地打补丁：半收进去的存档比没导进去更难查。
 */
function sanitizeSave(raw: unknown): SaveData | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  // Array.isArray 这条不能省：`typeof [] === 'object'` 且 `[] !== null`，
  // 所以只判 typeof 的话 owned 传进来一个空数组会被放行，Object.entries 得 {},
  // 收藏被**静默清空**——正好是这段注释最想避免的那种「半份存档」。
  if (typeof o.owned !== 'object' || o.owned === null || Array.isArray(o.owned)) return null;

  const owned: Record<string, number> = {};
  for (const [k, v] of Object.entries(o.owned as Record<string, unknown>)) {
    if (!isInt(v) || v < 0) return null;
    owned[k] = v;
  }
  const team = strArrayOrNull(o.team);
  const cleared = strArrayOrNull(o.clearedStages);
  // 缺这两个字段 → 当空；给了但类型不对 → **整份拒绝**。
  // 差别很要紧：悄悄重置成 [] 的话，玩家的队伍会随着一次坏导入消失，
  // 而他只会看到「导入成功了」。
  if (team === null || cleared === null) return null;
  const num = (v: unknown, fallback: number): number => (isInt(v) && v >= 0 ? v : fallback);

  return {
    stones: num(o.stones, DEFAULT_SAVE.stones),
    silver: num(o.silver, 0),
    shards: num(o.shards, 0),
    owned,
    team: team.slice(0, 3),
    pity: num(o.pity, 0),
    pulls: num(o.pulls, 0),
    clears: num(o.clears, 0),
    bestScore: num(o.bestScore, 0),
    tutorialSeen: o.tutorialSeen === true,
    clearedStages: cleared,
    currentStage: typeof o.currentStage === 'string' ? o.currentStage : '',
  };
}

/** 缺 → []（老存档没这两个字段是正常的）；在但类型不对 → null（整份拒绝）。 */
function strArrayOrNull(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  return v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}
