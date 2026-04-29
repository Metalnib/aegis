import type { BusEvent } from "./types.js";

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  /**
   * Optional. Implementations that support runtime level changes (the default
   * createLogger does) expose this hook so the supervisor can respond to a
   * logging.level change without restarting.
   */
  setLevel?(level: "debug" | "info" | "warn" | "error"): void;
}

export interface SecretsProvider {
  get(name: string): string;
}

export interface KvStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface AdapterContext {
  logger: Logger;
  secrets: SecretsProvider;
  store: KvStore;
  clock: () => Date;
  config: Record<string, unknown>;
  emit: (event: BusEvent) => void;
}
