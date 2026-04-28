import type { AuditEntry, DlqEntry } from "./queue.js";
import type { RepoEntry } from "@aegis/sdk";

export interface DashboardData {
  generatedAt: Date;
  model: { provider: string; modelId: string; isOverride: boolean; configProvider: string; configModelId: string };
  queue: { pending: number; running: number; done: number; dlq: number };
  adapters: Array<{ id: string; host: string; repos: RepoEntry[] }>;
  dlq: DlqEntry[];
  audit: AuditEntry[];
}

/**
 * Render a self-contained read-only HTML page summarizing Aegis state.
 * No JS, no external CSS - just an inline stylesheet so it works behind
 * locked-down corporate proxies. Auto-refreshes every 30 seconds.
 */
export function renderDashboard(data: DashboardData): string {
  const css = `
    body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f5f5f7; color: #1d1d1f; }
    header { background: #1d1d1f; color: #fff; padding: 16px 24px; }
    header h1 { margin: 0; font-size: 20px; font-weight: 600; }
    header .meta { color: #9ca3af; font-size: 12px; margin-top: 4px; }
    main { max-width: 1200px; margin: 0 auto; padding: 24px; }
    section { background: #fff; border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
    section h2 { margin: 0 0 12px; font-size: 15px; font-weight: 600; color: #1d1d1f; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; }
    .stat { padding: 12px; background: #f5f5f7; border-radius: 6px; text-align: center; }
    .stat .num { font-size: 24px; font-weight: 600; }
    .stat .label { font-size: 11px; text-transform: uppercase; color: #6b7280; letter-spacing: 0.5px; margin-top: 4px; }
    .stat.dlq .num { color: #b91c1c; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
    th { font-weight: 600; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
    code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; background: #f5f5f7; padding: 1px 6px; border-radius: 3px; }
    .tag { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 10px; background: #e5e7eb; color: #374151; margin-left: 6px; }
    .tag.dynamic { background: #dbeafe; color: #1e40af; }
    .empty { color: #9ca3af; font-style: italic; padding: 12px 0; }
    .err { color: #b91c1c; font-family: ui-monospace, monospace; font-size: 11px; max-width: 480px; overflow: hidden; text-overflow: ellipsis; }
    .ts { color: #6b7280; white-space: nowrap; }
  `;

  const adapterSections = data.adapters.map(a => {
    if (a.repos.length === 0) return `<div class="empty">${esc(a.id)}: no repos watched</div>`;
    const items = a.repos.map(r => `<li><code>${esc(r.name)}</code>${r.source === "dynamic" ? '<span class="tag dynamic">dynamic</span>' : ''}</li>`).join("");
    return `<div><strong>${esc(a.id)}</strong> <span style="color:#6b7280">(${esc(a.host)})</span><ul style="margin:6px 0 12px 20px">${items}</ul></div>`;
  }).join("");

  const dlqRows = data.dlq.length === 0
    ? `<tr><td colspan="5" class="empty">DLQ is empty.</td></tr>`
    : data.dlq.map(e => `
        <tr>
          <td><code>${esc(e.id.slice(0, 8))}</code></td>
          <td>${esc(e.ref.owner)}/${esc(e.ref.repo)}#${e.ref.number}</td>
          <td>${e.attempts}</td>
          <td class="err">${esc(truncateText(e.error, 200))}</td>
          <td class="ts">${e.dlqAt ? esc(formatTs(e.dlqAt)) : "—"}</td>
        </tr>
      `).join("");

  const auditRows = data.audit.length === 0
    ? `<tr><td colspan="4" class="empty">No audit entries yet.</td></tr>`
    : data.audit.map(a => `
        <tr>
          <td class="ts">${esc(formatTs(a.ts))}</td>
          <td><code>${esc(a.jobId.slice(0, 8))}</code></td>
          <td>${esc(a.event)}</td>
          <td>${esc(truncateText(a.detail, 240))}</td>
        </tr>
      `).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>Aegis dashboard</title>
  <style>${css}</style>
</head>
<body>
<header>
  <h1>Aegis</h1>
  <div class="meta">
    Active model: <code>${esc(data.model.provider)}/${esc(data.model.modelId)}</code>${data.model.isOverride ? ' <span class="tag">override</span>' : ''}
    &nbsp;&middot;&nbsp; Generated ${esc(formatTs(data.generatedAt))}
  </div>
</header>
<main>
  <section>
    <h2>Queue</h2>
    <div class="stats">
      <div class="stat"><div class="num">${data.queue.pending}</div><div class="label">Pending</div></div>
      <div class="stat"><div class="num">${data.queue.running}</div><div class="label">Running</div></div>
      <div class="stat"><div class="num">${data.queue.done}</div><div class="label">Done</div></div>
      <div class="stat dlq"><div class="num">${data.queue.dlq}</div><div class="label">DLQ</div></div>
    </div>
  </section>

  <section>
    <h2>Watched repos</h2>
    ${adapterSections || '<div class="empty">No adapters configured.</div>'}
  </section>

  <section>
    <h2>Dead-letter queue</h2>
    <table>
      <thead><tr><th>Job</th><th>PR</th><th>Attempts</th><th>Error</th><th>DLQ at</th></tr></thead>
      <tbody>${dlqRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Recent activity</h2>
    <table>
      <thead><tr><th>When</th><th>Job</th><th>Event</th><th>Detail</th></tr></thead>
      <tbody>${auditRows}</tbody>
    </table>
  </section>
</main>
</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateText(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

function formatTs(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}
