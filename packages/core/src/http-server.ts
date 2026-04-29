import http from "node:http";
import crypto from "node:crypto";
import type { Logger, WebhookEndpoint } from "@aegis/sdk";
import type { ReadinessGate } from "./readiness.js";

export interface HttpServerOptions {
  port: number;
  bindAddr?: string;
  logger: Logger;
  /** Map of path -> webhook handler. Paths must start with "/". */
  webhooks: Map<string, WebhookEndpoint>;
  /** Callback for GET /metrics. Returns prom-text body. */
  metrics?: () => string;
  /** Callback for GET /dashboard. Returns HTML. Reuses metricsToken when set. */
  dashboard?: () => string;
  /** Optional shared-secret for /metrics and /dashboard, sent as Authorization: Bearer <token>. */
  metricsToken?: string;
  /**
   * Readiness gate. When provided, /healthz returns 503 + JSON listing
   * pending subsystems while not ready, and webhook POSTs return 503
   * "starting". See ADR 0016.
   */
  readinessGate?: ReadinessGate;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB - generous for PR webhooks, capped to deny abuse.
const READ_TIMEOUT_MS = 10_000;

export class HttpServer {
  private server: http.Server | null = null;

  constructor(private readonly opts: HttpServerOptions) {
    // /metrics and /dashboard expose queue contents and audit log; refuse to
    // start if either is enabled without a token. Operators that genuinely
    // want public access can set the token to a known sentinel and document
    // it; the explicit choice is the point.
    if ((opts.metrics || opts.dashboard) && !opts.metricsToken) {
      throw new Error(
        "HttpServer: metrics/dashboard are enabled but metricsToken is not set. " +
        "Set http.metricsTokenEnv in your aegis.config.ts to gate these endpoints.",
      );
    }
  }

  async start(): Promise<void> {
    const { port, bindAddr = "0.0.0.0", logger } = this.opts;
    this.server = http.createServer((req, res) => this.handle(req, res));
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, bindAddr, () => {
        logger.info(`[http] listening on ${bindAddr}:${port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    return new Promise((resolve) => {
      server.close(() => resolve());
      // node http.close waits for keep-alive sockets to drain - force after 5s.
      setTimeout(() => server.closeAllConnections?.(), 5_000).unref();
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { logger, webhooks, metrics, dashboard, metricsToken, readinessGate } = this.opts;
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    const requireToken = (): boolean => {
      if (!metricsToken) return true;
      const auth = req.headers.authorization ?? "";
      return constantTimeStringEqual(auth, `Bearer ${metricsToken}`);
    };

    try {
      if (method === "GET" && url === "/healthz") {
        if (readinessGate && !readinessGate.isReady()) {
          const body = JSON.stringify({ status: "not-ready", pending: readinessGate.pending() });
          return send(res, 503, body, "application/json");
        }
        return send(res, 200, "ok");
      }
      if (method === "GET" && url === "/metrics") {
        if (!requireToken()) return send(res, 401, "unauthorized");
        return send(res, 200, metrics ? metrics() : "", "text/plain; version=0.0.4");
      }
      if (method === "GET" && url === "/dashboard") {
        if (!dashboard) return send(res, 404, "dashboard not enabled");
        if (!requireToken()) return send(res, 401, "unauthorized");
        return send(res, 200, dashboard(), "text/html; charset=utf-8");
      }

      if (method === "POST") {
        const endpoint = webhooks.get(url);
        if (!endpoint) return send(res, 404, "not found");

        // Webhook intake is gated on readiness: 503 during boot is the
        // documented contract (ARCHITECTURE.md "Tradeoff: 503 vs buffer-and-replay").
        // GitHub and GitLab retry 5xx automatically.
        if (readinessGate && !readinessGate.isReady()) {
          const body = JSON.stringify({ status: "starting", pending: readinessGate.pending() });
          return send(res, 503, body, "application/json");
        }

        const body = await readBody(req);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string") headers[k.toLowerCase()] = v;
          else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(",");
        }

        const result = await endpoint.handle({ method, headers, body });
        return send(res, result.status, result.body ?? "");
      }

      send(res, 405, "method not allowed");
    } catch (err) {
      logger.error("[http] handler error", err);
      if (!res.headersSent) send(res, 500, "internal error");
    }
  }
}

function send(res: http.ServerResponse, status: number, body: string, contentType = "text/plain"): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

/**
 * Constant-time string equality that does not leak the length of either
 * input via timing. Naive `if (a.length !== b.length) return false` reveals
 * the secret length to an attacker who can vary their input. We HMAC both
 * inputs with a per-call random key, then compare the fixed-size HMACs:
 * input length no longer affects the time-to-decision.
 */
function constantTimeStringEqual(a: string, b: string): boolean {
  const key = crypto.randomBytes(32);
  const aMac = crypto.createHmac("sha256", key).update(a).digest();
  const bMac = crypto.createHmac("sha256", key).update(b).digest();
  return crypto.timingSafeEqual(aMac, bMac);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (err?: Error, buf?: Buffer) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(buf!);
    };

    const timer = setTimeout(() => {
      req.destroy();
      finish(new Error("body read timeout"));
    }, READ_TIMEOUT_MS);

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        clearTimeout(timer);
        finish(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      clearTimeout(timer);
      finish(undefined, Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      finish(err);
    });
  });
}
