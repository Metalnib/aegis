#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "./serve.js";

const [,, command, ...args] = process.argv;

/**
 * Load the user config via dynamic import. The whole project is ESM, the
 * adapter packages are ESM, and the user's config is expected to be ESM.
 * Cache-busting via a query-string suffix on the file URL forces Node to
 * re-evaluate the file on every reload (the import-cache is keyed by URL).
 */
async function loadConfigFile(configPath: string): Promise<unknown> {
  const url = pathToFileURL(configPath).href + `?t=${Date.now()}`;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const mod = await import(url);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return mod.default ?? mod;
}

if (command === "serve") {
  const configPath = path.resolve(args[0] ?? "aegis.config.js");
  const loader = (): Promise<unknown> => loadConfigFile(configPath);

  let initial: unknown;
  try {
    initial = await loader();
  } catch (err) {
    console.error("[aegis] failed to load config:", err);
    process.exit(1);
  }

  serve(initial, { configPath, loader }).catch(err => {
    console.error("[aegis] fatal:", err);
    process.exit(1);
  });
} else if (command === "config" && args[0] === "validate") {
  const configPath = path.resolve(args[1] ?? "aegis.config.js");
  const cfg = await loadConfigFile(configPath);
  const { loadConfig } = await import("@aegis/core");
  try {
    loadConfig(cfg);
    console.log("Config is valid.");
  } catch (err) {
    console.error("Config validation failed:", err);
    process.exit(1);
  }
} else {
  console.log(`Usage:
  aegis serve [aegis.config.js]
  aegis config validate [aegis.config.js]
`);
  process.exit(1);
}
