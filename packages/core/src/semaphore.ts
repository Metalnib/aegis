/**
 * Counting semaphore. Awaiters that arrive when the permit count is exhausted
 * queue FIFO; release() in any order is fine.
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (permits < 1) throw new Error("Semaphore must have at least 1 permit");
    this.permits = permits;
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return this.releaser();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.permits -= 1;
        resolve(this.releaser());
      });
    });
  }

  /** Builds a one-shot release callback - calling it twice is a no-op so callers can safely double-release in error paths. */
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  /** Number of permits not currently held. Useful for metrics, not for gating. */
  available(): number {
    return this.permits;
  }

  private release(): void {
    this.permits += 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}
