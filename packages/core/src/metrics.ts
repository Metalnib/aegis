/**
 * Minimal Prometheus text-format collector. No external deps.
 *
 * Supported types: counter (monotonic), gauge (point-in-time). Histograms and
 * summaries are intentionally out of scope - if we need timing distributions
 * later, switch to prom-client. For now counters + gauges cover queue depth,
 * job throughput, and webhook intake which are the operational signals we care
 * about for on-call.
 */

type LabelValues = Record<string, string | number>;

interface CounterEntry {
  type: "counter";
  help: string;
  values: Map<string, number>;
}

interface GaugeEntry {
  type: "gauge";
  help: string;
  /** Either a static value or a pull-based provider invoked at scrape time. */
  values: Map<string, number>;
  provider?: () => number | null;
}

type Entry = CounterEntry | GaugeEntry;

export class Metrics {
  private readonly entries = new Map<string, Entry>();

  counter(name: string, help: string, labels: LabelValues = {}, value = 1): void {
    let entry = this.entries.get(name);
    if (!entry) {
      entry = { type: "counter", help, values: new Map() };
      this.entries.set(name, entry);
    }
    if (entry.type !== "counter") throw new Error(`metric ${name} already registered as ${entry.type}`);
    const key = serializeLabels(labels);
    entry.values.set(key, (entry.values.get(key) ?? 0) + value);
  }

  gauge(name: string, help: string, value: number, labels: LabelValues = {}): void {
    let entry = this.entries.get(name);
    if (!entry) {
      entry = { type: "gauge", help, values: new Map() };
      this.entries.set(name, entry);
    }
    if (entry.type !== "gauge") throw new Error(`metric ${name} already registered as ${entry.type}`);
    entry.values.set(serializeLabels(labels), value);
  }

  /** Register a gauge whose value is fetched at scrape time. Replaces any prior provider. */
  gaugeProvider(name: string, help: string, provider: () => number | null): void {
    const existing = this.entries.get(name);
    if (existing && existing.type !== "gauge") throw new Error(`metric ${name} already registered as ${existing.type}`);
    const entry: GaugeEntry = existing as GaugeEntry ?? { type: "gauge", help, values: new Map() };
    entry.provider = provider;
    entry.help = help;
    this.entries.set(name, entry);
  }

  /** Render in Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];
    for (const [name, entry] of this.entries) {
      lines.push(`# HELP ${name} ${entry.help}`);
      lines.push(`# TYPE ${name} ${entry.type}`);

      if (entry.type === "gauge" && entry.provider) {
        const v = entry.provider();
        if (v !== null) lines.push(`${name} ${formatNumber(v)}`);
      }

      for (const [labelKey, v] of entry.values) {
        lines.push(`${name}${labelKey} ${formatNumber(v)}`);
      }
    }
    return lines.join("\n") + "\n";
  }
}

function serializeLabels(labels: LabelValues): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  const parts = keys.map(k => `${k}="${escapeLabelValue(String(labels[k]))}"`);
  return `{${parts.join(",")}}`;
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? "+Inf" : n < 0 ? "-Inf" : "NaN";
  return String(n);
}
