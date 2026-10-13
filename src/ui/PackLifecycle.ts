/** Transaction ownership is separate from the cosmetic opening animation. */
export class PackLifecycle<T> {
  private readonly hooks: { onTear(): T | null; onReveal(result: T): void; onClose(): void };
  private attempted = false;
  private committing = false;
  private delivered = false;
  private closed = false;
  private closeRequested = false;
  private result: T | null = null;
  constructor(hooks: { onTear(): T | null; onReveal(result: T): void; onClose(): void }) { this.hooks = hooks; }
  commit(): T | null {
    if (this.attempted || this.closed) return null;
    // Lock before entering the external Profile transaction; hooks can re-enter.
    this.attempted = true;
    this.committing = true;
    try {
      this.result = this.hooks.onTear();
      return this.result;
    } finally {
      this.committing = false;
      if (this.closeRequested) this.close();
    }
  }
  reveal(): void {
    if (this.delivered || this.result === null) return;
    this.delivered = true;
    this.hooks.onReveal(this.result);
  }
  close(): void {
    if (this.closed) return;
    if (this.committing) { this.closeRequested = true; return; }
    this.closed = true;
    // A charged card belongs to the player even if its animation was interrupted.
    try { this.reveal(); } finally { this.hooks.onClose(); }
  }
}
