/** Tiny observable stack: the most recently registered entry is the active one (screen → sheet → popup). */
export class StackStore<T> {
  private entries: Array<{ id: number; value: T }> = [];
  private listeners = new Set<() => void>();
  private seq = 0;

  push(value: T): number {
    const id = ++this.seq;
    this.entries.push({ id, value });
    this.emit();
    return id;
  }

  update(id: number, value: T): void {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    e.value = value;
    this.emit();
  }

  remove(id: number): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((x) => x.id !== id);
    if (this.entries.length !== before) this.emit();
  }

  top(): T | null {
    return this.entries.length ? this.entries[this.entries.length - 1]!.value : null;
  }

  all(): T[] {
    return this.entries.map((e) => e.value);
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
