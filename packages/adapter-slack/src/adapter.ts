import { App, type AppOptions } from "@slack/bolt";
import type {
  ChatAdapter, AdapterContext,
  ChatCommand, ChatBody, ChannelRef,
  ChatSpec, SpecApplyOutcome,
} from "@aegis/sdk";
import { ChatAdapterBase } from "@aegis/sdk";

export interface SlackConfig {
  id?: string;
  channels: string[];
  notifyOn: string[];
  socketMode?: boolean;
  botTokenEnv?: string;
  appTokenEnv?: string;
  signingSecretEnv?: string;
  permissions?: {
    memberUsers?: string[];
    adminUsers?: string[];
  };
}

export function slack(cfg: SlackConfig): ChatAdapter {
  return new SlackAdapter(cfg);
}

export class SlackAdapter extends ChatAdapterBase {
  readonly id: string;
  protected readonly tier3SpecKeys = new Set([
    "socketMode", "botTokenEnv", "appTokenEnv", "signingSecretEnv",
  ]);

  private app!: App;
  private ctx!: AdapterContext;
  private commandHandlers: Array<(c: ChatCommand) => void> = [];
  private cfg: SlackConfig & { id: string };

  constructor(cfg: SlackConfig) {
    super();
    this.cfg = { ...cfg, id: cfg.id ?? "slack" };
    this.id = this.cfg.id;
  }

  async init(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    const botToken = ctx.secrets.get(this.cfg.botTokenEnv ?? "SLACK_BOT_TOKEN");

    const opts: AppOptions = { token: botToken };

    if (this.cfg.socketMode !== false) {
      const appToken = ctx.secrets.get(this.cfg.appTokenEnv ?? "SLACK_APP_TOKEN");
      opts.socketMode = true;
      opts.appToken = appToken;
    } else {
      opts.signingSecret = ctx.secrets.get(this.cfg.signingSecretEnv ?? "SLACK_SIGNING_SECRET");
    }

    this.app = new App(opts);

    this.app.message(/^@?aegis\s+(.+)/i, async ({ message, say }) => {
      const msg = message as { text?: string; user?: string; channel?: string; ts?: string };
      const text = msg.text ?? "";
      const match = text.match(/^@?aegis\s+(.+)/i);
      const commandText = match?.[1]?.trim() ?? text;
      const userId = msg.user ?? "unknown";

      if (!this.isAllowed(userId)) {
        await say("Sorry, you don't have permission to run Aegis commands.");
        return;
      }

      const cmd: ChatCommand = {
        channel: { id: msg.channel ?? "", ...(msg.channel !== undefined ? { name: msg.channel } : {}) },
        user: { id: userId },
        text: commandText,
        ...(msg.ts !== undefined ? { threadRef: msg.ts } : {}),
        receivedAt: new Date(),
      };

      for (const h of this.commandHandlers) {
        try { h(cmd); } catch { /* handler errors don't kill the bot */ }
      }
    });

    await this.app.start();
    ctx.logger.info(`[slack] adapter started (channels: ${this.cfg.channels.length}, notifyOn: ${this.cfg.notifyOn.join(",")})`);
  }

  async dispose(): Promise<void> {
    await this.app?.stop();
  }

  getSpec(): ChatSpec {
    return {
      type: "slack",
      id: this.id,
      data: {
        channels: [...this.cfg.channels].sort(),
        notifyOn: [...this.cfg.notifyOn].sort(),
        socketMode: this.cfg.socketMode !== false,
        botTokenEnv: this.cfg.botTokenEnv ?? "SLACK_BOT_TOKEN",
        appTokenEnv: this.cfg.appTokenEnv ?? null,
        signingSecretEnv: this.cfg.signingSecretEnv ?? null,
        permissions: {
          memberUsers: [...(this.cfg.permissions?.memberUsers ?? [])].sort(),
          adminUsers: [...(this.cfg.permissions?.adminUsers ?? [])].sort(),
        },
      },
    };
  }

  async applySpec(next: ChatSpec): Promise<SpecApplyOutcome> {
    const applied: string[] = [];
    const failed: Array<{ key: string; reason: string }> = [];

    if (Array.isArray(next.data.channels)) {
      this.cfg = { ...this.cfg, channels: next.data.channels as string[] };
      applied.push("channels");
    }
    if (Array.isArray(next.data.notifyOn)) {
      this.cfg = { ...this.cfg, notifyOn: next.data.notifyOn as string[] };
      applied.push("notifyOn");
    }
    if (next.data.permissions && typeof next.data.permissions === "object") {
      const p = next.data.permissions as { memberUsers?: string[]; adminUsers?: string[] };
      this.cfg = {
        ...this.cfg,
        permissions: {
          memberUsers: p.memberUsers ?? [],
          adminUsers: p.adminUsers ?? [],
        },
      };
      applied.push("permissions");
    }

    return { applied, failed };
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

  async reply(cmd: ChatCommand, body: ChatBody): Promise<void> {
    await this.app.client.chat.postMessage({
      channel: cmd.channel.id,
      ...(cmd.threadRef !== undefined ? { thread_ts: cmd.threadRef } : {}),
      text: body.text,
      ...(body.markdown ? { blocks: [{ type: "section", text: { type: "mrkdwn", text: body.markdown } }] } : {}),
    });
  }

  async notify(channel: ChannelRef, body: ChatBody): Promise<void> {
    await this.app.client.chat.postMessage({
      channel: channel.id,
      text: body.text,
      ...(body.markdown ? { blocks: [{ type: "section", text: { type: "mrkdwn", text: body.markdown } }] } : {}),
    });
  }

  override getUserPermission(userId: string): "public" | "member" | "admin" {
    const { adminUsers = [], memberUsers = [] } = this.cfg.permissions ?? {};
    if (adminUsers.includes(userId)) return "admin";
    if (memberUsers.includes(userId)) return "member";
    return "public";
  }

  private isAllowed(userId: string): boolean {
    return this.getUserPermission(userId) !== "public";
  }
}
