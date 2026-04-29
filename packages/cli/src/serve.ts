import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  EventBus, Queue, Supervisor, GitSync, HttpServer, Metrics,
  loadConfig, EnvSecrets, SqliteKvStore, createLogger,
  renderDashboard, ConfigStore, ReadinessGate,
  type AegisConfig,
} from "@aegis/core";
import { AgentWorker, SkillLoader, SynopsisMcpClient } from "@aegis/agent";
import type {
  CodeHostAdapter, ChatAdapter, PrEvent, AegisReview, ReviewJob, Logger,
  WebhookEndpoint, RepoEntry, CodeHostSpec, ChatSpec,
} from "@aegis/sdk";
import { AegisAdapterError } from "@aegis/sdk";
import { CommandRouter } from "./command-router.js";

export interface ServeOptions {
  /** Absolute path to the config file. Used for fs.watchFile. */
  configPath: string;
  /** Cache-busting loader. Returns the fresh raw config object on every call. */
  loader: () => unknown;
}

export async function serve(rawConfig: unknown, opts: ServeOptions): Promise<void> {
  const cfg = loadConfig(rawConfig) as AegisConfig;
  const logger = createLogger(cfg.logging.level, cfg.logging.format);
  const secrets = new EnvSecrets(logger);

  logger.info("[aegis] starting");

  await mkdir(path.dirname(cfg.dbPath), { recursive: true });
  await mkdir(cfg.workspace, { recursive: true });

  const bus = new EventBus();
  const queue = new Queue(cfg.dbPath);
  const gitSync = new GitSync(cfg.workspace, logger);

  // Readiness gate (ADR 0016). Three subsystems must come up before Aegis
  // accepts work. SQLite is ready as soon as the Queue construction returns.
  const readiness = new ReadinessGate(["sqlite", "synopsis", "mcp"]);
  readiness.markReady("sqlite");

  const mcp = new SynopsisMcpClient(cfg.synopsis.path ?? "/var/run/aegis/synopsis.sock", logger);

  const synopsisBin = cfg.synopsis.bin ?? process.env["SYNOPSIS_BIN"] ?? "/opt/aegis/bin/synopsis";
  const synopsisArgs = buildSynopsisArgs(cfg);
  const supervisor = new Supervisor({
    command: synopsisBin,
    args: synopsisArgs,
    logger,
    readySignal: "MCP server listening",
    onReady: () => {
      readiness.markReady("synopsis");
      mcp.connect()
        .then(() => readiness.markReady("mcp"))
        .catch(err => logger.error("[aegis] MCP connect failed", err));
    },
  });

  const reservedNs = "@@aegis:system";
  for (const host of cfg.codeHosts) {
    if (host.id === reservedNs) throw new Error(`code host id "${host.id}" is reserved`);
  }
  for (const chat of cfg.chats) {
    if (chat.id === reservedNs) throw new Error(`chat id "${chat.id}" is reserved`);
  }
  const systemStore = new SqliteKvStore(queue.db_instance(), reservedNs);

  // Live adapter instances. These survive config reload; their internal
  // state is updated via applySpec when the config changes. The configStore
  // tracks the "data" snapshot for non-adapter fields (agent, queue, etc.).
  const liveCodeHosts: CodeHostAdapter[] = cfg.codeHosts;
  const liveChats: ChatAdapter[] = cfg.chats;

  const skillLoader = new SkillLoader(cfg.skillsDir);
  const worker = new AgentWorker({
    config: cfg.agent,
    skillLoader,
    skillNames: cfg.skills,
    soulPath: cfg.soulPath,
    mcp,
    logger,
    store: systemStore,
  });
  await worker.init();

  const adapterCtx = (adapter: CodeHostAdapter) => ({
    logger,
    secrets,
    store: new SqliteKvStore(queue.db_instance(), adapter.id),
    clock: () => new Date(),
    config: {},
    emit: (e: import("@aegis/sdk").BusEvent) => bus.emit(e),
  });

  for (const host of liveCodeHosts) {
    await host.init(adapterCtx(host));
  }

  for (const host of liveCodeHosts) {
    const list = host.listRepos?.();
    if (!list) continue;
    const summary = list.map((e: RepoEntry) => e.source === "dynamic" ? `${e.name}*` : e.name).join(", ");
    logger.info(`[aegis] watching via ${host.id}: ${summary || "(none)"}`);
  }

  const metrics = new Metrics();
  metrics.gaugeProvider("aegis_queue_pending", "Pending jobs", () => queue.stats().pending);
  metrics.gaugeProvider("aegis_queue_running", "Jobs currently being processed", () => queue.stats().running);
  metrics.gaugeProvider("aegis_queue_dlq", "Jobs in the dead-letter queue", () => queue.stats().dlq);

  // ConfigStore: single source of truth for the live config snapshot. Also
  // owns file-watch + SIGHUP. The /reload command in CommandRouter calls into it.
  const configStore = new ConfigStore({
    configPath: opts.configPath,
    loader: opts.loader,
    initial: cfg,
    logger,
    notifyOps: async (text) => {
      const channel = configStore.get().queue.dlqChannel;
      if (!channel) return;
      for (const chat of liveChats) {
        await chat.notify({ id: channel }, { text }).catch(() => {});
      }
    },
  });

  const commandRouter = new CommandRouter({ queue, mcp, worker, cfg, logger, configStore });

  for (const chat of liveChats) {
    await chat.init({
      logger,
      secrets,
      store: new SqliteKvStore(queue.db_instance(), chat.id),
      clock: () => new Date(),
      config: {},
      emit: (e: import("@aegis/sdk").BusEvent) => bus.emit(e),
    });

    chat.onCommand((cmd: import("@aegis/sdk").ChatCommand) => {
      logger.info("[aegis] command", { user: cmd.user.id, text: cmd.text });
      void commandRouter.handle(cmd, chat).catch((err: unknown) => {
        logger.error("[aegis] command error", err);
      });
    });
  }

  // Wire ConfigStore subscriber to dispatch hot-reload changes into live
  // components. This MUST run before startWatching() so the first
  // file-driven reload doesn't fire into an empty subscriber list.
  configStore.subscribe(async (change, _oldCfg, newCfg) => {
    if (change.loggingChanged) {
      logger.setLevel?.(newCfg.logging.level);
      logger.info(`[aegis] log level changed to ${newCfg.logging.level}`);
    }
    if (change.agentChanged) {
      const result = await worker.applyConfig(newCfg.agent);
      logger.info(`[aegis] agent config applied: [${result.applied.join(",")}]`);
      if (result.droppedOverride) {
        const channel = newCfg.queue.dlqChannel;
        if (channel) {
          const text = `Aegis dropped saved model override ${result.droppedOverride.provider}/${result.droppedOverride.modelId}: ${result.droppedOverride.reason}. Reverted to default ${newCfg.agent.provider}/${newCfg.agent.model}.`;
          for (const chat of liveChats) await chat.notify({ id: channel }, { text }).catch(() => {});
        }
      }
    }
    if (change.skillsChanged) {
      await worker.reloadSkills(newCfg.skills);
    }
    for (const [id, spec] of change.codeHostSpecs) {
      const live = liveCodeHosts.find(a => a.id === id);
      if (!live) continue;
      const aware = live as unknown as { applySpec?: (s: CodeHostSpec) => Promise<unknown> };
      if (aware.applySpec) await aware.applySpec(spec);
    }
    for (const [id, spec] of change.chatSpecs) {
      const live = liveChats.find(a => a.id === id);
      if (!live) continue;
      const aware = live as unknown as { applySpec?: (s: ChatSpec) => Promise<unknown> };
      if (aware.applySpec) await aware.applySpec(spec);
    }
  });

  configStore.startWatching();

  supervisor.start();

  const recovered = queue.recoverOrphaned();
  if (recovered > 0) {
    logger.warn(`[aegis] recovered ${recovered} job(s) left in 'running' from a previous run`);
  }

  const subscribers = subscribeWebhookEnqueue(liveCodeHosts, queue, bus, metrics, logger);
  const polling = startPolling(liveCodeHosts, configStore, queue, bus, metrics, readiness, logger);
  const workerLoop = startWorkerLoop(queue, worker, gitSync, bus, metrics, configStore, liveCodeHosts, liveChats, logger);
  notifyOnReview(bus, configStore, liveChats, logger);

  const httpServer = await maybeStartHttpServer(cfg, secrets, metrics, queue, worker, configStore, readiness, liveCodeHosts, logger);

  logger.info("[aegis] running");

  await waitForShutdown(async () => {
    logger.info("[aegis] shutting down");
    if (httpServer) await httpServer.stop().catch((err) => logger.warn("[aegis] http stop failed", err));
    configStore.stop();
    polling.stop();
    workerLoop.stop();
    for (const d of subscribers) d[Symbol.dispose]();
    await workerLoop.drain(30_000).catch((err) => {
      logger.warn("[aegis] drain timed out, in-flight jobs will be recovered on next start", err);
    });
    supervisor.stop();
    mcp.disconnect();
    for (const host of liveCodeHosts) await host.dispose();
    for (const chat of liveChats) await chat.dispose();
  });
}

async function maybeStartHttpServer(
  cfg: AegisConfig,
  secrets: EnvSecrets,
  metrics: Metrics,
  queue: Queue,
  worker: AgentWorker,
  configStore: ConfigStore,
  readiness: ReadinessGate,
  liveCodeHosts: CodeHostAdapter[],
  logger: Logger,
): Promise<HttpServer | null> {
  if (!cfg.http) return null;

  const webhookRoutes = new Map<string, WebhookEndpoint>();
  for (const host of liveCodeHosts) {
    if (!host.webhook) continue;
    if (webhookRoutes.has(host.webhook.path)) {
      throw new Error(`webhook path collision: "${host.webhook.path}" is claimed by multiple adapters`);
    }
    webhookRoutes.set(host.webhook.path, host.webhook);
    logger.info(`[aegis] webhook route ${host.webhook.path} -> ${host.id}`);
  }

  const dashboard = () => renderDashboard({
    generatedAt: new Date(),
    model: worker.getModelInfo(),
    queue: queue.stats(),
    adapters: liveCodeHosts.map(h => ({ id: h.id, host: hostFor(h), repos: h.listRepos?.() ?? [] })),
    dlq: queue.listDlq(50),
    audit: queue.recentAudit(50),
    reload: configStore.getStatus(),
    startup: { ready: readiness.isReady(), pending: readiness.pending() },
  });

  const server = new HttpServer({
    port: cfg.http.port,
    bindAddr: cfg.http.bindAddr,
    logger,
    webhooks: webhookRoutes,
    metrics: () => metrics.render(),
    dashboard,
    readinessGate: readiness,
    ...(cfg.http.metricsTokenEnv ? { metricsToken: secrets.get(cfg.http.metricsTokenEnv) } : {}),
  });
  await server.start();
  return server;
}

function hostFor(host: CodeHostAdapter): string {
  return readAdapterHost(host) ?? host.id;
}

/** Read the configured hostname from an adapter's spec, if it exposes one. */
function readAdapterHost(host: CodeHostAdapter): string | null {
  const aware = host as unknown as { getSpec?: () => { data?: { host?: string } } };
  if (typeof aware.getSpec === "function") {
    const spec = aware.getSpec();
    if (typeof spec.data?.host === "string") return spec.data.host;
  }
  const cfg = (host as unknown as { cfg?: { host?: string } }).cfg;
  return cfg?.host ?? null;
}

function subscribeWebhookEnqueue(
  hosts: CodeHostAdapter[],
  queue: Queue,
  bus: EventBus,
  metrics: Metrics,
  logger: Logger,
): Disposable[] {
  const out: Disposable[] = [];
  for (const host of hosts) {
    if (!host.subscribe) continue;
    const d = host.subscribe((event) => {
      metrics.counter("aegis_webhook_received_total", "Webhook events received", { adapter: host.id, kind: event.kind });
      const job = queue.enqueue(event.ref);
      if (job) {
        metrics.counter("aegis_jobs_enqueued_total", "Jobs enqueued", { source: "webhook", adapter: host.id });
        logger.info(`[aegis] webhook enqueued PR ${event.ref.owner}/${event.ref.repo}#${event.ref.number}`);
        queue.audit(job.id, "enqueued", `webhook from ${host.id}`);
        bus.emit({ kind: "pr", event });
      }
    });
    out.push(d);
  }
  return out;
}

interface PollingHandle { stop(): void }

function startPolling(hosts: CodeHostAdapter[], configStore: ConfigStore, queue: Queue, bus: EventBus, metrics: Metrics, readiness: ReadinessGate, logger: Logger): PollingHandle {
  // Each adapter polls on its own schedule. The interval is read fresh from the
  // adapter's getSpec() each tick so a hot-reloaded pollIntervalSec takes effect
  // on the next iteration. The first cycle is delayed until the readiness gate
  // opens (ADR 0016) so we do not enqueue jobs before MCP is connected.
  const timeouts = new Map<string, NodeJS.Timeout>();
  let stopped = false;

  for (const host of hosts) {
    let inflight = false;
    const poll = async () => {
      if (stopped || inflight) return;
      inflight = true;
      try {
        for await (const event of host.pollPullRequests()) {
          if (stopped) break;
          const job = queue.enqueue(event.ref);
          if (job) {
            metrics.counter("aegis_jobs_enqueued_total", "Jobs enqueued", { source: "poll", adapter: host.id });
            logger.info(`[aegis] enqueued PR ${event.ref.owner}/${event.ref.repo}#${event.ref.number}`);
            queue.audit(job.id, "enqueued", `from ${host.id}`);
            bus.emit({ kind: "pr", event });
          }
        }
      } catch (err) {
        logger.error(`[aegis] poll error from ${host.id}`, err);
      } finally {
        inflight = false;
        if (stopped) return;
        const intervalSec = readPollInterval(host) ?? 60;
        timeouts.set(host.id, setTimeout(() => void poll(), intervalSec * 1000));
      }
    };

    // Defer the first poll cycle until the readiness gate opens.
    readiness.whenReady().then(() => {
      if (stopped) return;
      logger.info(`[aegis] readiness reached, starting poll loop for ${host.id}`);
      void poll();
    });
  }

  void configStore;

  return {
    stop: () => {
      stopped = true;
      for (const t of timeouts.values()) clearTimeout(t);
    },
  };
}

function readPollInterval(host: CodeHostAdapter): number | null {
  const aware = host as unknown as { getSpec?: () => { data?: { pollIntervalSec?: number } } };
  if (typeof aware.getSpec === "function") {
    const spec = aware.getSpec();
    if (typeof spec.data?.pollIntervalSec === "number") return spec.data.pollIntervalSec;
  }
  return null;
}

interface WorkerLoopHandle {
  stop(): void;
  drain(timeoutMs: number): Promise<void>;
}

function startWorkerLoop(
  queue: Queue,
  worker: AgentWorker,
  gitSync: GitSync,
  bus: EventBus,
  metrics: Metrics,
  configStore: ConfigStore,
  liveCodeHosts: CodeHostAdapter[],
  liveChats: ChatAdapter[],
  logger: Logger,
): WorkerLoopHandle {
  let running = 0;
  let stopped = false;
  /**
   * Per-repo serialization (ARCHITECTURE.md): jobs for a repo already in
   * flight do not get a second worker. Different repos still run in
   * parallel up to `agent.concurrency`. The set holds `host/owner/repo`
   * fqns; matching values are passed to `queue.claim` to skip those repos.
   */
  const inflightRepos = new Set<string>();

  const tick = () => {
    if (stopped) return;
    const cfg = configStore.get();
    const maxAttempts = cfg.queue.retries + 1;
    while (running < cfg.agent.concurrency) {
      const exclude = [...inflightRepos];
      const job = queue.claim(maxAttempts, exclude);
      if (!job) break;

      const repoFqn = `${job.ref.host}/${job.ref.owner}/${job.ref.repo}`;
      inflightRepos.add(repoFqn);
      running++;
      void processJob(job, queue, worker, gitSync, bus, metrics, configStore, liveCodeHosts, liveChats, logger)
        .finally(() => {
          inflightRepos.delete(repoFqn);
          running--;
          tick();
        });
    }
  };

  const interval = setInterval(tick, 2_000);
  tick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
    drain: (timeoutMs) => new Promise<void>((resolve, reject) => {
      const start = Date.now();
      let done = false;
      const check = () => {
        if (done) return;
        if (running === 0) { done = true; return resolve(); }
        if (Date.now() - start >= timeoutMs) {
          done = true;
          return reject(new Error(`drain timed out with ${running} in-flight`));
        }
        setTimeout(check, 200);
      };
      check();
    }),
  };
}

async function processJob(
  job: ReviewJob,
  queue: Queue,
  worker: AgentWorker,
  gitSync: GitSync,
  bus: EventBus,
  metrics: Metrics,
  configStore: ConfigStore,
  liveCodeHosts: CodeHostAdapter[],
  liveChats: ChatAdapter[],
  logger: Logger,
): Promise<void> {
  const { ref } = job;
  logger.info(`[worker] processing ${ref.owner}/${ref.repo}#${ref.number}`, { jobId: job.id });

  try {
    // Look up by exact match: first try adapter id, then the adapter's spec
    // data.host (e.g. "github.com"). Avoid substring matching - two adapters
    // where one id is a substring of another would silently collide.
    const host = liveCodeHosts.find(h => h.id === ref.host)
      ?? liveCodeHosts.find(h => readAdapterHost(h) === ref.host);
    if (!host) throw new Error(`No adapter for host ${ref.host}`);

    const diff = await host.fetchDiff(ref);
    const cloneSpec = host.getCloneSpec(ref);
    const repoPath = await gitSync.ensureClone(ref.host, ref.owner, ref.repo, cloneSpec);
    await gitSync.fetchAndCheckout(repoPath, ref.headSha, cloneSpec);

    const review = await worker.review(job, diff, repoPath);

    await host.postReview(ref, review);

    if (review.markdownReport) {
      await host.postInlineReport(ref, "cross-repo-impact.md", review.markdownReport);
    }

    queue.complete(job.id);
    queue.audit(job.id, "done", `severity=${review.severity}`);
    metrics.counter("aegis_jobs_completed_total", "Jobs completed", { severity: review.severity });
    logger.info(`[worker] done ${ref.owner}/${ref.repo}#${ref.number} severity=${review.severity}`);

    bus.emit({ kind: "review-done", jobId: job.id, ref, review });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cfg = configStore.get();

    if (err instanceof AegisAdapterError && err.error.kind === "rate-limited") {
      const retryAfter = err.error.retryAfterSec;
      const outcome = queue.delayRetry(job.id, retryAfter);
      if (outcome === "dlq") {
        queue.audit(job.id, "dlq", `gave up after repeated rate-limit defers from ${ref.host}`);
        metrics.counter("aegis_jobs_dlq_total", "Jobs sent to DLQ", { adapter: ref.host });
        logger.error(`[worker] DLQ after repeated rate-limit defers from ${ref.host}`, { jobId: job.id });
        bus.emit({ kind: "review-failed", jobId: job.id, ref, error: `rate-limited repeatedly by ${ref.host}` });
      } else {
        queue.audit(job.id, "rate-limited", `retry after ${retryAfter}s`);
        metrics.counter("aegis_jobs_rate_limited_total", "Jobs deferred due to upstream rate limit", { adapter: ref.host });
        logger.warn(`[worker] rate-limited by ${ref.host}, deferring ${retryAfter}s`, { jobId: job.id });
      }
      return;
    }

    logger.error(`[worker] job failed`, { jobId: job.id, error: message });
    const outcome = queue.fail(job.id, message, cfg.queue.retries + 1);
    queue.audit(job.id, outcome === "dlq" ? "dlq" : "failed", message);
    metrics.counter(outcome === "dlq" ? "aegis_jobs_dlq_total" : "aegis_jobs_failed_total", outcome === "dlq" ? "Jobs sent to DLQ" : "Jobs failed (will retry)", { adapter: ref.host });
    bus.emit({ kind: "review-failed", jobId: job.id, ref, error: message });

    if (outcome === "dlq" && cfg.queue.dlqChannel) {
      for (const chat of liveChats) {
        await chat.notify({ id: cfg.queue.dlqChannel }, {
          text: `Aegis job failed (DLQ): ${ref.owner}/${ref.repo}#${ref.number} - ${message}`,
        }).catch(() => {});
      }
    }
  }
}

function notifyOnReview(bus: EventBus, configStore: ConfigStore, liveChats: ChatAdapter[], logger: Logger): void {
  bus.subscribe(event => {
    if (event.kind !== "review-done") return;
    notifyChats(configStore, liveChats, event.review, event.ref, logger);
  });
}

function notifyChats(configStore: ConfigStore, liveChats: ChatAdapter[], review: AegisReview, ref: ReviewJob["ref"], logger: Logger): void {
  // Each chat adapter declares its own notifyOn list via getSpec(); after a
  // hot reload, that list reflects the latest config without any restart.
  void configStore;
  const prLabel = `${ref.owner}/${ref.repo}#${ref.number}`;
  const text = `Aegis: ${review.severity} severity review on ${prLabel} - ${review.summary.slice(0, 200)}`;

  for (const chat of liveChats) {
    const spec = readChatSpec(chat);
    const notifyOn = spec?.data.notifyOn;
    if (Array.isArray(notifyOn) && notifyOn.length > 0 && !notifyOn.includes(review.severity)) continue;

    const channels = (spec?.data.channels as string[] | undefined) ?? [];
    for (const channel of channels) {
      chat.notify({ id: channel }, { text }).catch((err: unknown) => {
        logger.warn("[aegis] notify failed", err);
      });
    }
  }
}

function readChatSpec(chat: ChatAdapter): ChatSpec | null {
  const aware = chat as unknown as { getSpec?: () => ChatSpec };
  if (typeof aware.getSpec === "function") return aware.getSpec();
  return null;
}

function buildSynopsisArgs(cfg: AegisConfig): string[] {
  const { synopsis } = cfg;
  const args = ["mcp", "--root", cfg.workspace, "--state-dir", synopsis.stateDir];
  if (synopsis.transport === "unix" && synopsis.path) {
    args.push("--socket", synopsis.path);
  } else if (synopsis.transport === "tcp" && synopsis.host && synopsis.port) {
    args.push("--tcp", `${synopsis.host}:${synopsis.port}`);
  }
  return args;
}

async function waitForShutdown(cleanup: () => Promise<void>): Promise<void> {
  return new Promise(resolve => {
    // Cleanup must run exactly once even if SIGINT and SIGTERM arrive in
    // quick succession. Concurrent cleanup would race workerLoop.drain and
    // could double-close SQLite handles.
    let cleaningUp = false;
    const handle = async (signal: string) => {
      if (cleaningUp) {
        console.log(`[aegis] already shutting down, ignoring ${signal}`);
        return;
      }
      cleaningUp = true;
      console.log(`\n[aegis] received ${signal}`);
      await cleanup();
      resolve();
    };
    process.once("SIGINT", () => void handle("SIGINT"));
    process.once("SIGTERM", () => void handle("SIGTERM"));
  });
}
