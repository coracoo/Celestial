import type { CharacterDef, GameDataBundle } from '../data/schema.ts';
import type { Profile } from '../game/Profile.ts';
import { figureUrl } from '../core/figureLayer.ts';
import { DialogueRun, type StoryChapter } from './storyData.ts';
import './story.css';

interface StoryHooks {
  onBattle(stageId: string): void;
  onClose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, action: string, className = 'story-button'): HTMLButtonElement {
  const node = el('button', className, text);
  node.type = 'button';
  node.dataset.storyAction = action;
  return node;
}

/** Narrative presentation only. Profile remains the single owner of progression/rewards. */
export class StoryMode {
  private readonly root: HTMLElement;
  private readonly bundle: GameDataBundle;
  private readonly profile: Profile;
  private readonly hooks: StoryHooks;
  private readonly stageIds: string[];
  /** 章节走 bundle（public/data/story.json），不再从代码里读常量。 */
  private readonly chapters: readonly StoryChapter[];
  private readonly characters: Map<string, CharacterDef>;
  private run: DialogueRun | null = null;
  private chapter: StoryChapter | null = null;
  private phase: 'map' | 'before' | 'after' = 'map';
  private previousFocus: HTMLElement | null = null;
  private lastAdvance = -Infinity;
  private readonly heldKeys = new Set<string>();

  constructor(host: HTMLElement, bundle: GameDataBundle, profile: Profile, hooks: StoryHooks) {
    this.bundle = bundle;
    this.profile = profile;
    this.hooks = hooks;
    this.stageIds = bundle.stages.map((s) => s.id);
    this.chapters = bundle.story;
    this.characters = new Map(bundle.characters.map((c) => [c.id, c]));
    this.root = el('section', 'story-overlay');
    this.root.hidden = true;
    this.root.tabIndex = -1;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    host.append(this.root);
    this.root.addEventListener('click', (event) => this.onClick(event));
    for (const name of ['pointerdown', 'pointerup', 'dblclick']) {
      this.root.addEventListener(name, (event) => event.stopPropagation());
    }
    // Capture before the game's window keyboard handlers; also swallow a held key's release.
    window.addEventListener('keydown', (event) => this.onKeyDown(event), true);
    window.addEventListener('keyup', (event) => {
      if (!this.root.hidden || this.heldKeys.has(event.key)) {
        event.stopImmediatePropagation();
        const nativeButton = !this.root.hidden && event.target instanceof Element && event.target.closest('button');
        if (['Enter', ' ', 'Escape'].includes(event.key) && !nativeButton) event.preventDefault();
      }
      this.heldKeys.delete(event.key);
    }, true);
  }

  open(): void {
    this.run?.cancel();
    this.run = null;
    this.chapter = null;
    this.phase = 'map';
    this.activate('星阵归途 · 章节选择');
    this.root.replaceChildren();
    const map = el('div', 'story-map');
    const top = el('header', 'story-map-header');
    const heading = el('div', 'story-map-heading');
    heading.append(el('span', 'story-kicker', 'Celestial 同盟 · 原创幻想篇'), el('h1', 'story-title', '星阵归途'));
    top.append(heading);
    const progress = this.chapters.filter((c) => this.profile.isStageCleared(c.stageId)).length;
    const intro = el('div', 'story-map-intro');
    intro.append(el('p', '', '十二枚星印散落山川。随同伴破五行之阵，把碎裂的星图重新连成归路。'));
    intro.append(el('span', 'story-progress', `星印 ${progress} / ${this.chapters.length}`));
    const grid = el('div', 'story-chapter-grid');
    grid.setAttribute('aria-label', '剧情章节');
    for (const [index, chapter] of this.chapters.entries()) {
      const stageIndex = this.stageIds.indexOf(chapter.stageId);
      const unlocked = stageIndex >= 0 && this.profile.stageUnlocked(stageIndex, this.stageIds);
      const cleared = this.profile.isStageCleared(chapter.stageId);
      const card = el('article', `story-chapter${cleared ? ' is-cleared' : ''}${unlocked ? '' : ' is-locked'}`);
      const start = button('', 'chapter', 'story-chapter-start');
      start.dataset.stageId = chapter.stageId;
      start.disabled = !unlocked;
      const meta = el('div', 'story-chapter-meta');
      meta.append(el('span', 'story-chapter-number', String(index + 1).padStart(2, '0')),
        el('span', 'story-badge', cleared ? '星印已归' : unlocked ? '可出征' : '未解锁'));
      start.append(meta, el('h2', '', chapter.title));
      const stage = this.bundle.stages.find((s) => s.id === chapter.stageId);
      start.append(el('p', 'story-location', stage?.name ?? chapter.stageId), el('p', 'story-summary', chapter.summary));
      start.append(el('span', 'story-chapter-cta', unlocked ? (cleared ? '重温战前 · 再次出征 →' : '阅读战前 · 出征 →') : '通关上一章后解锁'));
      card.append(start);
      if (cleared) {
        const replay = button('重温战后', 'replay', 'story-replay');
        replay.dataset.stageId = chapter.stageId;
        card.append(replay);
      }
      grid.append(card);
    }
    /*
     * 页脚跟自由模式一样：「返 回」在左下、说明在右。全项目所有返回键都在左下角
     * （自由选关 .menu、我方图鉴、出征页），剧情页之前塞在标题栏右上角还是一枚浏览器
     * 默认按钮，来回切屏时眼睛会先被那颗灰白方块绊一下。按钮样式/文案/位置全跟 .btn 对齐。
     */
    const foot = el('div', 'story-map-foot');
    foot.append(button('返 回', 'close', 'story-back'),
      el('p', 'story-map-note', '原创女性水浒幻想改编 · 章节沿用战役进度 · 重温对话不额外发放奖励'));
    map.append(top, intro, grid, foot);
    this.root.append(map);
    this.focusFirst();
  }

  playBefore(stageId: string): void {
    const chapter = this.chapters.find((c) => c.stageId === stageId);
    const index = this.stageIds.indexOf(stageId);
    if (!chapter || index < 0 || !this.profile.stageUnlocked(index, this.stageIds)) {
      this.open();
      return;
    }
    this.begin(chapter, 'before', () => {
      this.hide();
      this.hooks.onBattle(stageId);
    });
  }

  playAfter(stageId: string, onDone: () => void): void {
    const chapter = this.chapters.find((c) => c.stageId === stageId);
    if (!chapter) {
      this.hide();
      onDone();
      return;
    }
    this.begin(chapter, 'after', () => {
      this.hide();
      onDone();
    });
  }

  hide(): void {
    this.run?.cancel();
    this.run = null;
    this.root.hidden = true;
    const restore = this.previousFocus;
    this.previousFocus = null;
    if (restore?.isConnected && restore.getClientRects().length) restore.focus({ preventScroll: true });
  }

  private activate(label: string): void {
    if (this.root.hidden) this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.root.hidden = false;
    this.root.setAttribute('aria-label', label);
  }

  private begin(chapter: StoryChapter, phase: 'before' | 'after', onDone: () => void): void {
    this.run?.cancel();
    this.chapter = chapter;
    this.phase = phase;
    this.lastAdvance = -Infinity;
    this.run = new DialogueRun(chapter[phase], onDone);
    this.activate(`${chapter.title} · ${phase === 'before' ? '战前' : '战后'}`);
    this.renderDialogue();
  }

  private renderDialogue(): void {
    const chapter = this.chapter;
    const run = this.run;
    const line = run?.current;
    if (!chapter || !run || !line) return;
    this.root.replaceChildren();
    const header = el('header', 'story-dialogue-header');
    const title = el('div', 'story-dialogue-title');
    const chapterNumber = this.chapters.indexOf(chapter) + 1;
    title.append(el('span', 'story-kicker', `星阵归途 · 第 ${String(chapterNumber).padStart(2, '0')} 章`), el('h1', '', chapter.title));
    const controls = el('div', 'story-dialogue-controls');
    controls.append(el('span', 'story-line-count', `${this.phase === 'before' ? '战前' : '战后'} ${run.index + 1} / ${run.lines.length}`));
    controls.append(button(this.phase === 'before' ? '跳过 · 出征' : '跳过 · 继续', 'skip', 'story-button story-quiet'));
    if (this.phase === 'before') controls.append(button('章节', 'map', 'story-button story-quiet'));
    header.append(title, controls);
    const scene = el('div', 'story-scene');
    scene.setAttribute('aria-hidden', 'true');
    scene.append(el('div', 'story-scene-ring'), el('div', 'story-scene-motif', chapter.motif));
    chapter.cast.forEach((id, index) => {
      const def = this.characters.get(id);
      const figure = el('div', `story-portrait ${index === 0 ? 'story-left' : 'story-right'}${line.speaker === id ? ' is-speaking' : ''}${line.speaker === 'narrator' ? ' is-narration' : ''}`);
      const img = el('img', 'story-portrait-image');
      img.src = new URL(figureUrl(id), document.baseURI).href;
      img.alt = '';
      img.draggable = false;
      // A failed asset leaves the named speaker plate readable, never a broken-image glyph.
      img.addEventListener('error', () => { img.hidden = true; }, { once: true });
      figure.append(img, el('span', 'story-portrait-name', def?.name ?? id));
      scene.append(figure);
    });
    const dialogue = el('div', 'story-dialogue-box');
    const speaker = this.characters.get(line.speaker);
    const speakerPlate = el('div', 'story-speaker-plate');
    speakerPlate.append(el('span', 'story-speaker', speaker?.name ?? '旁白'), el('span', 'story-speaker-title', speaker?.title ?? '星图记事'));
    const text = el('p', 'story-dialogue-text', line.text);
    text.setAttribute('aria-live', 'polite');
    text.setAttribute('aria-atomic', 'true');
    const footer = el('div', 'story-dialogue-footer');
    footer.append(el('span', 'story-input-hint', '点画面 / Enter / 空格 · 下一句'));
    const last = run.index === run.lines.length - 1;
    footer.append(button(last ? (this.phase === 'before' ? '前往出征 →' : '继续 →') : '下一句 →', 'advance', 'story-button story-next'));
    dialogue.append(speakerPlate, text, footer);
    this.root.append(scene, header, dialogue);
    // Keep keyboard progression stable when replacing the previous line's DOM.
    this.root.querySelector<HTMLButtonElement>('[data-story-action="advance"]')?.focus({ preventScroll: true });
  }

  private advance(skip = false): void {
    if (!this.run) return;
    if (skip) { this.run.skip(); return; }
    const now = performance.now();
    if (now - this.lastAdvance < 180) return;
    this.lastAdvance = now;
    const run = this.run;
    run.advance();
    if (this.run === run) this.renderDialogue();
  }

  private close(): void {
    this.hide();
    this.hooks.onClose();
  }

  private onClick(event: MouseEvent): void {
    event.stopPropagation();
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-story-action]') : null;
    if (target?.disabled) return;
    const action = target?.dataset.storyAction;
    const stageId = target?.dataset.stageId;
    if (action === 'close') this.close();
    else if (action === 'chapter' && stageId) this.playBefore(stageId);
    else if (action === 'replay' && stageId && this.profile.isStageCleared(stageId)) this.playAfter(stageId, () => this.open());
    else if (action === 'map') this.open();
    else if (action === 'skip') this.advance(true);
    else if (this.phase !== 'map') this.advance();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.root.hidden) return;
    event.stopImmediatePropagation();
    this.heldKeys.add(event.key);
    if (event.key === 'Tab') {
      const items = [...this.root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter((b) => b.getClientRects().length > 0);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !this.root.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !this.root.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
      return;
    }
    if (!['Enter', ' ', 'Escape'].includes(event.key)) return;
    if (event.key !== 'Escape' && event.target instanceof Element && event.target.closest('button')) {
      this.heldKeys.delete(event.key);
      if (event.repeat) event.preventDefault();
      return;
    }
    if (event.key !== 'Escape' && this.phase === 'map') return; // Native buttons keep Enter/Space activation.
    event.preventDefault();
    if (event.repeat) return;
    if (event.key === 'Escape') {
      if (this.phase === 'after') this.advance(true);
      else if (this.phase === 'before') this.open();
      else this.close();
    } else this.advance();
  }

  private focusFirst(): void {
    const firstChapter = this.root.querySelector<HTMLButtonElement>('.story-chapter-start:not(:disabled)');
    (firstChapter ?? this.root).focus({ preventScroll: true });
  }
}
