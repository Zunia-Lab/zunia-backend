/**
 * Fixed-window counter per key with a bounded key set, so a flood of
 * distinct addresses cannot grow memory without limit.
 */
export class WindowLimiter {
  private readonly windows = new Map<string, { start: number; hits: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {}

  /** Record a hit. False when the key is over its limit, or when no key slot is free. */
  hit(key: string, now = Date.now()): boolean {
    let entry = this.windows.get(key);
    if (entry && now - entry.start >= this.windowMs) {
      entry.start = now;
      entry.hits = 0;
    }
    if (!entry) {
      if (this.windows.size >= this.maxKeys) this.prune(now);
      if (this.windows.size >= this.maxKeys) return false;
      entry = { start: now, hits: 0 };
      this.windows.set(key, entry);
    }
    entry.hits += 1;
    return entry.hits <= this.limit;
  }

  prune(now = Date.now()): void {
    for (const [key, entry] of this.windows) {
      if (now - entry.start >= this.windowMs) this.windows.delete(key);
    }
  }

  get size(): number {
    return this.windows.size;
  }
}
