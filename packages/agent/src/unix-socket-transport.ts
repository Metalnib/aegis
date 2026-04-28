import net from "node:net";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export class UnixSocketTransport implements Transport {
  private socket: net.Socket | null = null;
  private buffer = "";
  private closed = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly socketPath: string) {}

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath, () => resolve());
      socket.on("error", (err: Error) => {
        this.onerror?.(err);
        reject(err);
      });
      socket.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf-8")));
      socket.on("close", () => this.fireClose());
      this.socket = socket;
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const socket = this.socket;
    if (!socket) throw new Error("UnixSocketTransport not started");
    return new Promise<void>((resolve, reject) => {
      socket.write(JSON.stringify(message) + "\n", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    this.fireClose();
  }

  private fireClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket = null;
    this.onclose?.();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JSONRPCMessage;
        this.onmessage?.(msg);
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}
