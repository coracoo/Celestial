/**
 * 全程序化 WebAudio 音效：不依赖任何音频资源文件。
 * 浏览器自动播放策略要求首次用户手势后才能出声，因此所有方法在未解锁时静默返回。
 */
export class AudioKit {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private enabled = true;

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);

      const len = Math.floor(this.ctx.sampleRate * 0.4);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = null;
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.5 : 0;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private get t(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  private tone(
    freq: number,
    dur: number,
    opts: { type?: OscillatorType; gain?: number; sweepTo?: number; delay?: number } = {},
  ): void {
    if (!this.ctx || !this.master) return;
    const t0 = this.t + (opts.delay ?? 0);
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.sweepTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.sweepTo), t0 + dur);
    const peak = opts.gain ?? 0.22;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.012, dur * 0.25));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private burst(dur: number, freq: number, q: number, gain = 0.2, delay = 0): void {
    if (!this.ctx || !this.master || !this.noise) return;
    const t0 = this.t + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  ui(): void {
    this.tone(880, 0.07, { type: 'triangle', gain: 0.12 });
  }

  deny(): void {
    this.tone(200, 0.14, { type: 'square', gain: 0.1, sweepTo: 120 });
  }

  launch(power: number): void {
    const p = Math.max(0, Math.min(1, (power - 17) / 13));
    this.tone(220 + p * 160, 0.2, { type: 'sawtooth', gain: 0.14, sweepTo: 900 + p * 500 });
    this.burst(0.16, 1400, 1.2, 0.1);
  }

  /**
   * 弹射道松手。**音色刻意和 `launch` 分开**：
   * 弹簧是「嘣」的一下（短、低、带噪声），击射是「叮」的一声（长、亮、带音高）。
   *
   * 参数是归一化的蓄力 0~1，不是力度值——弹射道的力度范围是 48~76，
   * 直接传力度进来的话归一化会永远贴在高位，轻弹和满弹听起来一样。
   */
  plunge(power01: number): void {
    const p = Math.max(0, Math.min(1, power01));
    // 弹簧张紧的低频嗡声，随力度上扫
    this.tone(90 + p * 60, 0.09, { type: 'triangle', gain: 0.16, sweepTo: 150 + p * 90 });
    // 放手瞬间的宽带「嘣」
    this.burst(0.13, 620 + p * 520, 1.5, 0.13);
    this.tone(320 + p * 220, 0.16, { type: 'sine', gain: 0.1, sweepTo: 140 + p * 180 });
  }

  /**
   * 追打。球已经在盘上、又被玩家打了一发——这是新玩法的核心动作，
   * 声音必须和首发**明显不同**：首发是「弹弓放手」，追打是「打钢珠的清脆当」。
   *
   * 音高随累计反弹数往上走：打第 3 下和打第 20 下听起来不一样，
   * 玩家闭着眼都能听出「我已经救了它很久了」。
   */
  shot(): void {
    this.tone(1180, 0.06, { type: 'triangle', gain: 0.13 });
    this.tone(1770, 0.09, { type: 'sine', gain: 0.09 });
    this.burst(0.05, 3200, 2.0, 0.07);
  }

  /**
   * 翻板回击声。
   *
   * 刻意做成**闷、短、带金属体**的「咚」，而不是 `shot` 那种尖亮的双音。
   * 两者的差别是功能性的：击射是玩家瞄准后打出的远程脉冲，翻板是贴着球
   * 的一记近身撞击。音色分不开的话，玩家会以为按板消耗了一次击射资源，
   * 于是不敢随便按——而「敢不敢按板」正是这条机制全部的乐趣。
   */
  flipper(): void {
    this.tone(196, 0.1, { type: 'square', gain: 0.16 });
    this.tone(98, 0.14, { type: 'sine', gain: 0.18 });
    this.burst(0.035, 1400, 1.2, 0.05);
  }

  /**
   * 组合技的第 N 段。
   *
   * **音高必须随段数递增**，这是「三段」这件事唯一不靠画面的传达方式。
   * 三下一样的声音听起来是同一个技能重复触发了三次，
   * 递增的三下才读成「越打越重」——和伤害 1.0 / 1.5 / 2.0 的递增对得上。
   */
  comboHit(index: number): void {
    const base = 520 + index * 190;
    this.tone(base, 0.1, { type: 'square', gain: 0.14 });
    this.tone(base * 1.5, 0.13, { type: 'triangle', gain: 0.1 });
    this.burst(0.04, 2600 + index * 700, 1.4, 0.06);
  }

  /**
   * 撞击音。
   *
   * 之前所有钢钉共用一个基频（1180Hz），轻碰和狠撞听起来几乎一样——
   * 玩家听不出「这一下重不重」，打击感就丢了一半。
   * 现在按强度把音量、时长、泛音一起拉开：轻碰是短促的一声脆响，
   * 狠撞是带金属余韵的「当」，和画面上球的挤压幅度对得上。
   */
  peg(intensity: number, kind: string): void {
    const base = kind === 'spear' ? 1500 : kind === 'weak' ? 900 : kind === 'destructible' ? 700 : 1180;
    const k = Math.max(0, Math.min(1, intensity));
    const f = base * (0.82 + k * 0.55);
    this.tone(f, 0.035 + k * 0.075, { type: 'triangle', gain: 0.04 + k * 0.17 });
    // 狠撞补一层高频泛音：金属被敲出余韵的那一声
    if (k > 0.45) this.tone(f * 1.94, 0.05 + k * 0.09, { type: 'sine', gain: 0.03 + (k - 0.45) * 0.14 });
    if (k > 0.75) this.burst(0.05, 2600, 2.4, 0.05 * k);
    // 万金钉：金属钣的「当」——两个泛音叠在一起，和钢钉的单音明显不同。
    // 玩家看不见飘字的时候（余光瞄着别处），耳朵还能告诉他「刚才那颗不一样」。
    if (kind === 'golden') {
      this.tone(f * 1.5, 0.1, { type: 'sine', gain: 0.07 + k * 0.1 });
      this.tone(f * 2.02, 0.14, { type: 'sine', gain: 0.05 + k * 0.07 });
    }
  }

  zone(kind: string): void {
    const map: Record<string, [number, number]> = {
      energy: [660, 1320],
      combo: [520, 1040],
      skill: [740, 1480],
      multiplier: [880, 1760],
      boss: [180, 240],
      normal: [420, 420],
    };
    const [a, b] = map[kind] ?? map.normal!;
    this.tone(a, 0.13, { type: 'sine', gain: 0.13, sweepTo: b });
  }

  slot(kind: string, value: number): void {
    const base = kind === 'boss' ? 130 : kind === 'multiplier' ? 620 : 480 + value * 8;
    this.tone(base, 0.24, { type: kind === 'boss' ? 'sawtooth' : 'sine', gain: 0.2, sweepTo: base * 1.5 });
    this.tone(base * 2, 0.16, { type: 'sine', gain: 0.1, delay: 0.03 });
  }

  skill(name: string): void {
    this.burst(0.3, 900, 0.7, 0.16);
    const root = name === 'berserk' ? 160 : name === 'pierce' ? 240 : name === 'shockwave' ? 110 : 200;
    this.tone(root, 0.5, { type: 'sawtooth', gain: 0.18, sweepTo: root * 4 });
    this.tone(root * 1.5, 0.4, { type: 'square', gain: 0.09, delay: 0.05 });
  }

  link(): void {
    const chord = [196, 247, 294, 392];
    chord.forEach((f, i) => this.tone(f, 0.7, { type: 'triangle', gain: 0.13, delay: i * 0.055 }));
    this.burst(0.5, 700, 0.5, 0.18);
  }

  bossHit(crit: boolean): void {
    this.tone(crit ? 90 : 130, crit ? 0.3 : 0.18, { type: 'square', gain: crit ? 0.24 : 0.15, sweepTo: 55 });
    if (crit) this.burst(0.24, 320, 1.1, 0.2);
  }

  charge(): void {
    this.tone(1200, 0.08, { type: 'sine', gain: 0.09, sweepTo: 1800 });
  }

  victory(): void {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.55, { type: 'triangle', gain: 0.16, delay: i * 0.12 }));
  }

  defeat(): void {
    [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.6, { type: 'sawtooth', gain: 0.13, delay: i * 0.16 }));
  }
}

export const audio = new AudioKit();
