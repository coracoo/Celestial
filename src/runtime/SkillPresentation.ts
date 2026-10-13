import type { CharacterDef } from '../data/schema.ts';
import { figureUrl } from '../core/figureLayer.ts';
import './skill-presentation.css';

/** Short portrait cut-in. A future video can replace its visual layer without owning gameplay. */
export class SkillPresentation {
  private readonly root: HTMLElement;
  private timer = 0;
  constructor(host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'skill-presentation';
    this.root.setAttribute('aria-live', 'polite');
    this.root.hidden = true;
    host.append(this.root);
  }
  show(character: CharacterDef): void {
    window.clearTimeout(this.timer);
    this.root.replaceChildren();
    this.root.style.setProperty('--skill-color', character.accent);
    this.root.dataset.element = character.wuxing;
    this.root.hidden = false;
    const flare = document.createElement('div'); flare.className = 'skill-presentation-flare';
    /*
     * 立绘外面套一层 figure 框，是为了裁掉角色层的出血。
     * 不能直接把裁剪切给 <img>：入场动画的 keyframes 已经在动 transform
     * （translateX + scale），再叠一个静态 scale 就会被动画整个覆盖掉。
     * 所以框负责摆位置和裁切，图自己只管演。
     */
    const figure = document.createElement('div'); figure.className = 'skill-presentation-figure';
    const portrait = document.createElement('img');
    portrait.className = 'skill-presentation-portrait';
    portrait.src = figureUrl(character.id);
    portrait.alt = character.name;
    figure.append(portrait);
    const copy = document.createElement('div'); copy.className = 'skill-presentation-copy';
    const actor = document.createElement('span'); actor.className = 'skill-presentation-actor'; actor.textContent = `${character.title} · ${character.name}`;
    const title = document.createElement('strong'); title.className = 'skill-presentation-title';
    [...character.skill.name].forEach((letter, i) => {
      const span = document.createElement('span'); span.textContent = letter;
      span.style.setProperty('--letter', String(i)); title.append(span);
    });
    copy.append(actor, title);
    this.root.append(flare, figure, copy);
    for (let i = 0; i < 9; i++) {
      const spark = document.createElement('i'); spark.className = 'skill-presentation-spark';
      spark.style.setProperty('--spark', String(i)); this.root.append(spark);
    }
    this.timer = window.setTimeout(() => this.hide(), window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 480 : 1350);
  }
  hide(): void { window.clearTimeout(this.timer); this.root.hidden = true; this.root.replaceChildren(); }
}
