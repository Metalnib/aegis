/**
 * CLI chat adapter for local interactive testing. Reads commands from stdin,
 * writes replies to stdout. Mirrors the same `<verb> [args]` shape the Slack
 * and Google Chat adapters use, so commands and permissions are identical.
 *
 * Use this for smoke-testing a new deployment, exercising graph queries
 * against a local Synopsis daemon, or validating a custom LLM provider
 * without going through Slack.
 */

import readline from "node:readline";
import { ChatAdapterBase } from "@aegis/sdk";
import type {
  ChatAdapter, AdapterContext, ChatCommand, ChatBody, ChannelRef,
  ChatSpec, SpecApplyOutcome, CommandPermission,
} from "@aegis/sdk";

export interface CliChatConfig {
  id?: string;
  /** Banner printed once on startup. Optional. */
  banner?: string;
  /** User id reported in commands. Defaults to "local". */
  userId?: string;
  /** Permission level granted to the local user. Defaults to "admin". */
  permission?: CommandPermission;
  /** Prompt printed before each input line. Defaults to `"> "`. */
  prompt?: string;
}

export function cli(cfg: CliChatConfig = {}): ChatAdapter {
  return new CliChatAdapter(cfg);
}

const STDOUT_CHANNEL_ID = "stdout";

export class CliChatAdapter extends ChatAdapterBase {
  readonly id: string;
  protected readonly tier3SpecKeys = new Set<string>();

  private commandHandlers: Array<(c: ChatCommand) => void> = [];
  private rl?: readline.Interface;
  private cfg: Required<Omit<CliChatConfig, "banner">> & { banner?: string };

  constructor(cfg: CliChatConfig) {
    super();
    this.cfg = {
      id: cfg.id ?? "cli",
      userId: cfg.userId ?? "local",
      permission: cfg.permission ?? "admin",
      prompt: cfg.prompt ?? "> ",
      ...(cfg.banner !== undefined ? { banner: cfg.banner } : {}),
    };
    this.id = this.cfg.id;
  }

  async init(ctx: AdapterContext): Promise<void> {
    if (this.cfg.banner) process.stdout.write(`${this.cfg.banner}\n`);
    process.stdout.write(`[cli] ready. Type a command, or "help" for the list. Empty line repeats prompt.\n`);
    this.writePrompt();

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY,
    });

    this.rl.on("line", (line) => {
      const text = line.trim();
      if (!text) {
        this.writePrompt();
        return;
      }
      // Strip optional "@aegis " prefix to mirror Slack mention behavior.
      const cmdText = text.replace(/^@?aegis\s+/i, "");
      const cmd: ChatCommand = {
        channel: { id: STDOUT_CHANNEL_ID },
        user: { id: this.cfg.userId },
        text: cmdText,
        receivedAt: new Date(),
      };
      for (const h of this.commandHandlers) {
        try { h(cmd); } catch (err) {
          process.stdout.write(`[cli] handler error: ${String(err)}\n`);
          this.writePrompt();
        }
      }
    });

    this.rl.on("close", () => {
      process.stdout.write("\n[cli] stdin closed\n");
    });

    ctx.logger.info(`[cli] adapter ready, prompting on stdin (user=${this.cfg.userId}, permission=${this.cfg.permission})`);
  }

  async dispose(): Promise<void> {
    this.rl?.close();
  }

  getSpec(): ChatSpec {
    return {
      type: "cli",
      id: this.id,
      data: {
        userId: this.cfg.userId,
        permission: this.cfg.permission,
        prompt: this.cfg.prompt,
      },
    };
  }

  async applySpec(next: ChatSpec): Promise<SpecApplyOutcome> {
    const applied: string[] = [];
    if (typeof next.data.userId === "string") {
      this.cfg = { ...this.cfg, userId: next.data.userId };
      applied.push("userId");
    }
    if (next.data.permission === "public" || next.data.permission === "member" || next.data.permission === "admin") {
      this.cfg = { ...this.cfg, permission: next.data.permission };
      applied.push("permission");
    }
    if (typeof next.data.prompt === "string") {
      this.cfg = { ...this.cfg, prompt: next.data.prompt };
      applied.push("prompt");
    }
    return { applied, failed: [] };
  }

  onCommand(handler: (c: ChatCommand) => void): Disposable {
    this.commandHandlers.push(handler);
    return {
      [Symbol.dispose]: () => {
        const i = this.commandHandlers.indexOf(handler);
        if (i >= 0) this.commandHandlers.splice(i, 1);
      },
    };
  }

  async reply(_cmd: ChatCommand, body: ChatBody): Promise<void> {
    process.stdout.write(`\n${body.text}\n`);
    this.writePrompt();
  }

  async notify(channel: ChannelRef, body: ChatBody): Promise<void> {
    process.stdout.write(`\n[notify ${channel.id}] ${body.text}\n`);
    this.writePrompt();
  }

  override getUserPermission(_userId: string): CommandPermission {
    return this.cfg.permission;
  }

  private writePrompt(): void {
    if (process.stdin.isTTY) process.stdout.write(this.cfg.prompt);
  }
}
