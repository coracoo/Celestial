import type { PullResult } from '../game/Profile.ts';
import { CARD_BACK_ALLY } from '../data/cardBacks.ts';
import { h } from './dom.ts';
import { PackLifecycle } from './PackLifecycle.ts';
import './pack.css';

type PackHooks = { onTear(): PullResult | null; onReveal(result: PullResult): void; onClose(): void };
type PackState = 'preview' | 'tearing' | 'opening' | 'rising' | 'revealing' | 'revealed' | 'denied';

/** One pack, one existing Profile transaction. Animation never owns the awarded card. */
export class PackOpening {
  private readonly host: HTMLElement;
  private readonly hooks: PackHooks;
  private overlay: HTMLElement | null = null;
  private lifecycle: PackLifecycle<PullResult> | null = null;
  private listeners: AbortController | null = null;
  private timers = new Set<number>();
  private previousFocus: HTMLElement | null = null;
  private state: PackState = 'preview';
  private pointer: { id: number; x: number; y: number; width: number } | null = null;

  constructor(host: HTMLElement, hooks: PackHooks) {
    this.host = host;
    this.hooks = hooks;
  }

  open({ cost, stones }: { cost: number; stones: number }): void {
    if (this.overlay) this.close();
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const affordable = stones >= cost;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const controller = new AbortController();
    this.listeners = controller;
    const signal = controller.signal;
    const closeButton = h('button', { class: 'pack-close', type: 'button', 'aria-label': '关闭卡包预览' }, '×');
    const tearButton = h('button', { class: 'pack-tear-button', type: 'button', disabled: !affordable }, '撕开卡包');
    const strip = h('div', { class: 'pack-strip', 'aria-hidden': 'true' },
      h('span', { class: 'pack-strip-start' }, '撕'), h('span', { class: 'pack-strip-line' }), h('span', {}, '→'));
    const front = h('div', { class: 'pack-card-front' });
    const card = h('div', { class: 'pack-card', 'aria-hidden': 'true' },
      h('div', { class: 'pack-card-turn' },
        h('div', { class: 'pack-card-back' },
          h('img', { src: CARD_BACK_ALLY, alt: '', width: 512, height: 768, draggable: false, decoding: 'async' })),
        front));
    const status = h('p', { class: 'pack-status', role: 'status', 'aria-live': 'polite' },
      affordable ? '从左侧「撕」处向右拖动封条，或按下方按钮' : '灵石不足，暂时无法撕开卡包');
    const resultLabel = h('div', { class: 'pack-result', 'aria-live': 'polite' });
    const overlay = h('section', { class: 'pack-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'TCG 星将卡包', 'data-pack-state': 'preview' },
      h('div', { class: 'pack-dialog', tabindex: -1 },
        closeButton,
        h('header', { class: 'pack-heading' }, h('span', {}, 'THE STAR COLLECTION'), h('h2', {}, '开启星将卡包'),
          h('p', {}, '一包一将 · 撕开时消耗灵石')),
        h('div', { class: 'pack-stage', 'data-pack-stage': true },
          h('div', { class: 'pack-halo' }), card,
          h('div', { class: 'pack-wrapper' },
            h('div', { class: 'pack-mouth' }),
            h('div', { class: 'pack-foil' },
              h('div', { class: 'pack-foil-border' }),
              h('span', { class: 'pack-edition' }, 'Celestial · 一〇八'),
              h('div', { class: 'pack-sigil' }, h('span', {}, '星')),
              h('strong', { class: 'pack-brand' }, '星将集'),
              h('span', { class: 'pack-series' }, 'CELESTIAL HEROES'),
              h('div', { class: 'pack-seal' }, '壹将入藏'),
              h('small', { class: 'pack-serial' }, '108 / COLLECTIBLE CARD')),
            strip, h('div', { class: 'pack-crimp' }))),
        resultLabel, status,
        h('footer', { class: 'pack-footer' },
          h('div', { class: 'pack-price' }, h('span', {}, `开启 ${cost} 灵石`), h('small', {}, `持有 ${stones} · 预览免费`)),
          tearButton),
        h('p', { class: 'pack-fine-print' }, '沿用当前抽将概率与保底 · 关闭未撕卡包不消耗灵石')));
    this.overlay = overlay;
    this.state = 'preview';
    overlay.classList.toggle('pack-reduced', reduced);
    overlay.classList.toggle('pack-unaffordable', !affordable);
    const lifecycle = new PackLifecycle<PullResult>(this.hooks);
    this.lifecycle = lifecycle;
    const setState = (state: PackState, message: string): void => {
      if (this.overlay !== overlay) return;
      this.state = state;
      overlay.dataset.packState = state;
      status.textContent = message;
    };
    const later = (fn: () => void, ms: number): void => {
      const timer = window.setTimeout(() => {
        this.timers.delete(timer);
        if (this.overlay === overlay) fn();
      }, ms);
      this.timers.add(timer);
    };
    const reveal = (): void => {
      card.removeAttribute('aria-hidden');
      setState('revealed', '星将已入藏，可在图鉴中查看');
      closeButton.setAttribute('aria-label', '关闭卡包结果');
      tearButton.disabled = false;
      tearButton.textContent = '查看卡牌';
      const balance = overlay.querySelector('.pack-price small');
      if (balance) balance.textContent = `剩余 ${Math.max(0, stones - cost)} 灵石 · 已入藏`;
      later(() => lifecycle.reveal(), reduced ? 180 : 450);
    };
    const tear = (): void => {
      if (this.state !== 'preview' || this.overlay !== overlay || !affordable) return;
      this.pointer = null;
      tearButton.disabled = true;
      closeButton.focus();
      overlay.style.setProperty('--pack-tear', '1');
      setState('tearing', '封条撕开，星将已抽取');
      const result = lifecycle.commit();
      // onTear may synchronously route away or close the modal.
      if (this.overlay !== overlay) return;
      if (!result) {
        setState('denied', '灵石不足，卡包未开启。关闭后可重新预览。');
        overlay.style.setProperty('--pack-tear', '0');
        return;
      }
      overlay.dataset.packRarity = result.rarity;
      front.append(h('img', { src: `art/cards/${result.def.id}.webp`, alt: `${result.rarity} ${result.def.name}`, draggable: false }), h('div', { class: 'pack-card-glint' }));
      card.setAttribute('aria-label', `${result.rarity} ${result.def.name}`);
      resultLabel.append(h('span', { class: 'pack-rarity' }, result.rarity), h('strong', {}, result.def.name), h('small', {}, result.isNew ? '初次入藏' : '再会星将 · 已加入收藏'));
      if (reduced) { reveal(); return; }
      later(() => setState('opening', '卡包展开'), 320);
      later(() => setState('rising', '星将卡片出包'), 700);
      later(() => { card.removeAttribute('aria-hidden'); setState('revealing', '揭示星将'); }, 1230);
      later(reveal, 1850);
    };
    tearButton.addEventListener('click', () => { if (this.state === 'revealed') this.close(); else tear(); }, { signal });
    closeButton.addEventListener('click', () => this.close(), { signal });
    overlay.addEventListener('click', (event) => { if (event.target === overlay) this.close(); }, { signal });
    strip.addEventListener('pointerdown', (event) => {
      if (!affordable || this.state !== 'preview' || this.pointer || event.button !== 0) return;
      const rect = strip.getBoundingClientRect();
      // The visible notch is on the left; grabbing the far end cannot open a pack.
      if (event.clientX > rect.left + rect.width * 0.38) return;
      this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width };
      strip.setPointerCapture(event.pointerId);
      overlay.classList.add('pack-dragging');
      event.preventDefault();
    }, { signal });
    strip.addEventListener('pointermove', (event) => {
      const pointer = this.pointer;
      if (!pointer || pointer.id !== event.pointerId || this.state !== 'preview') return;
      if (Math.abs(event.clientY - pointer.y) > 90) { this.cancelDrag(strip); return; }
      const progress = Math.min(1, Math.max(0, (event.clientX - pointer.x) / (pointer.width * 0.68)));
      overlay.style.setProperty('--pack-tear', String(progress));
      if (progress >= 1) { this.cancelDrag(strip); tear(); }
    }, { signal });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      strip.addEventListener(event, () => this.cancelDrag(strip), { signal });
    }
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); this.close(); }
      if (event.key !== 'Tab') return;
      const focusable = [...overlay.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement as HTMLButtonElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    }, { signal });
    this.host.append(overlay);
    (affordable ? tearButton : closeButton).focus();
  }

  close(): void {
    if (!this.overlay) return;
    const lifecycle = this.lifecycle;
    this.lifecycle = null;
    this.listeners?.abort();
    this.listeners = null;
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    this.pointer = null;
    this.overlay.remove();
    this.overlay = null;
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
    this.previousFocus = null;
    lifecycle?.close();
  }

  private cancelDrag(strip: HTMLElement): void {
    const pointer = this.pointer;
    this.pointer = null;
    if (pointer && strip.hasPointerCapture(pointer.id)) strip.releasePointerCapture(pointer.id);
    this.overlay?.classList.remove('pack-dragging');
    if (this.state === 'preview') this.overlay?.style.setProperty('--pack-tear', '0');
  }
}
