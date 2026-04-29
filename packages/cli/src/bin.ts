#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import { serve } from "./serve.js";

const [,, command, ...args] = process.argv;

if (command === "serve") {
  const configPath = path.resolve(args[0] ?? "aegis.config.js");
  const req = createRequire(import.meta.url);

  // Cache-busting loader. Every call deletes the resolved config path from
  // the require cache and re-imports. Used at startup AND on every hot reload.
  const loader = (): unknown => {
    const resolved = req.resolve(configPath);
    delete req.cache[resolved];
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mod = req(resolved);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    return mod.default ?? mod;
  };

  let initial: unknown;
  try {
    initial = loader();
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
  const req = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const mod = req(configPath);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const cfg = mod.default ?? mod;
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
