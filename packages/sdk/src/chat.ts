import type { AdapterContext } from "./context.js";

export interface ChannelRef {
  id: string;
  name?: string;
}

export interface UserRef {
  id: string;
  name?: string;
}

export interface ChatCommand {
  channel: ChannelRef;
  user: UserRef;
  text: string;
  threadRef?: string;
  receivedAt: Date;
}

export interface ChatAttachment {
  filename: string;
  content: string;
  mimeType?: string;
}

export interface ChatBody {
  text: string;
  markdown?: string;
  attachments?: ChatAttachment[];
}

export type CommandPermission = "public" | "member" | "admin";

export interface ChatAdapter {
  readonly id: string;
  init(ctx: AdapterContext): Promise<void>;
  dispose(): Promise<void>;

  onCommand(handler: (c: ChatCommand) => void): Disposable;

  /**
   * Return the effective permission level for a user.
   * Adapters that have no permission model return "public".
   */
  getUserPermission?(userId: string): CommandPermission;

  reply(cmd: ChatCommand, body: ChatBody): Promise<void>;
  notify(channel: ChannelRef, body: ChatBody): Promise<void>;
}
