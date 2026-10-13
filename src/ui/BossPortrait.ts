import { bossCardFor } from '../data/BossCards.ts';
import { h, on } from './dom.ts';
import './boss-portrait.css';

/** A HUD portrait, outside the physical board. Updates only on boss state changes. */
export class BossPortrait {
  readonly element: HTMLElement;
  private readonly image: HTMLImageElement;
  private readonly name: HTMLElement;
  private readonly phase: HTMLElement;
  private readonly missing: HTMLElement;
  private readonly reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  private motionEnabled = true;
  private lastHp = -1;
  private lastMaxHp = -1;
  private lastPhase = '';
  private animation: Animation | null = null;

  constructor() {
    this.image = h('img', { class: 'boss-portrait-image', alt: '', width: 512, height: 768, decoding: 'async', draggable: false });
    this.name = h('b', { class: 'boss-portrait-name' });
    this.phase = h('span', { class: 'boss-portrait-phase' });
    this.missing = h('span', { class: 'boss-portrait-missing', hidden: true }, '立绘暂未载入');
    this.element = h('figure', { class: 'boss-portrait', hidden: true },
      this.image, this.missing, h('figcaption', {}, this.name, this.phase));
    on(this.image, 'error', () => { this.missing.hidden = false; this.image.style.visibility = 'hidden'; });
    on(this.image, 'load', () => { this.missing.hidden = true; this.image.style.visibility = ''; });
    this.reduced.addEventListener('change', () => { if (this.reduced.matches) this.stopAnimation(); });
  }

  setBoss(id: string): void {
    this.reset();
    const def = bossCardFor(id);
    this.element.hidden = !def;
    if (!def) return;
    this.element.dataset.boss = def.id;
    this.element.title = `${def.name} · ${def.title}`;
    this.name.textContent = def.name;
    this.image.alt = `${def.name}立绘`;
    this.missing.hidden = true;
    this.image.style.visibility = '';
    if (this.image.getAttribute('src') !== def.portrait) this.image.src = def.portrait;
  }

  update(hp: number, maxHp: number, phaseIndex: number, phaseName: string): void {
    const phaseKey = `${phaseIndex}:${phaseName}`;
    const hpChanged = this.lastHp !== hp || this.lastMaxHp !== maxHp;
    const phaseChanged = this.lastPhase !== phaseKey;
    if (!hpChanged && !phaseChanged) return;
    const hit = this.lastHp >= 0 && hp < this.lastHp;
    const phaseShift = this.lastPhase !== '' && phaseChanged;
    this.lastHp = hp;
    this.lastMaxHp = maxHp;
    this.lastPhase = phaseKey;
    if (phaseChanged) {
      this.phase.textContent = phaseName;
      this.element.dataset.phase = String(phaseIndex);
    }
    if (hpChanged) {
      this.element.classList.toggle('boss-portrait--wounded', hp > 0 && hp / Math.max(1, maxHp) <= .33);
      this.element.classList.toggle('boss-portrait--defeated', hp <= 0);
    }
    if (!(hit || phaseShift) || !this.motionEnabled || this.reduced.matches || this.element.hidden) return;
    this.stopAnimation();
    this.animation = this.image.animate([
      { transform: 'translateX(0)', filter: 'brightness(1)' },
      { transform: `translateX(${phaseShift ? -4 : -2}px)`, filter: `brightness(${phaseShift ? 1.32 : 1.2})` },
      { transform: 'translateX(2px)', filter: 'brightness(1.05)' },
      { transform: 'translateX(0)', filter: 'brightness(1)' },
    ], { duration: phaseShift ? 340 : 190, easing: 'ease-out' });
  }

  setMotionEnabled(enabled: boolean): void {
    this.motionEnabled = enabled;
    this.element.dataset.motion = String(enabled);
    if (!enabled) this.stopAnimation();
  }

  reset(): void {
    this.stopAnimation();
    this.lastHp = -1;
    this.lastMaxHp = -1;
    this.lastPhase = '';
    this.phase.textContent = '';
    this.element.classList.remove('boss-portrait--wounded', 'boss-portrait--defeated');
    delete this.element.dataset.phase;
  }

  private stopAnimation(): void {
    this.animation?.cancel();
    this.animation = null;
  }
}
