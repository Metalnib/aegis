import type { Logger } from "@aegis/sdk";

type LogLevel = "debug" | "info" | "warn" | "error";

const levels: LogLevel[] = ["debug", "info", "warn", "error"];

export function createLogger(minLevel: LogLevel = "info", format: "json" | "text" = "json"): Logger {
  const minIdx = levels.indexOf(minLevel);

  function log(level: LogLevel, msg: string, data?: unknown): void {
    if (levels.indexOf(level) < minIdx) return;

    if (format === "json") {
      process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(data != null ? { data } : {}) }) + "\n");
    } else {
      const prefix = `[${new Date().toISOString()}] ${level.toUpperCase()}`;
      process.stdout.write(`${prefix} ${msg}${data != null ? " " + JSON.stringify(data) : ""}\n`);
    }
  }

  return {
    debug: (msg, data) => log("debug", msg, data),
    info: (msg, data) => log("info", msg, data),
    warn: (msg, data) => log("warn", msg, data),
    error: (msg, data) => log("error", msg, data),
  };
}
