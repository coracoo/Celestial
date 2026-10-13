/** 极简类型化事件总线。用于 Runtime → UI 的单向广播。 */
export class Emitter<M extends Record<string, unknown>> {
  private map = new Map<keyof M, Set<(payload: never) => void>>();

  on<K extends keyof M>(type: K, fn: (payload: M[K]) => void): () => void {
    let set = this.map.get(type);
    if (!set) {
      set = new Set();
      this.map.set(type, set);
    }
    set.add(fn as (payload: never) => void);
    return () => set!.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const set = this.map.get(type);
    if (!set) return;
    for (const fn of [...set]) (fn as (p: M[K]) => void)(payload);
  }

  clear(): void {
    this.map.clear();
  }
}
