import type { ChatAdapter, AdapterContext, ChatCommand, ChatBody, ChannelRef, ChatSpec, SpecApplyOutcome } from "@aegis/sdk";
import { ChatAdapterBase } from "@aegis/sdk";

export interface GChatSpaceConfig {
  /** Google Chat space resource name, e.g. "spaces/AAABBB" */
  id: string;
  /** Env var holding the incoming webhook URL for this space */
  webhookUrlEnv: string;
}

export interface GChatConfig {
  id?: string;
  spaces: GChatSpaceConfig[];
  /** Severity levels that trigger a notification. Defaults to all. */
  notifyOn?: string[];
}

export function gchat(cfg: GChatConfig): ChatAdapter {
  return new GChatAdapter(cfg);
}

/**
 * Google Chat adapter - outgoing notifications via incoming webhooks.
 *
 * Interactive commands (receiving @mentions) require a Google Cloud App
 * with Pub/Sub or HTTP endpoint configured. That is out of scope for P2 -
 * GChat is notification-only. See docs/adapters.md for the full bot setup.
 */
export class GChatAdapter extends ChatAdapterBase {
  readonly id: string;
  /**
   * Tier 3: spaces and webhookUrlEnv changes require restart because secrets
   * are read at init() time and webhook URLs aren't re-resolvable hot.
   */
  protected readonly tier3SpecKeys = new Set(["spaces"]);

  private webhooks = new Map<string, string>();
  private cfg: GChatConfig & { id: string };

  constructor(cfg: GChatConfig) {
    super();
    this.cfg = { ...cfg, id: cfg.id ?? "gchat" };
    this.id = this.cfg.id;
  }

  async init(ctx: AdapterContext): Promise<void> {
    for (const space of this.cfg.spaces) {
      const url = ctx.secrets.get(space.webhookUrlEnv);
      this.webhooks.set(space.id, url);
    }
    ctx.logger.info(`[gchat] initialised with ${this.cfg.spaces.length} spaces (notification-only)`);
  }

  async dispose(): Promise<void> {}

  getSpec(): ChatSpec {
    return {
      type: "gchat",
      id: this.id,
      data: {
        spaces: [...this.cfg.spaces].sort((a, b) => a.id.localeCompare(b.id)),
        notifyOn: [...(this.cfg.notifyOn ?? [])].sort(),
      },
    };
  }

  async applySpec(next: ChatSpec): Promise<SpecApplyOutcome> {
    const applied: string[] = [];
    const failed: Array<{ key: string; reason: string }> = [];
    if (Array.isArray(next.data.notifyOn)) {
      this.cfg = { ...this.cfg, notifyOn: next.data.notifyOn as string[] };
      applied.push("notifyOn");
    }
    return { applied, failed };
  }

  onCommand(_handler: (c: ChatCommand) => void): Disposable {
    return { [Symbol.dispose]: () => {} };
  }

  override getUserPermission(_userId: string): "public" | "member" | "admin" {
    return "public";
  }

  async reply(cmd: ChatCommand, body: ChatBody): Promise<void> {
    await this.notify(cmd.channel, body);
  }

  async notify(channel: ChannelRef, body: ChatBody): Promise<void> {
    const url = this.webhooks.get(channel.id);
    if (!url) return;

    const payload: { text: string; cards?: unknown[] } = { text: body.text };

    if (body.markdown) {
      payload.cards = [{
        sections: [{ widgets: [{ textParagraph: { text: body.markdown } }] }],
      }];
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`[gchat] webhook POST failed: HTTP ${res.status}`);
    }
  }
}
