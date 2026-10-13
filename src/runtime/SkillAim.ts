/** Input-only selection and per-ball real-time budget; no charge or combat mutation. */
export class SkillAim {
  selected: number | null = null;
  angleDeg = 90;
  private slowUsed = 0;
  private clockAt: number | null = null;
  private clockLive = false;

  /** Synchronize before selection/live-state changes. Clock time never comes from physics dt. */
  syncClock(nowSeconds: number, live: boolean): void {
    if (this.clockAt !== null && this.clockLive && this.selected !== null) {
      this.slowUsed = Math.min(3, this.slowUsed + Math.max(0, nowSeconds - this.clockAt));
      if (3 - this.slowUsed < 1e-9) this.slowUsed = 3;
    }
    this.clockAt = nowSeconds;
    this.clockLive = live;
  }

  begin(index: number, ready: boolean): boolean {
    if (!ready) return false;
    if (this.selected !== index) this.angleDeg = 90;
    this.selected = index;
    return true;
  }

  confirm(index?: number): number | null {
    if (this.selected === null || (index !== undefined && index !== this.selected)) return null;
    const selected = this.selected;
    this.selected = null;
    return selected;
  }

  cancel(): boolean {
    const hadSelection = this.selected !== null;
    this.selected = null;
    return hadSelection;
  }

  newBall(): void {
    this.cancel();
    this.slowUsed = 0;
    this.clockAt = null;
    this.clockLive = false;
  }

  /** Scale the fixed-step accumulator without spending clock budget or changing Rapier's dt. */
  advance(fixedDt: number): number {
    const slow = this.selected !== null && this.clockLive && this.slowRemaining > 0;
    return Math.max(0, fixedDt) * (slow ? .2 : 1);
  }

  get slowRemaining(): number { return Math.max(0, 3 - this.slowUsed); }

  rotate(delta: number): void {
    this.angleDeg = ((this.angleDeg + delta) % 360 + 360) % 360;
  }

  pointAt(x: number, y: number, targetX: number, targetY: number): void {
    if (Math.hypot(targetX - x, targetY - y) < .001) return;
    this.angleDeg = (Math.atan2(targetY - y, targetX - x) * 180 / Math.PI + 360) % 360;
  }
}
