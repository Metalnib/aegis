import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@mariozechner/pi-ai";
import type { Logger } from "@aegis/sdk";
import { UnixSocketTransport } from "./unix-socket-transport.js";

interface McpTool {
  name: string;
  description?: string;
  inputSchema: { type: "object"; [key: string]: unknown };
}

interface McpCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export class SynopsisMcpClient {
  private client: Client | null = null;
  private agentTools: AgentTool[] = [];
  private connecting: Promise<void> | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly logger: Logger,
  ) {}

  async connect(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const transport = new UnixSocketTransport(this.socketPath);
      const client = new Client({ name: "aegis", version: "0.1.0" });
      try {
        await client.connect(transport);
      } catch (err) {
        this.connecting = null;
        throw err;
      }
      this.client = client;
      this.logger.info("[mcp] connected to Synopsis");
      try {
        await this.discoverTools();
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  disconnect(): void {
    this.client?.close().catch(() => undefined);
    this.client = null;
    this.agentTools = [];
    this.connecting = null;
  }

  private async discoverTools(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const result = await client.listTools();
    this.agentTools = (result.tools as McpTool[]).map(t => this.toAgentTool(t, client));
    this.logger.info(`[mcp] discovered ${this.agentTools.length} tools`);
  }

  private toAgentTool(tool: McpTool, client: Client): AgentTool {
    return {
      name: tool.name,
      label: tool.name,
      description: tool.description ?? tool.name,
      parameters: tool.inputSchema as unknown as TSchema,
      execute: async (_id, params) => {
        const raw = await client.callTool({
          name: tool.name,
          arguments: params as Record<string, unknown>,
        });
        const result = raw as unknown as McpCallResult;
        const text = result.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
          .map(c => c.text)
          .join("\n");
        if (result.isError) throw new Error(text || `${tool.name} returned an error`);
        return { content: [{ type: "text", text }], details: result };
      },
    };
  }

  getAgentTools(): AgentTool[] {
    return this.agentTools;
  }

  async callTool(name: string, params?: Record<string, unknown>): Promise<unknown> {
    const client = this.client;
    if (!client) throw new Error("SynopsisMcpClient not connected");
    return client.callTool({ name, arguments: params ?? {} });
  }
}
