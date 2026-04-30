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

    // Scan both stdout and stderr for the ready signal. Synopsis emits its
    // "MCP server ready" line on stderr (alongside the rest of its log
    // output); other supervised binaries may use stdout. Either is fine.
    let signalled = false;
    const checkSignal = (text: string): void => {
      if (signalled || !readySignal) return;
      if (text.includes(readySignal)) {
        signalled = true;
        this.backoffMs = 1000;
        onReady?.();
      }
    };

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      checkSignal(text);
      logger.debug(`[synopsis] ${text.trimEnd()}`);
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      checkSignal(text);
      logger.warn(`[synopsis:stderr] ${text.trimEnd()}`);
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
