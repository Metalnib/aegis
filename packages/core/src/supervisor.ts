import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "@aegis/sdk";

interface SupervisorOptions {
  command: string;
  args: string[];
  logger: Logger;
  onReady?: () => void;
  readySignal?: string;
  maxBackoffMs?: number;
}

export class Supervisor {
  private proc: ChildProcess | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private readonly maxBackoffMs: number;

  constructor(private readonly opts: SupervisorOptions) {
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  }

  start(): void {
    this.stopped = false;
    this.spawn();
  }

  stop(): void {
    this.stopped = true;
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }

  private spawn(): void {
    if (this.stopped) return;

    const { command, args, logger, onReady, readySignal } = this.opts;
    logger.info(`[supervisor] spawning: ${command} ${args.join(" ")}`);

    this.proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (readySignal && text.includes(readySignal)) {
        this.backoffMs = 1000;
        onReady?.();
      }
      logger.debug(`[synopsis] ${text.trimEnd()}`);
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      logger.warn(`[synopsis:stderr] ${chunk.toString().trimEnd()}`);
    });

    this.proc.on("exit", (code, signal) => {
      if (this.stopped) return;
      logger.warn(`[supervisor] process exited (code=${code}, signal=${signal}), restarting in ${this.backoffMs}ms`);
      setTimeout(() => {
        this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
        this.spawn();
      }, this.backoffMs);
    });
  }
}
