/**
 * Tracks the boot readiness of named subsystems. Aegis declares itself
 * "ready" only when every registered subsystem has been marked ready.
 * See ADR 0016 (Startup readiness) for the contract.
 *
 * The gate is intentionally simple: a fixed set of named flags, all of
 * which must flip true before `isReady()` returns true. There is no
 * partial-readiness state (deferred per the ADR). The gate is in-process
 * only - on restart everything starts not-ready and re-converges.
 */
export class ReadinessGate {
  private readonly subsystems = new Map<string, boolean>();
  private readyListeners: Array<() => void> = [];

  constructor(names: ReadonlyArray<string>) {
    if (names.length === 0) throw new Error("ReadinessGate requires at least one subsystem");
    for (const n of names) this.subsystems.set(n, false);
  }

  /**
   * Mark a subsystem as ready. Idempotent. Throws if the name was not
   * registered at construction (catches typos that would otherwise cause
   * the gate to never open).
   */
  markReady(name: string): void {
    if (!this.subsystems.has(name)) {
      throw new Error(`ReadinessGate: unknown subsystem "${name}". Registered: ${[...this.subsystems.keys()].join(", ")}`);
    }
    if (this.subsystems.get(name)) return;
    this.subsystems.set(name, true);
    if (this.isReady()) {
      const listeners = this.readyListeners;
      this.readyListeners = [];
      for (const l of listeners) {
        try { l(); } catch { /* listener errors must not block readiness */ }
      }
    }
  }

  /** True when every registered subsystem has been marked ready. */
  isReady(): boolean {
    for (const v of this.subsystems.values()) if (!v) return false;
    return true;
  }

  /** Names of subsystems still pending. Empty when ready. */
  pending(): string[] {
    return [...this.subsystems.entries()].filter(([, v]) => !v).map(([n]) => n);
  }

  /**
   * Resolves when the gate becomes ready. Resolves immediately if it
   * already is. Used by the polling loop to delay its first cycle until
   * boot finishes.
   */
  whenReady(): Promise<void> {
    if (this.isReady()) return Promise.resolve();
    return new Promise(resolve => { this.readyListeners.push(resolve); });
  }
}
