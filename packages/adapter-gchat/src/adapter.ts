import type { ChatAdapter, AdapterContext, ChatCommand, ChatBody, ChannelRef } from "@aegis/sdk";

export interface GChatSpaceConfig {
  /** Google Chat space resource name, e.g. "spaces/AAABBB" */
  id: string;
  /** Env var holding the incoming webhook URL for this space */
  webhookUrlEnv: string;
}

export interface GChatConfig {
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
export class GChatAdapter implements ChatAdapter {
  readonly id = "gchat";
  private webhooks = new Map<string, string>();

  constructor(private readonly cfg: GChatConfig) {}

  async init(ctx: AdapterContext): Promise<void> {
    for (const space of this.cfg.spaces) {
      const url = ctx.secrets.get(space.webhookUrlEnv);
      this.webhooks.set(space.id, url);
    }
    ctx.logger.info(`[gchat] initialised with ${this.cfg.spaces.length} spaces (notification-only)`);
  }

  async dispose(): Promise<void> {}

  onCommand(_handler: (c: ChatCommand) => void): Disposable {
    // GChat interactive commands require App registration in Google Cloud.
    // Commands are not supported in this adapter.
    return { [Symbol.dispose]: () => {} };
  }

  getUserPermission(_userId: string): "public" | "member" | "admin" {
    return "public";
  }

  async reply(cmd: ChatCommand, body: ChatBody): Promise<void> {
    // No thread tracking without a full GChat bot setup - post to the space.
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
