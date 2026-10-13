import { COMBAT, PEG_LEGEND, SLOT_COLORS, ZONE_COLORS } from '../core/constants.ts';
import { figureUrl } from '../core/figureLayer.ts';
import { Rng } from '../core/Rng.ts';
import { WUXING_HEX, WUXING_LABEL, wuxingTier, PHYS_KEY_LABEL, DEPRIVATION_LABEL, type Wuxing, type CharacterDef, type EnemyRules, type GameDataBundle, type LinkDef, type StageDef } from '../data/schema.ts';
import { expandStage } from '../sim/board.ts';
import type { Profile } from '../game/Profile.ts';
import type { BallControlState, BattleSnapshot, StrikePreview } from '../sim/types.ts';
import { RARITY_COLOR, h, on } from './dom.ts';
import { ENEMY_CARD_LIST, type EnemyCardDef } from '../data/EnemyCards.ts';
import { BOSS_CARD_LIST, type BossCardDef } from '../data/BossCards.ts';
import { OpponentCardPreview } from './OpponentCardPreview.ts';
import { BossPortrait } from './BossPortrait.ts';
import './opponent-card.css';

export type ScreenName = 'title' | 'collection' | 'stages' | 'deploy' | 'battle' | 'result';

/** 0xRRGGBB → '#rrggbb'，说明条要吃 CSS 颜色 */
function hexOf(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

/**
 * 敌方名册：30 小怪 + 12 守将。
 *
 * 敌方没有稀有度，外框颜色直接用五行色（守将用金色），
 * 所以 `.tile` 只要注入 `--rar` 就能原样复用我方那套卡样式。
 */
type OpponentEntry = { kind: 'enemy'; def: EnemyCardDef } | { kind: 'boss'; def: BossCardDef };
const OPPONENTS: OpponentEntry[] = [
  ...ENEMY_CARD_LIST.map((def): OpponentEntry => ({ kind: 'enemy', def })),
  ...BOSS_CARD_LIST.map((def): OpponentEntry => ({ kind: 'boss', def })),
];
const opponentAccent = (entry: OpponentEntry): string =>
  entry.kind === 'enemy' ? WUXING_HEX[entry.def.wuxing] : '#e4b57d';
const opponentTag = (entry: OpponentEntry): string =>
  entry.kind === 'enemy' ? `${WUXING_LABEL[entry.def.wuxing]}行守卫` : entry.def.title;

export interface UiHooks {
  onStory(): void;
  onPull(): void;
  onDeploy(team: string[]): void;
  onStartBattle(): void;
  onQuitBattle(): void;
  onSkill(index: number): void;
  onSkillBegin(index: number): void;
  onSkillConfirm(index: number): void;
  onSkillCancel(): void;
  /**
   * 底部翻板按下 / 松开。
   *
   * 传 `down` 而不是「点一下」：板是**按住**弹起、松手回落，
   * 真弹球翻板就是这样。UI 只负责把指针事件翻译成这两个布尔值，
   * 不做任何节流或去抖——那属于物理层的连点保护。
   */
  onFlipper(side: 'left' | 'right', down: boolean): void;
  onLock(linkId: string): void;
  onFocus(id: string | null): void;
  /** 敌方大图：展示台摆一张，和点武将卡是同一条路。 */
  onFocusOpponent(def: { id: string; name: string; layers: { subject: string; background: string; frame: string } }, accent: string): void;
  onFlip(): void;
  onRetry(): void;
  onHome(): void;
  /** 屏幕切换完成：Runtime 据此重新计算 3D 安全取景区 */
  onScreenChange?(): void;
}

export class Ui {
  private readonly screens = new Map<ScreenName, HTMLElement>();
  private readonly flashEl: HTMLElement;
  private readonly floatsEl: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly rng: Rng;
  private readonly resourceEls: HTMLElement[] = [];

  // 战斗 HUD 缓存
  private bossFill!: HTMLElement;
  private bossGhost!: HTMLElement;
  private bossHp!: HTMLElement;
  private bossTop!: HTMLElement;
  private bossPhase!: HTMLElement;
  private bossName!: HTMLElement;
  private bossPortrait!: BossPortrait;
  private bossHudKey = '';
  /** 聚气条的变化档位。用来只在数字真的变了的那一帧写 DOM */
  private energyHudKey = '';
  /** 阶段刻度的容器：刻度位置随各关 Boss 的 phases 变，见 refreshBossPlate */
  private bossTicks!: HTMLElement;
  private skillEls: {
    root: HTMLElement; gauge: HTMLElement; skill: CharacterDef; index: number;
  }[] = [];
  private statEls: Record<string, HTMLElement> = {};
  /** 落槽说明条，见 buildBattle 里那段注释 */
  private slotLegend!: HTMLElement;
  /** 五行相性对照条，随球的五行实时重画 */
  private wuxingLegend!: HTMLElement;
  /** 上次画对照条时球是什么五行；变了才重画，别每帧重建 DOM */
  private wuxingBallKey = '';
  private buffWrap!: HTMLElement;
  private linkWrap!: HTMLElement;
  private linkEls = new Map<string, { root: HTMLElement; state: HTMLElement }>();
  private flipperBar!: HTMLElement;
  private chargeUi!: HTMLElement;
  private chargeFill!: HTMLElement;
  private chargeTxt!: HTMLElement;
  private skillAimHint!: HTMLElement;
  private skillAimText!: HTMLElement;
  private skillPointer: { id: number; index: number } | null = null;
  private skillPointerType = '';
  // 確変 HUD
  private feverBar!: HTMLElement;
  private feverFill!: HTMLElement;
  private feverRenda!: HTMLElement;
  private feverMult!: HTMLElement;

  // 图鉴 / 出征
  private collectionGrid!: HTMLElement;
  private collectionPity!: HTMLElement;
  private collectionPackBtn!: HTMLButtonElement;
  /**
   * 图鉴当前看哪一边。**只有名册数据变，DOM 骨架不变**：
   * 我方 36 张和敌方 42 位都渲染进同一个 `.cards` / `.tile`，
   * 所以两边共用同一套 CSS，不需要第二套布局。
   */
  private collectionSide: 'mine' | 'enemy' = 'mine';
  private collectionOpponentId = '';
  private opponentPreview: OpponentCardPreview | null = null;
  private deployGrid!: HTMLElement;
  private deployLinks!: HTMLElement;
  private deploySkills!: HTMLElement;
  private deployAttr!: HTMLElement;
  private deployStage!: HTMLElement;
  // 图鉴右侧控制条：文字详情不再常驻，3D 大图独占右侧，详情走弹窗
  private cardStageName!: HTMLElement;
  private cardStageHint!: HTMLElement;
  private cardDetailBtn!: HTMLButtonElement;
  private cardFlipBtn!: HTMLButtonElement;
  private cardModal!: HTMLElement;
  private cardModalBody!: HTMLElement;

  private resultTitle!: HTMLElement;
  private resultGrid!: HTMLElement;
  private resultReward!: HTMLElement;
  /** 胜利且下一阵已解锁时才亮出来的「下一阵」；战役打到底时自动隐藏 */
  private nextBtn!: HTMLButtonElement;
  private tutorialModal!: HTMLElement;
  private saveModal!: HTMLElement;

  private current: ScreenName = 'title';
  private deploySel: string[] = [];
  private focusId: string | null = null;

  constructor(
    root: HTMLElement,
    private readonly bundle: GameDataBundle,
    private readonly profile: Profile,
    private readonly hooks: UiHooks,
  ) {
    // 灵宝兑换要抽卡。这里自带一个 Rng，不复用 main 的那个——
    // 兑换和抽卡共用一个随机流会让「兑换结果」依赖玩家之前抽了几发，不可复现。
    this.rng = new Rng(0x9e3779b9);
    this.toastEl = h('div', { class: 'toast' });
    this.flashEl = h('div', { class: 'flash' });
    this.floatsEl = h('div', { class: 'floats' });
    root.append(this.buildTitle(), this.buildCollection(), this.buildStages(), this.buildDeploy(), this.buildBattle(), this.buildResult(), this.buildTutorial(), this.buildSave(), this.flashEl, this.floatsEl, this.toastEl);
    this.show('title');
    this.refreshResources();
  }

  /* ------------------------------------------------------------ 关卡 */

  /**
   * 当前选中的关卡。**所有面板都必须走这里**，不能再写 `stages[0]`。
   * 12 关上线之前有三处硬编码第一关（关卡铭板、属性克制面板、Boss 血条），
   * 不改的话玩家打到第十关，看到的 Boss 名字还是「镇山母虎」。
   */
  stageIds(): string[] {
    return this.bundle.stages.map((s) => s.id);
  }

  currentStageIndex(): number {
    return this.profile.resolveStage(this.stageIds());
  }

  currentStage(): StageDef {
    return this.bundle.stages[this.currentStageIndex()] ?? this.bundle.stages[0]!;
  }

  private refreshStages(): void {
    const ids = this.stageIds();
    const cur = this.currentStageIndex();
    const wrap = this.screens.get('stages')?.querySelector('.stage-list');
    if (!wrap) return;
    wrap.replaceChildren(
      ...this.bundle.stages.map((def, i) => {
        const unlocked = this.profile.stageUnlocked(i, ids);
        const cleared = this.profile.isStageCleared(def.id);
        const card = h(
          'button',
          {
            class: `stage-card${i === cur ? ' cur' : ''}${cleared ? ' cleared' : ''}${unlocked ? '' : ' locked'}`,
            'data-stage': def.id,
            type: 'button',
          },
          h('div', { class: 'stage-no' }, String(i + 1).padStart(2, '0')),
          h('div', { class: 'stage-main' },
            h('b', { class: 'stage-name' }, def.name),
            h('span', { class: 'stage-sub' }, def.subtitle),
            unlocked
              ? h('p', { class: 'story' }, def.story)
              : h('p', { class: 'story dim' }, '先通过上一阵才能进这里。'),
            h('div', { class: 'stage-tag' },
              h('i', {}, `${def.board.width} 宽盘`),
              h('i', {}, `${def.rules.balls} 发`),
              h('i', {}, `Boss ${def.boss.maxHp}`),
              h('i', {}, `重力 ${Math.abs(def.board.gravity)}`),
            ),
            unlocked
              ? h('p', { class: 'layout-note' }, `钉阵 · ${def.layoutNote}`)
              : '',
            h('p', { class: 'stage-state' },
              cleared ? '已通关' : unlocked ? '未通关' : '未解锁',
            ),
          ),
        );
        if (unlocked) {
          on(card, 'click', () => {
            if (this.profile.selectStage(def.id, ids)) {
              this.refreshStages();
              this.refreshDeploy();
              this.show('deploy');
            }
          });
        }
        return card;
      }),
    );
  }

  /** 关卡铭板：Boss 名字 + 阶段刻度。切关时必须跟着换，否则第十关的 HUD 还写着母虎。 */
  private refreshBossPlate(): void {
    const b = this.currentStage().boss;
    this.bossName.textContent = b.name;
    this.bossPortrait.setBoss(b.id);
    this.bossHudKey = '';
    // 血条从左往右缩，所以 at=0.66 的阶段刻度画在 66% 处
    this.bossTicks.replaceChildren(
      ...b.phases
        .filter((p) => p.at < 0.999)
        .map((p) => h('div', { class: 'boss-tick', style: `left:${(p.at * 100).toFixed(1)}%` })),
    );
  }

  private buildStages(): HTMLElement {
    const screen = h(
      'section',
      { class: 'screen', 'data-screen': 'stages' },
      h('div', { class: 'veil' }),
      h(
        'div',
        { class: 'sheet sheet--stages' },
        h('h2', {}, 'Celestial 十二阵'),
        h('p', { class: 'note' },
          '按《水浒传》正传推进：渭州 → 汴梁 → 东平府 → 济州 → 祝家庄 → 大名府 → 江州 → 沂岭 → 梁山 → 陈桥驿 → 昱岭关。' +
          '每阵换的是钉阵布局本身——盘宽、重力、球数、阵型全都不同。点一关进它的盘。'),
        h('div', { class: 'stage-list' }),
        h('div', { class: 'menu' },
          h('button', { class: 'btn', 'data-act': 'home' }, '返 回'),
        ),
      ),
    );
    /*
     * 屏级 click 监听。**这个按钮以前是死的**：`buildStages` 造了
     * `data-act="home"` 的「返 回」，但整屏没挂任何监听器 ——
     * 关卡卡片的 handler 是 `refreshStages` 逐张挂的，落到按钮上就没了。
     * 表现是「自由模式进得去、出不来」，得刷新页面才能回标题屏。
     *
     * `data-act="home"` 现在是**四块屏共用**的动作，所以这里的分派只认它；
     * 新的动作请在各自屏里显式加分支，别指望这一行兜底。
     */
    on(screen, 'click', (e) => {
      const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
      if (act === 'home') this.hooks.onHome();
    });
    // 必须登记进 screens：show() 只在 map 里遍历，
    // 漏了这一行的话点「出征」会把标题屏关掉却点亮不了任何屏 —— 整页黑屏。
    this.screens.set('stages', screen);
    return screen;
  }

  /* ------------------------------------------------------------ 构建 */

  private buildTitle(): HTMLElement {
    const res = h('div', { class: 'res' });
    this.resourceEls.push(res);
    const screen = h(
      'section',
      { class: 'screen s-title', 'data-screen': 'title' },
      h('div', { class: 'veil' }),
      h('h1', { class: 'brand' }, 'Celestial Heroes'),
      h('p', { class: 'brand-sub' }, '3D 柏青哥 · 娘化武将'),
      h('p', { class: 'brand-tag' }, '物理碰撞 × 三卡 Build × 技能连携'),
      h(
        'div',
        { class: 'menu' },
        // 战斗只有两个入口：剧情模式（章节地图选关 → 对白 → 选将 → 战斗）
        // 与自由模式（直接选关 → 选将 → 战斗）。
        // 原先这里还挂着一个「开始战斗」，它跳过选关和选将、直接拿当前配置开打，
        // 和下面两个入口做的是同一件事；而「出 征」这个标签更是错的——
        // 标题屏的这个按钮落点是 stages（选关），真正叫「出征」的是出征屏上那个
        // data-act="start" 的按钮（ui.ts:482）。同名不同事，删掉这一个。
        h('button', { class: 'btn btn--primary', 'data-act': 'story' }, '剧情模式 · 星阵归途'),
        h('button', { class: 'btn', 'data-act': 'stages' }, '自由模式 · 选 关'),
        // 抽将并进图鉴了：卡包入口在图鉴左上角，和 36 将名册同屏，不再单开一页。
        h('button', { class: 'btn', 'data-act': 'collection' }, '图 鉴 · 抽 将'),
        h('button', { class: 'btn btn--ghost', 'data-act': 'save' }, '存 档 · 导出导入'),
        h('button', { class: 'btn btn--ghost', 'data-act': 'tutorial' }, '玩法说明'),
      ),
      res,
      h('div', { class: 'corner-hint' }, '三将上阵 · 拉杆弹射 · 金环救球'),
    );
    on(screen, 'click', (e) => {
      const t = e.target as HTMLElement;
      const act = t.closest('[data-act]')?.getAttribute('data-act');
      if (!act) return;
      if (act === 'story') this.hooks.onStory();
      else if (act === 'stages') this.show('stages');
      else if (act === 'collection') {
        this.focusId = null;
        this.show('collection');
      } else if (act === 'tutorial') this.tutorialModal.classList.add('on');
      else if (act === 'save') {
        /*
         * 每次打开都重算一遍码，而不是建 modal 时算一次存着：
         * 玩家可能刚打完一局回来导出，拿到手的必须是**此刻**的进度。
         */
        const box = this.saveModal.querySelector('textarea');
        if (box) (box as HTMLTextAreaElement).value = this.profile.exportCode();
        const status = this.saveModal.querySelector('.save-status');
        if (status) {
          status.textContent = '';
          status.className = 'save-status';
        }
        this.saveModal.classList.add('on');
      }
    });
    this.screens.set('title', screen);
    return screen;
  }

  private buildCollection(): HTMLElement {
    this.collectionGrid = h('div', { class: 'cards' });

    // 右侧只有 3D 大图 + 一条控制条。文字详情全部搬进弹窗——
    // 常驻面板会把 3D 挤成一条窄缝，而卡牌本来就是这屏的主角。
    this.cardStageName = h('div', { class: 'card-stage-name' }, '未 选 择');
    this.cardStageHint = h('div', { class: 'card-stage-hint' }, '点击左侧武将，右侧出 3D 大图');
    this.cardDetailBtn = h('button', { class: 'stage-btn', 'data-act': 'detail', type: 'button', disabled: true }, '详 情');
    this.cardFlipBtn = h('button', { class: 'stage-btn', 'data-act': 'flip', type: 'button' }, '翻 面');
    const stageCtl = h(
      'div',
      { class: 'card-stage-ctl' },
      this.cardStageName,
      this.cardStageHint,
      h('div', { class: 'card-stage-btns' }, this.cardDetailBtn, this.cardFlipBtn),
    );

    this.cardModalBody = h('div', { class: 'card-modal-body' });
    this.cardModal = h(
      'div',
      { class: 'card-modal' },
      h(
        'div',
        { class: 'card-modal-box' },
        h('button', { class: 'card-modal-x', 'data-act': 'close-detail', type: 'button', 'aria-label': '关闭' }, '×'),
        this.cardModalBody,
        h('div', { class: 'card-modal-foot' },
          h('button', { class: 'btn btn--ghost', 'data-act': 'close-detail' }, '关 闭'),
        ),
      ),
    );

    const screen = h(
      'section',
      { class: 'screen', 'data-screen': 'collection' },
      h('div', { class: 'veil' }),
      h(
        'div',
        { class: 'sheet' },
        h('h2', {}, '图 鉴'),
        // 说明压到一行：面板高度要留给 6 行 × 6 列的卡面，说明多占一行
        // 就等于把第 6 行顶出视口。3D 展示的交互细节不再复述一遍。
        h('p', { class: 'note' }, '点卡出 3D 大图，点「详情」看完整立绘。未获得的压暗保留剪影。'),
        // 抽将整条并进这一屏：撕包入口 + 保底进度和「阵营切换」并排一行，
        // 不额外占高度 —— 面板多一行，第 6 行卡面就出视口了。
        // 阵营切换只是换 `.cards` 里的数据，左右两栏和 3D 台座都是同一套。
        h('div', { class: 'collection-tools' },
          this.collectionPackBtn = h('button', { class: 'btn btn--primary collection-pack', type: 'button', 'data-act': 'open-pack' }, `撕开卡包 · ${this.bundle.gacha.costStones} 灵石`),
          h('div', { class: 'collection-tags', role: 'tablist', 'aria-label': '图鉴阵营' },
            h('button', { class: 'collection-tag is-cur', type: 'button', role: 'tab', 'aria-selected': 'true',
              'data-side': 'mine', 'data-act': 'collection-side' }, `我 方 ${this.bundle.characters.length}`),
            h('button', { class: 'collection-tag', type: 'button', role: 'tab', 'aria-selected': 'false',
              'data-side': 'enemy', 'data-act': 'collection-side' }, `敌 方 ${OPPONENTS.length}`)),
          this.collectionPity = h('div', { class: 'collection-pity' })),
        this.collectionGrid,
        h('button', { class: 'btn btn--ghost', 'data-act': 'home' }, '返 回'),
      ),
      stageCtl,
      this.cardModal,
    );
    on(screen, 'click', (e) => {
      const el = e.target as HTMLElement;
      if (el.closest('[data-act="home"]')) {
        this.closeDetail();
        this.hooks.onHome();
        return;
      }
      const act = el.closest('[data-act]')?.getAttribute('data-act');
      if (act === 'open-pack') { this.hooks.onPull(); return; }
      if (act === 'collection-side') {
        this.closeDetail();
        this.setCollectionSide(el.closest('[data-side]')!.getAttribute('data-side') === 'enemy' ? 'enemy' : 'mine');
        return;
      }
      if (act === 'close-detail') {
        this.closeDetail();
        return;
      }
      if (act === 'detail') {
        this.openDetail();
        return;
      }
      if (act === 'flip') {
        this.hooks.onFlip?.();
        return;
      }
      if (act === 'melt-one' || act === 'melt-all') {
        this.doMelt(el.closest('[data-char]')!.getAttribute('data-char')!, act === 'melt-all');
        return;
      }
      if (act === 'exchange') {
        this.doExchange(el.closest('[data-tier]')!.getAttribute('data-tier')!);
        return;
      }
      const opponent = el.closest('[data-opponent]');
      if (opponent) this.focusOpponent(opponent.getAttribute('data-opponent')!);
      const card = el.closest('[data-char]');
      if (card) this.focusCard(card.getAttribute('data-char')!);
    });
    // 弹窗在图鉴屏外层，点空白处关闭
    on(this.cardModal, 'click', (e) => {
      if (e.target === this.cardModal) this.closeDetail();
    });
    this.screens.set('collection', screen);
    return screen;
  }

  /** 详情弹窗。开了才渲染，开之前不占任何排版。 */
  openDetail(): void {
    if (this.collectionSide === 'enemy') {
      if (!OPPONENTS.some((item) => item.def.id === this.collectionOpponentId)) {
        this.toast('先选一名敌将');
        return;
      }
      this.renderDetail();
      this.cardModal.classList.add('on');
      return;
    }
    const def = this.bundle.characters.find((c) => c.id === this.focusId);
    if (!def) {
      this.toast('先选一名武将');
      return;
    }
    this.renderDetail();
    this.cardModal.classList.add('on');
  }

  closeDetail(): void {
    this.cardModal.classList.remove('on');
  }

  /** 碎卡。成功后重画详情与资源栏；没碎成要给出原因，不能静默失败。 */
  private doMelt(id: string, all: boolean): void {
    const def = this.bundle.characters.find((c) => c.id === id);
    if (!def) return;
    const got = all ? this.profile.meltAll(id, def, this.bundle.gacha) : this.profile.melt(id, def, this.bundle.gacha);
    if (got <= 0) {
      this.toast(this.profile.ownedCount(id) <= 1 ? '最后一张不能碎' : '这张卡暂不支持分解');
      return;
    }
    this.toast(`${def.name} 碎成 ${got} 灵宝`);
    this.refreshResources();
    this.refreshCollection();
  }

  /** 灵宝兑换。抽到谁就是谁，不给选择——这是回收出口，不是第二个抽卡。 */
  private doExchange(tierId: string): void {
    const got = this.profile.exchange(tierId, this.bundle.characters, this.bundle.gacha, this.rng);
    if (!got) {
      const tier = this.bundle.gacha.melt?.exchange.find((e) => e.id === tierId);
      this.toast(tier && this.profile.shards < tier.shards ? '灵宝不够' : '暂无可兑换的武将');
      return;
    }
    this.focusId = got.id;
    this.hooks.onFocus(got.id);
    this.toast(`灵宝兑换：${got.name}`);
    this.refreshResources();
    this.refreshCollection();
  }

  private buildDeploy(): HTMLElement {
    this.deployGrid = h('div', { class: 'pick-row' });
    this.deployLinks = h('div', { class: 'link-list' });
    this.deploySkills = h('div', { class: 'skill-list' });
    this.deployAttr = h('div', { class: 'attr-list' });
    this.deployStage = h('div', { class: 'stage-plate' });
    const startBtn = h('button', { class: 'btn btn--primary', 'data-act': 'start' }, '出 征');
    /*
     * 左选人 / 右详情，两栏各自独立滚。
     *
     * 原来是一整列从上往下堆：36 张 150px 的选人卡 flex-wrap 铺在最上面，
     * 详情压在下面。名册一长那屏就全是选人卡，队伍技能、羁绊、克制全得往下翻，
     * 而选人和看详情这两件事本来就该**并排**——一边点人一边看技能变化。
     *
     * 两栏各自 overflow-y:auto，出征按钮留在最下面常驻：
     * 选人列表再长也不会把「出征」顶出屏幕。
     */
    const screen = h(
      'section',
      { class: 'screen', 'data-screen': 'deploy' },
      h('div', { class: 'veil' }),
      h(
        'div',
        { class: 'sheet sheet--deploy' },
        h('h2', {}, '出 征'),
        h('p', { class: 'note' }, '选择最多三位武将。组合决定技能与连携，第一位决定弹珠五行。命中五行靶点：相克 ×1.5、相生 ×1.2、同属 ×1、逆势 ×0.7。'),
        h(
          'div',
          { class: 'deploy-body' },
          h(
            'div',
            { class: 'deploy-pane deploy-pane--pick' },
            h('h3', {}, '选择武将'),
            this.deployGrid,
          ),
          h(
            'div',
            { class: 'deploy-pane deploy-pane--info' },
            this.deployStage,
            h(
              'div',
              { class: 'deploy-cols' },
              h('div', { class: 'deploy-col' }, h('h3', {}, '队伍技能'), this.deploySkills),
              h('div', { class: 'deploy-col' }, h('h3', {}, '羁绊技能'), this.deployLinks),
              h('div', { class: 'deploy-col' }, h('h3', {}, '属性克制'), this.deployAttr),
            ),
          ),
        ),
        h('div', { class: 'deploy-actions' }, startBtn,
          h('button', { class: 'btn', 'data-act': 'recommended' }, '推荐阵容'),
          h('button', { class: 'btn btn--ghost', 'data-act': 'home' }, '返 回')),
      ),
    );
    on(screen, 'click', (e) => {
      const el = e.target as HTMLElement;
      const act = el.closest('[data-act]')?.getAttribute('data-act');
      if (act === 'home') {
        this.hooks.onHome();
        return;
      }
      if (act === 'start') {
        if (this.deploySel.length === 0) return;
        this.profile.setTeam(this.deploySel);
        this.hooks.onStartBattle();
        return;
      }
      if (act === 'recommended') {
        const starter = ['wusong', 'linchong', 'luzhishen'];
        if (starter.some((id) => this.profile.ownedCount(id) === 0)) {
          this.toast('推荐阵容需要武松、林冲、鲁智深');
          return;
        }
        // **两处都要写。** 只写 profile.setTeam 的话，存档里队伍换成了推荐阵容，
        // 屏幕上高亮的还是玩家刚才手挑的那几张（`refreshDeploy` 只在
        // `deploySel` 为空时才从队伍回填，见 1007 行附近）——
        // 玩家看着 A 队的高亮、打着 B 队，这一屏直接骗人。
        this.deploySel = [...starter];
        this.profile.setTeam(starter);
        this.refreshDeploy();
        return;
      }
      const card = el.closest('[data-char]');
      if (card) this.toggleDeploy(card.getAttribute('data-char')!);
    });
    startBtn.dataset.ready = '1';
    this.screens.set('deploy', screen);
    return screen;
  }

  private buildBattle(): HTMLElement {
    this.bossFill = h('div', { class: 'boss-fill', style: 'width:100%' });
    this.bossGhost = h('div', { class: 'boss-ghost', style: 'width:100%' });
    this.bossHp = h('div', { class: 'boss-hp' });
    this.bossPhase = h('div', { class: 'boss-phase' });
    this.bossName = h('div', { class: 'boss-name' });
    this.bossTicks = h('div', { class: 'boss-ticks' });
    this.bossPortrait = new BossPortrait();
    const skillWrap = h('div', { class: 'p-skills' });
    this.statEls = {};
    this.linkWrap = h('div', { class: 'battle-links' });
    this.buffWrap = h('div', { class: 'buffs' });
    this.slotLegend = h('div', { class: 'slot-legend' });
    this.wuxingLegend = h('div', { class: 'wuxing-legend' });
    /*
     * 触屏翻板。键盘玩家用 Z / X，触屏玩家按这两块。
     *
     * 做成**常驻的横跨底部两块大按钮**而不是放进技能面板：
     * 翻板是每秒可能要按好几次的操作，藏进面板等于没有。
     * 而且它必须是「按住」语义——用 `pointerdown/up/cancel` 而不是 `click`，
     * 否则手机上每按一次要等抬起才生效，完全追不上球。
     */
    const mkFlipper = (side: 'left' | 'right', key: string, text: string): HTMLElement => {
      const b = h('button', {
        type: 'button', class: 'flip-btn', 'data-flip': side, 'aria-label': `${text}（${key}）`,
      }, h('span', { class: 'flip-key' }, key), h('span', { class: 'flip-name' }, text));
      const set = (down: boolean): void => {
        b.classList.toggle('down', down);
        this.hooks.onFlipper(side, down);
      };
      on(b, 'pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); set(true); });
      on(b, 'pointerup', () => set(false));
      on(b, 'pointercancel', () => set(false));
      on(b, 'pointerleave', () => { if (b.classList.contains('down')) set(false); });
      // 键盘焦点落到按钮上时按空格/回车也要能按住，否则纯键盘玩家多了一条盲路
      on(b, 'keydown', (e) => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); set(true); } });
      on(b, 'keyup', (e) => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); set(false); } });
      return b;
    };
    this.flipperBar = h('div', { class: 'flipper-bar' },
      mkFlipper('left', 'Z', '左 板'), mkFlipper('right', 'X', '右 板'));
    this.chargeFill = h('span');
    this.chargeTxt = h('div', { class: 'charge-txt' });
    this.chargeUi = h('div', { class: 'charge-ui' }, h('div', { class: 'charge-track' }, this.chargeFill), this.chargeTxt);
    this.skillAimText = h('span');
    const cancelSkill = h('button', { type: 'button', class: 'skill-cancel' }, '取消');
    this.skillAimHint = h('div', { class: 'skill-aim-hint', hidden: true }, this.skillAimText, cancelSkill);
    on(cancelSkill, 'click', () => this.hooks.onSkillCancel());
    this.feverFill = h('span');
    this.feverRenda = h('div', { class: 'fever-renda' });
    this.feverMult = h('div', { class: 'fever-mult' });
    this.feverBar = h('div', { class: 'fever-bar' },
      h('div', { class: 'fever-name' }, '确变'),
      h('div', { class: 'fever-meter' }, this.feverFill), this.feverRenda, this.feverMult);
    const stats = h('div', { class: 'p-stats panel' },
      this.buildStat('shots', '剩余球数'), this.buildStat('time', '本球倒计时'),
      h('div', { class: 'ball-state', role: 'status' }),
      this.buildStat('energy', '聚气'),
      this.buildStat('mult', '本球落槽倍率'),
      this.buildStat('next', '下颗球增益'), this.buildStat('bounces', '本球反弹'),
      this.buildStat('minions', '小怪清场'),
      this.buildStat('recovery', '恢复池'),
      h('div', { class: 'recovery-track', role: 'progressbar', 'aria-label': '恢复池修复能量', 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span')),
      h('p', { class: 'recovery-help' },
        // 这里不能再写「恢复五行点」：旧版满池会把已击坠的小怪整批复活，
        // 现在只修残血。通关是「Boss 倒且小怪清空」，能倒回清场进度的机制
        // 和通关条件直接矛盾（实测第 6/9/12 关 200 球 0% 胜就是这个）。
        '入池 +40 · 满池修复残血小怪（已击坠的不复活）'), this.buffWrap);
    const help = h('details', { class: 'battle-help' },
      h('summary', {}, '盘面 / 连携'),
      h('div', { class: 'help-body panel' }, this.slotLegend,
        h('div', { class: 'wuxing-legend-title' }, '五行相性'), this.wuxingLegend,
        h('div', { class: 'wuxing-legend-title' }, '连携组合 · 点击锁定或解锁'), this.linkWrap));
    const screen = h('div', { class: 'hud', 'data-screen': 'battle' },
      h('div', { class: 'battle-brand' }, 'Celestial Heroes'),
      h('div', { class: 'boss-bar' },
        (this.bossTop = h('div', { class: 'boss-top' }, this.bossName, this.bossHp)),
        h('div', { class: 'boss-track' }, this.bossGhost, this.bossFill, this.bossTicks), this.bossPhase),
      h('div', { class: 'hud-left panel' }, h('h2', { class: 'battle-heading' }, '武将技能'), skillWrap,
        h('p', { class: 'battle-link-note' }, '连携自动触发 · 说明中可锁定'), this.feverBar),
      h('div', { class: 'hud-right' }, this.bossPortrait.element, stats),
      help,
      h('div', { class: 'p-hint' }, '拉杆蓄力 · 松手弹射　|　Z / X 按住打底部翻板　|　聚气满自动三段连击'),
      h('button', { type: 'button', class: 'battle-exit' }, '退出'), this.chargeUi, this.skillAimHint, this.flipperBar);
    on(screen.querySelector('.battle-exit')! as HTMLElement, 'click', () => this.hooks.onQuitBattle());
    on(this.linkWrap, 'click', (e) => {
      const chip = (e.target as HTMLElement).closest('[data-link]');
      if (chip) this.hooks.onLock(chip.getAttribute('data-link')!);
    });
    on(skillWrap, 'pointerdown', (e) => {
      if (!e.isPrimary) return;
      this.skillPointerType = e.pointerType;
      if (e.pointerType === 'touch' || e.button !== 0 || this.skillPointer) return;
      const item = (e.target as HTMLElement).closest<HTMLElement>('[data-skill]');
      if (!item) return;
      // 被动技能的卡片是 <div>（没有 data-skill 的点击语义），这里再挡一次，
      // 免得将来有人给被动卡也补上 data-skill 就漏过这道闸。
      if (item.classList.contains('skill-passive')) return;
      this.skillPointer = { id: e.pointerId, index: Number(item.dataset.skill) };
      item.setPointerCapture(e.pointerId);
      this.hooks.onSkillBegin(this.skillPointer.index);
    });
    on(window, 'pointerup', (e) => {
      if (!this.skillPointer || this.skillPointer.id !== e.pointerId) return;
      const index = this.skillPointer.index;
      this.skillPointer = null;
      this.hooks.onSkillConfirm(index);
    });
    const clearSkillPointer = () => { this.skillPointer = null; this.hooks.onSkillCancel(); };
    on(window, 'pointercancel', clearSkillPointer);
    on(window, 'blur', clearSkillPointer);
    on(skillWrap, 'click', (e) => {
      // Mouse/pen already confirmed on pointerup. Touch and keyboard clicks select.
      if (e.detail > 0 && this.skillPointerType !== 'touch') return;
      const item = (e.target as HTMLElement).closest('[data-skill]');
      if (item) this.hooks.onSkill(Number(item.getAttribute('data-skill')));
    });
    this.screens.set('battle', screen);
    return screen;
  }

  private buildStat(key: string, label: string): HTMLElement {
    const b = h('b', {}, '0');
    this.statEls[key] = b;
    return h('div', { class: `stat stat--${key}` }, h('span', {}, label), b);
  }

  private buildResult(): HTMLElement {
    this.resultTitle = h('h1', { class: 'result-title' }, '');
    this.resultGrid = h('div', { class: 'result-grid' });
    this.resultReward = h('div', { class: 'reward' });
    const screen = h(
      'section',
      { class: 'screen s-result', 'data-screen': 'result' },
      h('div', { class: 'veil' }),
      this.resultTitle,
      this.resultGrid,
      this.resultReward,
      h(
        'div',
        { class: 'result-menu' },
        this.nextBtn = h('button', { class: 'btn btn--primary', 'data-act': 'next', style: 'display:none' }, '下 一 阵'),
        h('button', { class: 'btn', 'data-act': 'retry' }, '再 战'),
        h('button', { class: 'btn btn--ghost', 'data-act': 'home' }, '回 山 门'),
      ),
    );
    on(screen, 'click', (e) => {
      const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
      if (act === 'retry') this.hooks.onRetry();
      else if (act === 'next') this.goNextStage();
      else if (act === 'home') this.hooks.onHome();
    });
    this.screens.set('result', screen);
    return screen;
  }

  private buildSave(): HTMLElement {
    const out = h('textarea', { class: 'save-code', readonly: true, spellcheck: 'false' }) as HTMLTextAreaElement;
    const inp = h('textarea', { class: 'save-code', spellcheck: 'false', placeholder: '把存档码粘贴到这里' }) as HTMLTextAreaElement;
    const status = h('p', { class: 'save-status' });
    const copyBtn = h('button', { class: 'btn', 'data-act': 'copy' }, '复制存档码');
    const importBtn = h('button', { class: 'btn btn--primary', 'data-act': 'import' }, '导入并覆盖当前进度');

    this.saveModal = h(
      'div',
      { class: 'modal', 'data-modal': 'save' },
      h(
        'div',
        { class: 'modal-box' },
        h('h3', {}, '存 档'),
        h('p', {}, '进度只存在这台设备的浏览器里。换浏览器、清缓存、换设备之前，先把下面的码复制走。'),
        h('h4', {}, '导出'),
        out,
        h('div', { class: 'modal-foot modal-foot--tight' }, copyBtn),
        h('h4', {}, '导入'),
        inp,
        // 强调用真的 <b>：h() 的文本走 textContent，写 **会原样显示出来
        h('p', {}, '导入会', h('b', {}, '覆盖'), '这台设备上现在的全部进度。码被截断或改过会被挡下来，挡下来时当前存档原封不动。'),
        status,
        h(
          'div',
          { class: 'modal-foot' },
          importBtn,
          h('button', { class: 'btn', 'data-act': 'close' }, '关闭'),
        ),
      ),
    );
    on(this.saveModal, 'click', async (e) => {
      const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
      if (act === 'close') {
        this.saveModal.classList.remove('on');
        return;
      }
      if (act === 'copy') {
        out.value = this.profile.exportCode();
        out.select();
        /*
         * 剪贴板要走用户手势 + 安全上下文。本地是 http://127.0.0.1，算安全上下文，
         * 但浏览器策略、配对遥控的浏览器、无痕模式都可能直接拒绝。
         * 所以复制失败**不能只报错**：文本已经全选上了，手动 Ctrl+C 一样能拿走，
         * 存档码丢了没有第二次机会。
         */
        try {
          await navigator.clipboard.writeText(out.value);
          status.textContent = '已复制到剪贴板。';
          status.className = 'save-status save-status--ok';
        } catch {
          status.textContent = '浏览器不给复制权限，文本已全选，直接按 Ctrl+C / ⌘C。';
          status.className = 'save-status save-status--warn';
        }
        return;
      }
      if (act === 'import') {
        const r = this.profile.importCode(inp.value);
        if (!r.ok) {
          status.textContent = `导入失败：${r.error ?? '存档码无效'}`;
          status.className = 'save-status save-status--bad';
          return;
        }
        // 进度整个换掉了：顶栏资源、图鉴、抽卡进度、关卡星数都得按新存档重画
        this.refreshResources();
        this.refreshStages();
        this.refreshCollection();
        inp.value = '';
        status.textContent = r.summary ?? '已导入。';
        status.className = 'save-status save-status--ok';
        this.toast('存档已导入');
      }
    });
    return this.saveModal;
  }

  private buildTutorial(): HTMLElement {
    this.tutorialModal = h(
      'div',
      { class: 'modal', 'data-modal': 'tutorial' },
      h(
        'div',
        { class: 'modal-box' },
        h('h3', {}, '三步上手'),
        h('h4', {}, '① 拉杆 · 蓄力 · 松手'),
        h('p', {}, '球停在右下角弹射道的道底。按住左键（或空格）拉杆蓄力，松手把球弹上去——球会沿球道一路爬到顶部和盘面的交汇处，在那里按蓄力大小折向左上方飞进钉阵。拉得越满，仰角越平、飞得越深。中央「破绽」槽扣 Boss 血；撞敌人也能造成伤害。'),
        h('h4', {}, '② 球在盘上时瞄准救球'),
        h('p', {}, '首发不瞄准，落点只由蓄力决定。球落到盘上滚起来之后才需要瞄准：球慢下来亮起金环时，移动鼠标选方向，按住可以保留救球机会，松手从球当前位置再次击射。发射与救球都消耗 1 发。倒计时归零会按最近的槽自动结算，救球不会重置计时。'),
        h('h4', {}, '③ 技能蓄满，按 1 / 2 / 3'),
        h('p', {}, '武松、林冲、鲁智深分别用碰撞、穿过枪阵、强力撞击蓄技能。左侧技能条满时亮起，点击卡片或按对应数字释放。'),
        h('p', {}, '这三将的双卡连携是「景阳枪魂」「倒拔垂杨」「花和尚破阵」；三条技能蓄满且能量达到 60，自动触发「倒拔擎天柱」。点击连携条可锁定，留给三将同满。'),
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn', 'data-act': 'close' }, '明白了')),
      ),
    );
    on(this.tutorialModal, 'click', (e) => {
      if ((e.target as HTMLElement).closest('[data-act="close"]')) {
        this.tutorialModal.classList.remove('on');
        this.profile.markTutorialSeen();
      }
    });
    return this.tutorialModal;
  }

  /* ------------------------------------------------------------ 屏幕 */

  show(name: ScreenName): void {
    if (this.current === 'battle' && name !== 'battle') this.bossPortrait.reset();
    this.current = name;
    for (const [key, el] of this.screens) el.classList.toggle('on', key === name);
    if (name === 'collection') this.refreshCollection();
    if (name === 'stages') this.refreshStages();
    if (name === 'deploy') this.refreshDeploy();
    if (name === 'battle') this.refreshBossPlate();
    if (name === 'title') this.refreshResources();
    this.hooks.onScreenChange?.();
  }

  get screen(): ScreenName {
    return this.current;
  }

  /**
   * 当前屏幕上没有被 UI 面板遮挡的 3D 可视区域（CSS 像素）。
   * 图鉴的 3D 卡牌据此取景。右侧已经没有常驻面板了，
   * 所以这里只剩左侧 .sheet 在压边——3D 大图独占右边那一大片。
   */
  safeRectFor3D(): { x: number; y: number; w: number; h: number } {
    const full = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    const active = this.screens.get(this.current);
    if (!active || this.current === 'title' || this.current === 'battle') return full;
    if (full.w <= 800 && this.current === 'collection') {
      const panel = active.querySelector<HTMLElement>('.sheet')?.getBoundingClientRect();
      const y = (panel?.bottom ?? full.h * 0.48) + 10;
      return { x: 12, y, w: full.w - 24, h: Math.max(150, full.h - y - 88) };
    }

    const panels = [...active.querySelectorAll<HTMLElement>('.sheet')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (panels.length === 0) return full;

    let left = 0;
    let right = full.w;
    for (const el of panels) {
      const r = el.getBoundingClientRect();
      // 贴左的面板压左边距，贴右的面板压右边距
      if (r.left <= full.w * 0.25) left = Math.max(left, r.right);
      else right = Math.min(right, r.left);
    }
    const pad = 24;
    // 图鉴底部那条控制条浮在 3D 区里，取景要给它让出高度，不然卡牌下缘压着按钮
    const bottom = this.current === 'collection' ? 108 : pad;
    const x = Math.min(full.w - 1, left + pad);
    const w = Math.max(120, right - pad - x);
    return { x, y: pad, w, h: Math.max(160, full.h - pad - bottom) };
  }

  get inBattle(): boolean {
    return this.current === 'battle';
  }

  get focusedCardId(): string | null {
    return this.focusId;
  }

  private refreshResources(): void {
    const p = this.profile;
    for (const el of this.resourceEls) {
      el.replaceChildren(
        chip('#ffd76a', '灵石', p.stones),
        chip('#c9d6f5', '银两', p.silver),
        chip('#b184ff', '灵宝', p.shards),
        chip('#7f8db0', '已通关', p.clears),
      );
    }
  }

  /** 顶部轻提示。碎卡/兑换这类操作必须给回执，不能静默改存档。 */
  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('on');
    window.clearTimeout(Number(this.toastEl.dataset.timer ?? 0));
    this.toastEl.dataset.timer = String(
      window.setTimeout(() => this.toastEl.classList.remove('on'), 1700),
    );
  }

  /* ------------------------------------------------------------ 抽卡 */

  canPull(): boolean {
    return this.profile.canPull(this.bundle.gacha);
  }

  pullCost(): number {
    return this.bundle.gacha.costStones;
  }

  /* ------------------------------------------------------------ 图鉴 */

/**
   * 切换图鉴阵营。**只换 `.cards` 里的数据，DOM 骨架一个字都不改**——
   * 同一个 `.cards` / `.tile` / `.tile-art` / `.tile-foot`，
   * 所以敌方 42 位天然继承我方 36 张的全部样式和左栏宽度。
   * 之前那版把敌方另起一屏浮层、另写 190 行 CSS 复刻这套卡，
   * 等于把同一件事实现两遍，也是我这两轮返工的根源。
   */
  setCollectionSide(side: 'mine' | 'enemy'): void {
    if (this.collectionSide === side) return;
    this.collectionSide = side;
    this.opponentPreview?.dispose();
    this.opponentPreview = null;
    this.closeDetail();
    for (const el of this.screens.get('collection')?.querySelectorAll<HTMLElement>('[data-side]') ?? []) {
      const on = el.getAttribute('data-side') === side;
      el.classList.toggle('is-cur', on);
      el.setAttribute('aria-selected', String(on));
    }
    this.refreshCollection();
  }

  /** 敌方名册：渲染进和 36 张武将完全相同的 `.cards`。 */
  private renderEnemyCollection(): void {
    this.collectionGrid.replaceChildren(
      ...OPPONENTS.map((entry, i) => {
        const accent = opponentAccent(entry);
        return h(
          'button',
          {
            class: 'tile tile--opponent',
            'data-opponent': entry.def.id,
            type: 'button',
            title: `${entry.def.name} · ${opponentTag(entry)}`,
            // 敌方没有稀有度牌面：`--rar` 兜底底色，`--c` 给描边和姓名。
            style: `--c:${accent};--rar:${accent}`,
          },
          // 没有 art/plates/<RARITY>.png，`--rar` 那一色就是底板。
          h('div', { class: 'tile-plate' }),
          h('img', { class: 'tile-art', src: entry.def.art, alt: entry.def.name, loading: 'lazy', decoding: 'async' }),
          h('div', { class: 'tile-foot' },
            h('b', {}, entry.def.name),
            h('span', { class: 'tile-meta' }, opponentTag(entry)),
          ),
          h('div', { class: 'tile-dup' }, String(i + 1).padStart(2, '0')),
        );
      }),
    );
    this.focusOpponent(this.collectionOpponentId || OPPONENTS[0]!.def.id);
  }

  /** 点敌方卡：和 `focusCard` 一样只更新选中态 + 右侧台座文字。 */
  private focusOpponent(id: string): void {
    const entry = OPPONENTS.find((item) => item.def.id === id);
    if (!entry) return;
    this.collectionOpponentId = id;
    for (const el of this.collectionGrid.querySelectorAll('[data-opponent]')) {
      el.classList.toggle('sel', el.getAttribute('data-opponent') === id);
    }
    const accent = opponentAccent(entry);
    this.hooks.onFocusOpponent(entry.def, accent);
    this.cardStageName.textContent = entry.def.name;
    this.cardStageName.style.color = accent;
    this.cardStageHint.textContent = `${opponentTag(entry)} · 兵 器 ${entry.def.weapon}`;
    this.cardDetailBtn.disabled = false;
  }

  private refreshCollection(): void {
    const owned = new Set(this.profile.ownedList());
    // 敌方名册：同一块 `.cards`，换数据源。选中态和右侧文字都交给 focusOpponent。
    if (this.collectionSide === 'enemy') {
      this.renderEnemyCollection();
      return;
    }
    // 36 张卡以后不再做「按稀有度给不同高度」的瀑布流。
    // 那个做法是为三张卡试出来的：等高排不出错落感，就靠高度制造。
    // 一排排下来，瀑布流的列序（先下后右）跟天罡座次完全对不上，
    // 而且定高 ≠ 卡面比例，object-fit: cover 会把脸裁掉。
    // 现在统一卡面比例 + 固定列数网格，座次按行读，稀有度交给外框颜色。
    //
    // 卡面结构（三层，从下往上）：
    //   tile-plate  稀有度底板（art/plates/<RARITY>.png），底下垫一色 --rar
    //   tile-art    立绘裁切（art/thumbs/，网格专用的小图；36 张全用大图会拖垮首屏）
    //   tile-foot   文字，**统一压在左上角**
    //
    // 底板用底色兜底是有原因的：plates/ 目前只出了 SSR 和 SR 两张，
    // R 和 UR 取不到图。如果只写 background-image，R/UR 的卡就是一张透明底，
    // 人物直接浮在页面背景上。--rar 由 RARITY_COLOR 注入，颜色仍然只有一处定义。
    this.collectionGrid.replaceChildren(
      ...this.bundle.characters.map((c) => {
        const has = owned.has(c.id);
        const n = this.profile.ownedCount(c.id);
        const tile = h(
          'button',
          {
            class: `tile tile--${c.rarity.toLowerCase()}${has ? '' : ' locked'}`,
            'data-char': c.id,
            type: 'button',
            title: `${c.name} · ${c.title} · ${c.rarity}`,
            style: `--c:${c.color};--rar:${RARITY_COLOR[c.rarity]}`,
          },
          h('div', { class: 'tile-plate', style: `background-image:url(art/plates/${c.rarity}.png)` }),
          h('img', { class: 'tile-art', src: `art/thumbs/${c.id}.webp`, alt: c.name, loading: 'lazy', decoding: 'async' }),
          h('div', { class: 'tile-foot' },
            h('b', {}, c.name),
            h('span', { class: 'tile-meta' }, `${c.rarity} · ${String(c.number).padStart(2, '0')}`),
          ),
          has && n > 1 ? h('div', { class: 'tile-dup' }, `×${n}`) : null,
          !has ? h('div', { class: 'tile-lock' }, '未 获 得') : null,
        );
        return tile;
      }),
    );
    this.refreshPackBar();

    if (this.focusId && owned.has(this.focusId)) {
      this.focusCard(this.focusId);
    } else {
      /*
       * 默认打开第一个已获得的武将。
       *
       * 原来这一屏进来右侧摆的是 3D 名册（`showRoster` 扇形摊开 3 张），
       * 底下写着「未 选 择」、详情按钮禁用——右侧看着有东西，其实什么都没选中，
       * 玩家第一眼分不清那三张卡是名册还是可选。空着也不对：整片黑更像出 bug。
       *
       * 所以直接选第一个已有的：右侧变成一张正经大图，详情可点，
       * 顺手就把「点卡出图 → 看详情」这条最基础的路径演示了一遍。
       * 一个都还没有时退回名册预览，并提示去撕卡包。
       */
      const firstOwned = this.bundle.characters.find((c) => owned.has(c.id));
      if (firstOwned) {
        this.focusCard(firstOwned.id);
      } else {
        this.focusId = null;
        this.hooks.onFocus(null);
        this.cardStageName.textContent = '尚 无 武 将';
        this.cardStageName.style.color = '';
        this.cardStageHint.textContent = '点「撕开卡包」开第一张';
        this.cardDetailBtn.disabled = true;
      }
    }
    this.renderDetail();
  }

  /** 撕包按钮 + 保底进度。都并排放在 `.collection-tools` 里，不额外占面板高度。 */
  private refreshPackBar(): void {
    const g = this.bundle.gacha;
    const p = this.profile;
    const affordable = this.canPull();
    this.collectionPackBtn.textContent = affordable
      ? `撕开卡包 · ${g.costStones} 灵石`
      : `灵石不足 · 还差 ${g.costStones - p.stones}`;
    this.collectionPackBtn.disabled = !affordable;
    this.collectionPity.replaceChildren(
      h('span', { class: 'collection-pity-txt' }, `保底 ${p.pity}/${g.pity}`),
      h('span', { class: 'collection-pity-bar' },
        h('i', { style: `width:${Math.min(100, (p.pity / g.pity) * 100)}%` })),
    );
  }

  focusCard(id: string): void {
    if (this.profile.ownedCount(id) <= 0) return;
    // 撕卡包抽到新武将也会走这里。若此时停在敌方名册，先切回我方，
    // 否则右侧摆着新武将、左侧还是敌人，两边对不上。
    if (this.collectionSide !== 'mine') this.setCollectionSide('mine');
    this.focusId = id;
    this.hooks.onFocus(id);
    for (const el of this.collectionGrid.querySelectorAll('[data-char]')) {
      el.classList.toggle('sel', el.getAttribute('data-char') === id);
    }
    const def = this.bundle.characters.find((c) => c.id === id);
    if (def) {
      this.cardStageName.textContent = `${def.name} · ${def.rarity}`;
      this.cardStageName.style.color = def.color;
    }
    this.cardStageHint.textContent = '鼠标移入触发闪卡光效 · 点大图翻面 · 看文字点「详情」';
    this.cardDetailBtn.disabled = false;
    // 换人就关掉弹窗，否则上面挂的还是上一个武将的立牌
    this.closeDetail();
  }

  private renderDetail(): void {
    // 敌方：我方那套弹窗照用，只是把完整立绘换成敌方分层卡。
    if (this.collectionSide === 'enemy') {
      const entry = OPPONENTS.find((item) => item.def.id === this.collectionOpponentId);
      if (!entry) return;
      const accent = opponentAccent(entry);
      this.opponentPreview?.dispose();
      this.opponentPreview = new OpponentCardPreview(entry.def, true);
      const index = OPPONENTS.indexOf(entry) + 1;
      this.cardModalBody.replaceChildren(
        this.opponentPreview.element,
        h('div', { class: 'card-modal-id' },
          h('h3', { style: `color:${accent}` }, entry.def.name),
          h('p', { class: 'note' }, `${opponentTag(entry)}｜兵 器 ${entry.def.weapon}｜敌阵录 ${String(index).padStart(2, '0')} — ${OPPONENTS.length}`),
          h('p', { class: 'card-modal-tag' }, `「${entry.def.description}」`),
          h('p', { class: 'note' }, '敌方角色不可抽取，不占武将收藏与出战位置。'),
        ),
      );
      return;
    }
    const def = this.bundle.characters.find((c) => c.id === this.focusId);
    if (!def) {
      this.cardModalBody.replaceChildren(
        h('h3', {}, '武 将'),
        h('p', { class: 'note' }, '先在左侧选一名已获得的武将。'),
      );
      return;
    }
    const bonds = def.bonds
      .map((id) => this.bundle.characters.find((c) => c.id === id)?.name)
      .filter(Boolean)
      .join(' · ');
    this.cardModalBody.replaceChildren(
      h('div', { class: 'card-modal-head' },
        h('div', { class: `card-modal-face card-modal-face--${def.rarity.toLowerCase()}`, style: `--rar:${RARITY_COLOR[def.rarity]}` },
          h('div', { class: 'card-modal-plate', style: `background-image:url(art/plates/${def.rarity}.png)` }),
          // 详情用**不裁的完整立绘**（art/portraits/），网格里才用裁过的缩略图。
          // 36 张立绘源比例有 0.563 和 0.667 两种，裁是为了网格齐平；
          // 详情要看到的就是整张画，裁了就等于白裁。
          h('img', { class: 'card-modal-art', src: `art/portraits/${def.id}.webp`, alt: def.name }),
          // 卡面文字统一左上角，和图鉴网格同一套位置规则
          h('div', { class: 'card-modal-tag-corner' },
            h('b', {}, def.name),
            h('span', {}, def.rarity),
          ),
        ),
        h('div', { class: 'card-modal-id' },
          h('h3', { style: `color:${def.color}` }, def.name),
          h('p', { class: 'note' }, `${def.title}｜${WUXING_LABEL[def.wuxing] ?? ''}·${def.role}｜No.${String(def.number).padStart(3, '0')}`),
          h('p', { class: 'card-modal-tag' }, `「${def.tagline}」`),
        ),
      ),
      h('p', { class: 'note' }, def.lore),
      h('h3', { class: 'card-modal-sec' }, def.skill.name),
      h('p', { class: 'note' }, def.skill.rule),
      h('p', { class: 'note' }, def.skill.desc),
      h('h3', { class: 'card-modal-sec' }, '羁 缘'),
      h('p', { class: 'note' }, bonds || '暂无'),
      ...this.meltPanel(def),
    );
  }

  /**
   * 分解 / 兑换面板。抄《炉石传说》的「磨刀石」：重复卡碎成灵宝，灵宝再换回卡。
   * 两点必须守住：
   *   1) 永远保留最后一张——全碎掉玩家就永远拿不回来了；
   *   2) 兑换不指定武将，否则 108 将规模下它会变成第二个抽卡。
   */
  private meltPanel(def: CharacterDef): HTMLElement[] {
    const gacha = this.bundle.gacha;
    const each = this.profile.meltValue(def.rarity, gacha);
    const have = this.profile.ownedCount(def.id);
    const spare = have - 1;
    const canMelt = each > 0 && spare > 0;

    const btn = (act: string, label: string, disabled: boolean, tip = ''): HTMLElement =>
      h('button', {
        class: 'melt-btn',
        'data-act': act,
        'data-char': def.id,
        type: 'button',
        disabled: disabled || undefined,
        title: tip,
      }, label);

    return [
      h('div', { class: 'melt-head' },
        h('h2', { style: 'font-size:18px;color:#e8eeff' }, '分 解'),
        h('span', { class: 'melt-own' }, `持有 ×${have}`),
      ),
      h('p', { class: 'note' }, each > 0
        ? `每张 ${def.rarity} 碎成 ${each} 灵宝。保留最后一张，散场即回收。`
        : '本稀有度暂不支持分解。'),
      h('div', { class: 'melt-acts' },
        btn('melt-one', `碎 1 张 +${each}`, !canMelt, '把 1 张多余的卡碎成灵宝'),
        btn('melt-all', spare > 0 ? `全碎 +${each * spare}` : '全碎', !canMelt, '把这张卡多余的副本一次性碎掉'),
      ),
      ...this.exchangePanel(),
    ];
  }

  /** 灵宝兑换档位。没配 melt、或该稀有度池子里一张卡都没有，就整块不渲染。 */
  private exchangePanel(): HTMLElement[] {
    const melt = this.bundle.gacha.melt;
    if (!melt) return [];
    // 只列池子里真有卡的档位。卡池还是 3 名测试武将时，
    // 一个「换 R 将」的按钮点了必然失败——那是死按钮，不是设计。
    const tiers = melt.exchange.filter((t) =>
      this.bundle.characters.some((c) => t.rarities.includes(c.rarity)),
    );
    if (!tiers.length) return [];
    const shards = this.profile.shards;
    return [
      h('div', { class: 'melt-head' },
        h('h2', { style: 'font-size:18px;color:#e8eeff' }, '灵宝兑换'),
        h('span', { class: 'melt-own' }, `灵宝 ${shards}`),
      ),
      h('p', { class: 'note' }, '重复卡碎出来的灵宝可以换回武将，稀有度随机。'),
      h('div', { class: 'ex-list' },
        ...tiers.map((tier) => {
          const ok = shards >= tier.shards;
          return h('button', {
            class: `ex-btn${ok ? ' can' : ''}`,
            'data-act': 'exchange',
            'data-tier': tier.id,
            type: 'button',
            disabled: ok ? undefined : true,
          },
            h('b', {}, tier.label),
            h('span', {}, `${tier.shards} 灵宝`),
          );
        }),
      ),
    ];
  }

  /* ------------------------------------------------------------ 出征 */

  private refreshDeploy(): void {
    const owned = new Set(this.profile.ownedList());
    if (this.deploySel.length === 0) this.deploySel = this.profile.team.filter((id) => owned.has(id)).slice(0, 3);

    // ---- 卡面选择：直接用立绘当选择面，而不是一行文字 ----
    this.deployGrid.replaceChildren(
      ...this.bundle.characters.map((c) => {
        const has = owned.has(c.id);
        const order = this.deploySel.indexOf(c.id);
        const face = h(
          'div',
          { class: 'pick-face' },
          // 和 3D 卡面共用同一张稀有度底板（art/plates/<RARITY>.png），
          // 选择面和图鉴/抽卡里的卡才像同一套东西
          h('div', { class: 'pick-plate', style: `background-image:url(art/plates/${c.rarity}.png)` }),
          h('img', { class: 'pick-art', src: `art/cards/${c.id}.webp`, alt: c.name, loading: 'lazy' }),
          h('div', { class: 'pick-frame' }),
          // 出征屏不显示持有数——那是图鉴的事，这里只负责「能不能上」
          has ? h('span') : h('div', { class: 'pick-badge' }, '未 持 有'),
          // 明确的序号框：上阵顺序 = 队伍顺序，也是球的相性取谁
          h('div', { class: 'pick-slot' }, order >= 0 ? `出 阵 ${order + 1}` : ''),
          h('div', { class: 'pick-foot' },
            h('b', { class: 'pick-name' }, c.name),
            h('span', { class: 'pick-rar', style: `color:${RARITY_COLOR[c.rarity]}` }, c.rarity),
          ),
        );
        const el = h(
          'button',
          {
            class: `pick${order >= 0 ? ' sel' : ''}${has ? '' : ' locked'}`,
            'data-char': c.id,
            type: 'button',
            style: `--c:${c.color}`,
          },
          face,
        );
        return el;
      }),
    );

    const ids = new Set(this.deploySel);
    const team = this.deploySel.map((id) => this.bundle.characters.find((c) => c.id === id)).filter(Boolean) as CharacterDef[];

    // ---- 队伍技能：每张卡各自的技能，改的是物理规则不是数值 ----
    this.deploySkills.replaceChildren(
      ...(team.length
        ? team.map((c, i) =>
            h(
              'div',
              { class: 'skill-row', style: `--c:${c.color}` },
              h('div', { class: 'skill-ord' }, String(i + 1)),
              h('div', { class: 'skill-body' },
                h('h4', {}, c.skill.name, h('span', { class: 'tag-tier' }, WUXING_LABEL[c.wuxing] ?? '')),
                h('p', { class: 'skill-rule' }, c.skill.rule),
                h('p', { class: 'skill-desc' }, c.skill.desc),
              ),
            ),
          )
        : [h('p', { class: 'note' }, '尚未选择武将。')]),
    );

    // ---- 羁绊技能：解锁的亮着，没解锁的灰着并点名缺谁 ----
    const unlocked = this.bundle.links.filter((l) => l.members.every((m) => ids.has(m)));
    const lockedOut = this.bundle.links.filter((l) => !l.members.every((m) => ids.has(m)));
    this.deployLinks.replaceChildren(
      ...(unlocked.length ? unlocked.map((l) => this.linkHint(l, true)) : [h('p', { class: 'note' }, '当前组合没有可用连携。')]),
      ...lockedOut.map((l) => {
        const missing = l.members.filter((m) => !ids.has(m)).map((m) => this.bundle.characters.find((c) => c.id === m)?.name ?? m);
        return this.linkHint(l, false, `还差 ${missing.join('、')}`);
      }),
    );

    // ---- 属性克制：球的相性 = 队伍第一位武将，敌人钉按属性分颜色 ----
    this.deployAttr.replaceChildren(...this.buildAttrPanel(team));

    // ---- 关卡属性 ----
    this.deployStage.replaceChildren(...this.buildStagePanel());
  }

  /** 属性克制面板：把「球的相性 vs 盘上每种敌人」摊开算给玩家看。 */
  private buildAttrPanel(team: CharacterDef[]): HTMLElement[] {
    const stage = expandStage(this.currentStage());
    const enemyWuxing = new Map<Wuxing, number>();
    for (const p of stage.pegs) {
      if (p.kind !== 'enemy' || !p.wuxing) continue;
      enemyWuxing.set(p.wuxing, (enemyWuxing.get(p.wuxing) ?? 0) + 1);
    }
    const lead = team[0];
    const ballWuxing: Wuxing | null = lead ? lead.wuxing : null;

    const head = h(
      'div',
      { class: 'attr-head' },
      h('span', { class: 'attr-ball' }, ballWuxing ? `球 · ${WUXING_LABEL[ballWuxing]}` : '球 · 未定'),
      h('span', { class: 'attr-lead' }, ballWuxing ? `取自 ${lead!.name}` : '先选一位武将'),
    );
    if (!ballWuxing) return [head, h('p', { class: 'note' }, '球的相性由出战第一位武将决定。')];

    const r = stage.rules.enemy;
    const rows = [...enemyWuxing.entries()].map(([wx, n]) => {
      // 四档而不是两档：相生与同属必须各自单列，否则玩家看不出"没被克"和
      // "生对方"到底差在哪——这两者在数值上差着一整档收益，而同属是不赚不亏
      const tier = wuxingTier(ballWuxing, wx);
      const verdict =
        tier.tier === 'win'
          ? { t: '克 制', c: '#ffd76a', m: r.attrWin }
          : tier.tier === 'gen'
            ? { t: '相 生', c: '#7de08a', m: r.attrGen }
            : tier.tier === 'same'
              ? { t: '同 属', c: '#9aa6b8', m: 1 }
              : { t: '逆 势', c: '#c07a6a', m: r.attrLose };
      return h(
        'div',
        { class: 'attr-row', style: `--a:${WUXING_HEX[wx]}` },
        h('span', { class: 'attr-dot' }),
        h('span', { class: 'attr-name' }, `${WUXING_LABEL[wx]} ×${n}`),
        h('span', { class: 'attr-verdict', style: `color:${verdict.c}` }, verdict.t),
        h('span', { class: 'attr-mult' }, `×${verdict.m}`),
      );
    });
    return [
      head,
      ...rows,
      h('p', { class: 'attr-foot' }, `会心 ${(r.critChance * 100).toFixed(0)}% ×${r.critMult}｜每多弹一次 +${r.perBounce} 伤害（上限 ${r.bounceMax} 弹）｜清空一枚小怪 +${(r.perSweep * 100).toFixed(0)}% Boss 伤害`),
    ];
  }

  /** 关卡属性铭板：这一关要打什么、怎么打、有什么奖励。 */
  private buildStagePanel(): HTMLElement[] {
    const def = this.currentStage();
    const stage = expandStage(def);
    const b = stage.boss;
    const f = stage.rules.fever;
    const e = stage.rules.enemy;
    const enemies = stage.pegs.filter((p) => p.kind === 'enemy').length;

    const stat = (k: string, v: string, c?: string): HTMLElement =>
      h('div', { class: 'st-cell' }, h('span', { class: 'st-k' }, k), h('span', { class: 'st-v', style: c ? `color:${c}` : '' }, v));

    return [
      h('div', { class: 'st-head' },
        h('h3', {}, `${def.name} · ${def.subtitle}`),
        h('p', {}, `${b.name}　${b.title}`),
      ),
      h('div', { class: 'st-grid' },
        stat('Boss 血量', String(b.maxHp), '#ff8a5c'),
        stat('基础减伤', `${(b.armor * 100).toFixed(0)}%`),
        stat('每回击射', String(stage.rules.balls)),
        stat('敌人钉', String(enemies), '#ff5470'),
        stat('確変', `${f.duration}s`, f.palette.led),
        stat('奖励', `${stage.rules.reward.silver} 银 / ${stage.rules.reward.stones} 灵石`),
      ),
      h('div', { class: 'st-phases' },
        h('span', { class: 'st-k' }, 'Boss 阶段'),
        ...b.phases.map((p) => h('span', { class: 'st-phase' }, `${p.at * 100 | 0}% ${p.name}`)),
      ),
      h('div', { class: 'st-fever' },
        h('span', { class: 'st-k' }, '確変触发'),
        h('span', {}, `命中「破绽」口 → 开闸 ${f.duration} 秒，追加 ${f.bonusBalls} 球，連打每档 +${(f.chainStep * 100).toFixed(0)}%（最高 ×${f.slotFactor * (1 + f.chainMax * f.chainStep)}），期间 Boss 减伤 −${(f.armorRelief * 100).toFixed(0)}%`),
      ),
      h('div', { class: 'st-fever' },
        h('span', { class: 'st-k' }, '小怪清场'),
        // 规则文案必须跟着通关条件走：胜利是「Boss 倒 **且** 小怪清空」，
        // 旧文案只讲「击射用尽扣分」，玩家会以为无视小怪照样能赢。
        h('span', {}, `每撞一次 ${e.baseDamage} 伤害，每多弹一次 +${e.perBounce}。` +
          `**Boss 打倒后要清空小怪才算赢**，清空一枚之后打 Boss +${(e.perSweep * 100).toFixed(0)}%` +
          `（清满 ×${(1 + e.perSweep * enemies).toFixed(2)}）并给球加速。` +
          `球打完了还没清空就是输。全清再追加 ${e.fullSweepDamage} 点 Boss 伤。`),
      ),
    ];
  }

  /**
   * 连携的触发条件串（金木水火土 / 技能名 / 能量），出征屏和战斗屏共用一份。
   *
   * 战斗屏原来只写「未满足」，玩家既不知道还差什么、也不知道该去做什么才满足。
   * 这不是提示语的问题，是**缺一整条信息**——条件没出现在画面上。
   */
  private linkConditionText(l: LinkDef): string {
    const parts = l.require.conditions.map((c) => {
      if (c.c === 'modActive') return `${PHYS_KEY_LABEL[c.key]} 进行中`;
      if (c.c === 'gaugeFull') return `${this.bundle.characters.find((x) => x.id === c.charId)?.skill.name ?? ''} 就绪`;
      return '';
    });
    if (l.require.energy) parts.push(`${l.require.energy} 能量`);
    return parts.filter(Boolean).join(' + ');
  }

  private linkHint(l: LinkDef, ready: boolean, missingNote = ''): HTMLElement {
    const req = this.linkConditionText(l);
    return h(
      'div',
      { class: `link-hint${ready ? ' on' : ' off'}`, style: `--c:${l.color}` },
      h(
        'h4',
        {},
        l.name,
        h('span', { class: 'tag-tier' }, l.tier === 'triple' ? '三卡' : '双卡'),
        h('span', { class: 'link-state' }, ready ? '已 解 锁' : missingNote || '未 达 成'),
      ),
      h('p', {}, `条件：${req}`),
      h('p', {}, l.desc),
    );
  }

  private toggleDeploy(id: string): void {
    if (this.profile.ownedCount(id) <= 0) return;
    const i = this.deploySel.indexOf(id);
    if (i >= 0) this.deploySel.splice(i, 1);
    else {
      if (this.deploySel.length >= 3) this.deploySel.shift();
      this.deploySel.push(id);
    }
    this.refreshDeploy();
  }

  /* ------------------------------------------------------------ 战斗 HUD */

  /**
   * 五行相性对照条。
   *
   * 盘面上的敌人钉是**按五行本色**认的（磨砂蓝/橙/绿/白/黄五色宝石），但战斗屏原来
   * 从头到尾没说过「这颗球是哪一系」。于是「相克 ×1.5 / 相生 ×1.2 / 同属 ×1 /
   * 逆势 ×0.7」这套核心机制只能靠背数值表——玩家看到一盘五颜六色，却不知道该优先
   * 撞哪一坨。这就是典型的谜语人：**信息在画面上（颜色），却没人和它对照。**
   *
   * 这一行就是把对照关系摆出来：左边一颗球，下面五块敌人色，色块上的倍数直接
   * 取 wuxingTier 算出来。玩家扫一眼就知道该往哪个颜色堆球。
   */
  private paintWuxingLegend(ballKey: string, r: EnemyRules): void {
    if (!ballKey) {
      this.wuxingLegend.replaceChildren(h('div', { class: 'wuxing-none' }, '球 · 未定'));
      return;
    }
    const ball = ballKey as Wuxing;
    this.wuxingLegend.replaceChildren(
      h(
        'div',
        { class: 'wuxing-ball', style: `--c:${WUXING_HEX[ball]}` },
        h('i', { class: 'wuxing-ball-dot' }),
        h('b', {}, `球 · ${WUXING_LABEL[ball]}`),
      ),
      h(
        'div',
        { class: 'wuxing-grid' },
        ...(['metal', 'wood', 'water', 'fire', 'earth'] as Wuxing[]).map((wx) => {
          const t = wuxingTier(ball, wx);
          const m = t.tier === 'win' ? r.attrWin : t.tier === 'gen' ? r.attrGen : t.tier === 'same' ? 1 : r.attrLose;
          const tag = t.tier === 'win' ? '克' : t.tier === 'gen' ? '生' : t.tier === 'same' ? '同' : '逆';
          return h(
            'div',
            { class: `wuxing-cell wuxing-cell--${t.tier}`, style: `--c:${WUXING_HEX[wx]}` },
            h('i', { class: 'wuxing-cell-dot' }),
            h('span', { class: 'wuxing-cell-name' }, WUXING_LABEL[wx]),
            h('b', { class: 'wuxing-cell-mult' }, `×${m}`),
            h('span', { class: 'wuxing-cell-tag' }, tag),
          );
        }),
      ),
    );
  }

  private shortSkillRule(def: CharacterDef): string {
    const brief: Record<string, string> = {
      wusong: '双刀横扫 · 火 · 碰撞叠层',
      linchong: '窄枪直线 · 水 · 短暂穿透',
      luzhishen: '禅杖圆击 · 土 · 拔钉托球',
    };
    return brief[def.id] ?? def.skill.rule;
  }

  mountBattle(team: CharacterDef[], links: LinkDef[], _balls: number): void {
    this.skillPointer = null;
    this.setSkillAim(null, null, 3);
    const stage = expandStage(this.currentStage());
    // 本关盘面上真正存在的钉种。图例只印出现过的那几种：
    // 12 关的盘面构成不同（有的关没有枪阵、有的关全是被 Boss 升上来的护甲钉），
    // 印一堆本关根本没这颗的钉是纯噪声，还会让玩家去找一个不存在的东西。
    const presentKinds = new Set(stage.pegs.map((p) => p.kind));
    // 落槽说明条：和盘口用同一套 SLOT_COLORS，玩家看颜色就能对上号。
    // 目标槽（破绽）单独描红——「往哪打」这件事不该让玩家在五行里找。
    //
    // 下面紧跟一段「路过」：中区色带**飞过就吃**，和底部**瞄了落进去**是两套机制，
    // 可它们原来在盘面上印的是同一批词（聚气 / 连斩 / 倍率），玩家必然混。
    // 盘面只留色带 + 两个字（钉子挡字），完整作用句在这里兜住。
    this.slotLegend.replaceChildren(
      h('div', { class: 'slot-legend-title' }, '落 槽　·　往哪打'),
      ...[...stage.slots]
        .sort((a, b) => a.x - b.x)
        .map((s) =>
          h(
            'div',
            { class: `slot-row${s.kind === 'boss' ? ' slot-row--target' : ''}` },
            h('i', { class: 'slot-dot', style: `--c:${hexOf(SLOT_COLORS[s.kind] ?? 0xffffff)}` }),
            h('b', {}, s.label),
            h('span', { class: 'slot-role' }, s.role),
          ),
        ),
      h('div', { class: 'zone-legend-title' }, '路 过　·　飞过就吃，不用瞄'),
      h(
        'div',
        { class: 'zone-legend-grid' },
        ...[...stage.zones]
          .sort((a, b) => a.y - b.y || a.x - b.x)
          .map((z) =>
            h(
              'div',
              { class: 'zone-chip', style: `--c:${hexOf(ZONE_COLORS[z.kind] ?? 0xffffff)}` },
              h('span', { class: 'zone-chip-name' }, z.label.slice(z.label.indexOf('·') + 1).trim()),
            ),
          ),
      ),
      // 钉子图例。盘面上的钉头不到 15px，颜色读得出但意思读不出——
      // 玩家看得见「这颗不一样」，看不见「不一样在哪」。这张表补的就是后半句。
      // 只印本关真出现的钉：12 关盘面构成不同，印一堆本关没有的钉反而是噪声。
      h('div', { class: 'peg-legend-title' }, '钉 子　·　盘上这几样不一样'),
      h(
        'div',
        { class: 'peg-legend-grid' },
        ...PEG_LEGEND.filter((p) => presentKinds.has(p.kind)).map((p) =>
          h(
            'div',
            { class: 'peg-legend-row' },
            h('i', { class: 'peg-legend-dot', style: `--c:${hexOf(p.led)}` }),
            h('b', {}, p.name),
            h('span', { class: 'peg-legend-role' }, p.role),
          ),
        ),
      ),
    );
    const wrap = this.screens.get('battle')!.querySelector('.p-skills')!;
    wrap.replaceChildren();
    this.wuxingBallKey = '';
    (this.screens.get('battle')!.querySelector('details') as HTMLDetailsElement).open = false;
    this.skillEls = team.map((def, index) => {
      const gauge = h('span');
      // 被动技能（公孙胜/燕青/张顺）：不充能、不占键位，面板明说常驻。
      // 印 rule，不印 skill.name。
      //
      // 「醉打山神 / 刀口舔血 / 甲马日夜奔」是 flavor，对玩法一句话都没说，
      // 玩家按 1/2/3 完全是盲按。`rule` 才是「这个技能改了什么物理规则」：
      // 「把球的恢复系数接近翻倍——反弹次数是伤害的主变量」一句话就说清了
      // 呼延灼为什么强、「只抬会心率不碰物理」一句话就说清了花荣是什么定位。
      // 技能名降级成武将名后面的小字，保留风味但不占主位。
      const passive = def.skill.trigger.auto === true;
      // 键位号只数主动角色，必须和 BattleScene.activeSkillSlot 同一套算法，
      // 否则面板印「2」而按 2 放的是另一个人。
      const keyNumber = passive ? 0 : team.slice(0, index).filter((c) => !c.skill.trigger.auto).length + 1;
      const root = h(
        passive ? 'div' : 'button',
        {
          ...(passive ? {} : { type: 'button' as const }),
          class: passive ? 'skill skill-passive' : 'skill',
          'data-skill': index,
          ...(passive ? {} : { 'aria-pressed': 'false' }),
          style: `--c:${def.color}`,
          title: `${def.skill.name}：${def.skill.rule}`,
        },
        h(
          'div',
          { class: 'skill-portrait' },
          h('img', { src: figureUrl(def.id), alt: def.name }),
          passive
            ? h('span', { class: 'skill-key skill-key-p' }, '被动')
            : h('span', { class: 'skill-key' }, String(keyNumber)),
        ),
        h(
          'div',
          { class: 'skill-main' },
          h('div', { class: 'skill-name' }, def.name),
          h('div', { class: 'skill-title' }, def.skill.name),
          h('div', { class: 'skill-rule' }, this.shortSkillRule(def)),
          passive
            ? h('div', { class: 'skill-rule skill-rule-passive' }, '整局常驻 · 无需按键')
            : h('div', { class: 'gauge' }, gauge),
        ),
      );
      wrap.append(root);
      return { root, gauge, skill: def, index };
    });
    this.linkEls.clear();
    this.linkWrap.replaceChildren(
      ...links.map((l) => {
        // 未满足时直接写「缺：<条件>」。原来只写「未满足」三个字，
        // 玩家既不知道还差什么、也不知道该去补哪一步——连携是全自动触发的，
        // 条件不写在脸上，玩家就永远不知道自己在为它做什么。
        const state = h('span', { class: 'link-lock' }, `缺：${this.linkConditionText(l)}`);
        const root = h(
          'button',
          { type: 'button', class: 'link-chip', 'data-link': l.id, style: `--c:${l.color}` },
          h('b', {}, l.name),
          state,
        );
        this.linkEls.set(l.id, { root, state });
        return root;
      }),
    );
    if (links.length === 0) {
      // 不能无条件写「单卡出战」：三卡队里凑不出连携条件是常态（连携是特定的两人/三人组合），
      // 照旧文案会把「3 张卡都带上了」说成「只带了 1 张」。
      const n = team.length;
      const hint = n <= 1 ? '单卡出战' : `${n} 卡出战`;
      const why = n >= 2 ? '，当前组合无连携' : ' · 无连携';
      this.linkWrap.append(
        h('span', { style: 'color:#6b7897;font-size:12px' }, hint + why),
      );
    }

    this.show('battle');
  }

  updateHud(s: BattleSnapshot, control: BallControlState): void {
    const bossKey = `${s.bossHp}:${s.bossMaxHp}:${s.bossArmor}:${s.bossPhaseIndex}:${s.bossPhaseName}:${s.phaseDeprivation.list.join('+')}`;
    if (bossKey !== this.bossHudKey) {
      this.bossHudKey = bossKey;
      const ratio = Math.max(0, Math.min(1, s.bossHp / Math.max(1, s.bossMaxHp)));
      this.bossFill.style.width = `${ratio * 100}%`;
      this.bossGhost.style.width = `${ratio * 100}%`;
      /*
       * 相位行同时报「谁」和「拿走了什么」。
       * 旧版只有「减伤 N%」：那是一句关卡本来就写着的话（玩家翻数据页也知道），
       * 真正会让这一局变难的三件事——落槽在跑、球在缩、救球没了——一个都没报。
       */
      const chips = s.phaseDeprivation.list.map((d) => DEPRIVATION_LABEL[d]).join(' · ');
      this.bossPhase.textContent = `${s.bossPhaseName}　减伤 ${Math.round(s.bossArmor * 100)}%` +
        (chips ? `　·　已被剥夺：${chips}` : '');
      this.bossPhase.classList.toggle('is-active', s.phaseDeprivation.list.length > 0);
      /*
       * 通关条件是「Boss 倒 **且** 小怪清空」，所以血条归零不等于赢。
       * 血条一空就把血量栏改成「已击破 · 还剩 N 枚」：这是整个 HUD 里
       * 唯一能告诉玩家「还没完」的位置，玩家本来就在盯着它看。
       * 缺了这句，界面没有任何地方说过还要清场——他会以为赢了，
       * 然后发现球还能打。
       */
      const pending = s.bossHp <= 0 && s.enemy.alive > 0;
      this.bossTop.classList.toggle('is-pending', pending);
      this.bossHp.textContent = pending
        ? `已击破 · 小怪还剩 ${s.enemy.alive} 枚`
        : `${s.bossHp} / ${s.bossMaxHp}`;
      this.bossPortrait.update(s.bossHp, s.bossMaxHp, s.bossPhaseIndex, s.bossPhaseName);
    }

    this.statEls.shots!.textContent = String(s.ballsLeft);
    this.statEls.time!.textContent = control.state === 'live' ? `${control.secondsLeft.toFixed(1)}s` : '—';
    /*
     * 球时被压缩时把这一格染红。**不能只报秒数**：同样跳到 3.0s，
     * 一个是「还早」、一个是「只剩一截」，而玩家只会看到数字变小，
     * 于是把一个看得见的剥夺当成「这关手感变差了」。
     */
    const squeezed = s.phaseDeprivation.ballScale < 1;
    this.statEls.time!.parentElement!.classList.toggle('is-squeezed', squeezed);
    const state = this.screens.get('battle')!.querySelector('.ball-state')!;
    const warning = control.state === 'live' && control.secondsLeft <= 3;
    /*
     * 救球被关掉时，金环不会亮、也按不出手——如果不写一句话，
     * 玩家只会看到「明明能救却救不了」，那看起来像 bug，不像规则。
     */
    state.textContent = control.state === 'idle' ? '拉杆蓄力 · 松手弹射' :
      control.noRescue && control.state === 'live'
        ? (warning ? '救球窗口已关闭 · 即将自动结算' : '救球窗口已关闭 · 只能等这颗落下')
      : control.state === 'done' ? '落槽结算 · 准备下一球' :
      control.rescueHeld ? (warning ? '救球已保留 · 计时归零仍会结算' : '救球已保留 · 松手击射') : warning ? '即将按最近落槽自动结算' :
      s.ballsLeft === 0 ? '击射已用尽 · 等待落槽' : control.canShoot ? '金环已亮 · 可蓄力救球' : '弹珠飞行中 · 等待金环';
    state.classList.toggle('warning', warning);
    state.classList.toggle('ready', control.canShoot);
    state.classList.toggle('deprived', control.noRescue);
    for (const entry of this.skillEls) {
      // 被动技能：gauge 元素压根没挂进 DOM（换成了「整局常驻」那行字），
      // 这里必须提前跳过——`g.max` 是 0，`0/0` 会算出 NaN 写进 style.width。
      if (entry.skill.skill.trigger.auto) continue;
      const g = s.gauges.find((x) => x.charId === entry.skill.id);
      const ratio2 = g && g.max > 0 ? g.value / g.max : 0;
      entry.gauge.style.width = `${ratio2 * 100}%`;
      entry.root.classList.toggle('ready', !!g && g.value >= g.max);
    }
    this.statEls.mult!.textContent = `×${s.slotMultiplier.toFixed(2)}`;
    this.statEls.mult!.title = `正中破绽 ×${s.weakSlotMultiplier.toFixed(2)} · 总倍率上限 ×${COMBAT.slotMultCap}`;
    this.statEls.next!.textContent = s.pendingNextMultiplier > 1 ? `×${s.pendingNextMultiplier.toFixed(2)} 待用` : '无';
    this.statEls.bounces!.textContent = `${s.enemy.bounces} 次`;
    // 小怪是独立目标：这一格必须让玩家随时看见「还剩几枚」和「清空换到多少倍率」。
    // 少了它，「清空才打得动大怪」这条规则在战斗里完全不可见——玩家只会以为
    // 小怪是掉分道具，跳过去直接瞄 Boss，然后发现打不动。
    const swept = s.enemy.total - s.enemy.alive;
    // Boss 倒下之后这一格就变成待办：不再报进度，直接报「还差什么」。
    const pending = s.bossHp <= 0 && s.enemy.alive > 0;
    const minionStat = this.statEls.minions!.parentElement!;
    minionStat.classList.toggle('is-pending', pending);
    this.statEls.minions!.textContent = pending
      ? `清空 ${s.enemy.alive} 枚才能收工`
      : `${swept}/${s.enemy.total}　Boss ×${s.enemy.sweepMult.toFixed(2)}`;
    this.statEls.minions!.title = `每清空一枚，之后对 Boss 的伤害翻这一格。` +
      `通关条件是「Boss 打倒 **且** 小怪清空」，击射用尽还没清空就算输` +
      `（收尾扣分 ${(expandStage(this.currentStage()).rules.enemy.leftoverPenalty * 100).toFixed(0)}% 现在只作为清场质量的次级反馈，不再决定胜负）`;
    this.statEls.recovery!.textContent = `${s.recovery.charge} / ${s.recovery.max}`;
    const recovery = this.screens.get('battle')!.querySelector('.recovery-track') as HTMLElement;
    recovery.setAttribute('aria-valuenow', String(s.recovery.charge));
    recovery.setAttribute('aria-valuemax', String(s.recovery.max));
    (recovery.firstElementChild as HTMLElement).style.width = `${100 * s.recovery.charge / Math.max(1, s.recovery.max)}%`;
    recovery.classList.toggle('pulse', s.recovery.pulse > 0);
    // 五行对照条：球色 + 五种敌人钉的相性档位。球色变了（技能「化五行」会改写）就重画。
    const ballKey = s.enemy.wuxingKey;
    if (ballKey !== this.wuxingBallKey) {
      this.wuxingBallKey = ballKey;
      this.paintWuxingLegend(ballKey, expandStage(this.currentStage()).rules.enemy);
    }

    // 確変条：进度按剩余时间走，最后三秒开始逼人——刺激必须有倒计时压力
    const f = s.fever;
    this.feverBar.classList.toggle('on', f.active);
    if (f.active) {
      this.feverFill.style.width = `${Math.max(0, Math.min(100, (f.left / f.duration) * 100))}%`;
      this.feverRenda.textContent = `${f.renda} 連打`;
      this.feverMult.textContent = `×${f.mult.toFixed(2)}`;
      this.feverBar.classList.toggle('hot', f.left <= 3);
    }

    this.buffWrap.replaceChildren(
      ...s.buffs.map((b) =>
        h('span', { class: 'buff', style: `color:${b.color}` }, `${b.label} ×${b.mult.toFixed(1)} ${b.left.toFixed(1)}s`),
      ),
      ...s.links
        .filter((l) => l.active)
        .map((l) => h('span', { class: 'buff', style: `color:${l.color}` }, `${l.name} ${l.left.toFixed(1)}s`)),
    );

    for (const [id, el] of this.linkEls) {
      const l = s.links.find((x) => x.linkId === id);
      if (!l) continue;
      el.root.classList.toggle('armed', l.armed && !l.active);
      el.root.classList.toggle('active', l.active);
      el.root.classList.toggle('locked', l.locked);
      // 条件满足就把它撤掉——「可触发」本身就是最响的那句话，
      // 再缀一串条件只会把它稀释掉
      el.state.textContent = l.active
        ? `生效 ${l.left.toFixed(1)}s`
        : l.locked
          ? '已锁定'
          : l.armed
            ? '可触发'
            : `缺：${this.linkConditionText(this.bundle.links.find((x) => x.id === id)!)}`;
    }

    /*
     * 聚气条现在是一条**只涨不放**的进度：满格即自动结算三段连击。
     * 满格那一帧整条闪一下，玩家能看见「就是这一下攒满了」，
     * 之后能量归零重来——不需要任何「可以按了」的高亮，因为它本来就不可按。
     */
    const eRatio = Math.max(0, Math.min(1, s.energy / Math.max(1, s.energyMax)));
    const eKey = `${Math.round(eRatio * 20)}`;
    if (eKey !== this.energyHudKey) {
      this.energyHudKey = eKey;
      this.statEls.energy!.textContent = `${s.energy} / ${s.energyMax}`;
    }
  }

  setSkillAim(preview: StrikePreview | null, index: number | null, slowRemaining: number): void {
    this.skillAimHint.hidden = !preview;
    this.skillEls.forEach((entry) => {
      entry.root.classList.toggle('selected', entry.index === index);
      entry.root.setAttribute('aria-pressed', String(entry.index === index));
    });
    if (!preview) return;
    const slow = slowRemaining > .05 ? `慢放余量 ${slowRemaining.toFixed(1)}s` : '正常速度';
    this.skillAimText.textContent = `${preview.name} · ${preview.targets.length} 命中 · 敌人削血 ${Math.round(preview.totalDamage)} · 击破 ${preview.totalKills}　${slow}｜松开施放 / 点盘面确认`;
  }

  setAim(power01: number, charging: boolean): void {
    this.chargeUi.classList.toggle('on', charging);
    this.chargeFill.style.width = `${power01 * 100}%`;
    const deg = Math.round(power01 * 100);
    this.chargeTxt.textContent = charging
      ? `蓄力 ${deg}%　·　松开发射`
      : '按住蓄力，松手发射';
  }

  /* ------------------------------------------------------------ 结算 */

  showResult(phase: 'victory' | 'defeat', s: BattleSnapshot, reward: { silver: number; stones: number; shards: number } | null): void {
    this.resultTitle.textContent = phase === 'victory' ? '镇 山' : '再 来'
      ;
    this.resultTitle.className = `result-title ${phase === 'victory' ? 'win' : 'lose'}`;
    this.resultGrid.replaceChildren(
      cell('总伤害', String(s.totalDamage)),
      cell('最高连击', String(s.maxCombo)),
      cell('钉击', String(s.pegHits)),
      cell('贯穿', String(s.pierced)),
      cell('连锁引爆', String(s.detonated)),
      cell('摧毁钉板', String(s.destroyedPegs)),
      cell('落槽', String(s.slotsHit)),
      cell('剩余球数', String(s.ballsLeft)),
      cell('五行恢复', `${s.recovery.restorations} 次`),
      cell('武器技能', `${s.weapon.casts} 次 · ${s.weapon.hits} 命中`),
      cell('技能削血 / 击破', `${Math.round(s.weapon.damage)} / ${s.weapon.kills}`),
      cell('用时', `${s.elapsed.toFixed(0)}s`),
    );
    this.resultReward.replaceChildren(
      ...(reward
        ? [
            h('span', {}, `银两 +${reward.silver}`),
            h('span', {}, `灵石 +${reward.stones}`),
            h('span', {}, `灵宝 +${reward.shards}`),
          ]
        : [h('span', {}, '未获得奖励')]),
    );
    this.refreshResources();

    // 战役推进：赢了就把下一阵的名字写上按钮，打到第十二阵就收起来。
    // recordClear 是在 main.ts 的 onFinish 里调的，所以这里读到的进度已经是通关后的。
    const ids = this.stageIds();
    const at = this.currentStageIndex();
    const nextStage = this.bundle.stages[at + 1];
    const canNext = phase === 'victory' && !!nextStage && this.profile.stageUnlocked(at + 1, ids);
    this.nextBtn.style.display = canNext ? '' : 'none';
    // 写关名不写 id：按钮上出现「下一阵 · stage_02」等于把内部主键甩给玩家看
    if (canNext) this.nextBtn.textContent = `下一阵 · ${nextStage.name}`;

    this.show('result');
  }

  /**
   * 「下一阵」直接落到下一关的出征屏。
   * 原来只 show('stages')：按钮上写着下一阵，人却被丢回十二宫格自己再点一次；
   * 更糟的是存档里的 currentStage 还停在刚打完那关，点完返回看到的是自己刚赢的盘。
   */
  private goNextStage(): void {
    const ids = this.stageIds();
    const nextId = ids[this.currentStageIndex() + 1];
    if (!nextId) return;
    if (!this.profile.selectStage(nextId, ids)) return;
    this.refreshStages();
    this.refreshDeploy();
    this.show('deploy');
  }

  /* ------------------------------------------------------------ 反馈 */

  float(x: number, y: number, text: string, color: string, scale: number): void {
    if (!text) return;
    const major = scale >= 1.35 || text.includes('五行归位');
    const el = h('div', { class: `float${major ? ' float--major' : ''}`, style: `left:${x}px;top:${y}px;color:${color};--float-color:${color};font-size:${Math.round(22 * scale)}px` }, text);
    this.floatsEl.append(el);
    window.setTimeout(() => el.remove(), 1100);
    while (this.floatsEl.childElementCount > 40) this.floatsEl.firstElementChild!.remove();
  }

  flash(color: string, duration: number): void {
    this.flashEl.style.background = color;
    this.flashEl.classList.remove('go');
    void this.flashEl.offsetWidth;
    this.flashEl.style.animationDuration = `${Math.max(0.2, duration)}s`;
    this.flashEl.classList.add('go');
  }
}

function chip(color: string, label: string, value: number): HTMLElement {
  return h('span', {}, h('i', { class: 'i', style: `background:${color}` }), `${label} `, h('b', {}, String(value)));
}

function cell(label: string, value: string): HTMLElement {
  return h('div', { class: 'result-cell' }, h('span', {}, label), h('b', {}, value));
}
