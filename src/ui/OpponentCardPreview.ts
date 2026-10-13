import { CARD_BACK_ENEMY } from '../data/cardBacks.ts';
import { h, on } from './dom.ts';

interface LayeredCard {
  name: string;
  layers: { background: string; subject: string; frame: string };
}

/** Four real image planes: the shared card back plus the layered front.
 * The frame's 32% alpha is already baked into its asset. */
export class OpponentCardPreview {
  readonly element: HTMLElement;
  private readonly reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  private enabled: boolean;
  private x = 0;
  private y = 0;
  private frame = 0;

  constructor(def: LayeredCard, enabled: boolean) {
    this.enabled = enabled;
    const surface = h('div', { class: 'opponent-card-surface', 'aria-hidden': 'true' });
    const error = h('figcaption', { class: 'opponent-card-error', hidden: true }, '立绘暂未载入');
    // The card is a physical object, so it has a back too. It faces away and
    // sits opposite the front frame; backface-visibility keeps it hidden from
    // the front like every other layer in the stack.
    surface.append(h('img', {
      class: 'opponent-card-layer opponent-card-back', src: CARD_BACK_ENEMY, alt: '',
      width: 512, height: 768, draggable: false, decoding: 'async',
    }));
    for (const layer of ['background', 'subject', 'frame'] as const) {
      const img = h('img', {
        class: `opponent-card-layer opponent-card-${layer}`, src: def.layers[layer], alt: '',
        width: 512, height: 768, draggable: false, decoding: 'async',
      });
      on(img, 'error', () => { error.hidden = false; });
      surface.append(img);
    }
    surface.append(h('span', { class: 'opponent-card-sheen' }));
    this.element = h('figure', {
      class: 'opponent-card-figure', tabindex: 0, role: 'group',
      'aria-label': `${def.name}分层立绘。方向键转动，空格回正。`,
    }, surface, error);
    on(this.element, 'pointermove', (event) => {
      if (!this.enabled || this.reduced.matches) return;
      const rect = this.element.getBoundingClientRect();
      this.aim((event.clientX - rect.left) / rect.width * 2 - 1, (event.clientY - rect.top) / rect.height * 2 - 1);
    });
    for (const event of ['pointerleave', 'pointercancel', 'blur'] as const) on(this.element, event, () => this.reset());
    on(this.element, 'pointerup', (event) => { if (event.pointerType !== 'mouse') this.reset(); });
    on(this.element, 'keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === ' ' || event.key === 'Enter') this.reset();
      else if (this.enabled && !this.reduced.matches) {
        this.aim(this.x + (event.key === 'ArrowLeft' ? -.3 : event.key === 'ArrowRight' ? .3 : 0),
          this.y + (event.key === 'ArrowUp' ? -.3 : event.key === 'ArrowDown' ? .3 : 0));
      }
    });
    this.reduced.addEventListener('change', this.reset);
    this.reset();
  }

  setMotionEnabled(enabled: boolean): void { this.enabled = enabled; this.reset(); }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.reduced.removeEventListener('change', this.reset);
  }

  private aim(x: number, y: number): void {
    this.x = Math.max(-1, Math.min(1, x));
    this.y = Math.max(-1, Math.min(1, y));
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.paint(); });
  }

  private reset = (): void => {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.x = this.y = 0;
    this.paint();
  };

  private paint(): void {
    const style = this.element.style;
    style.setProperty('--card-rx', `${-this.y * 5}deg`);
    style.setProperty('--card-ry', `${this.x * 7}deg`);
    style.setProperty('--card-sx', `${this.x * 6}px`);
    style.setProperty('--card-sy', `${this.y * 4}px`);
    style.setProperty('--card-bx', `${-this.x * 3}px`);
    style.setProperty('--card-by', `${-this.y * 2}px`);
    style.setProperty('--card-light-x', `${50 + this.x * 28}%`);
    style.setProperty('--card-light-y', `${38 + this.y * 25}%`);
    style.setProperty('--card-light', String((Math.abs(this.x) + Math.abs(this.y)) * .09));
    this.element.dataset.motion = String(this.enabled && !this.reduced.matches);
  }
}
