#!/usr/bin/env node
import { createRequire } from "node:module";
import { serve } from "./serve.js";

const [,, command, ...args] = process.argv;

if (command === "serve") {
  const configPath = args[0] ?? "aegis.config.js";
  const req = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const mod = req(configPath);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const cfg = mod.default ?? mod;
  serve(cfg).catch(err => {
    console.error("[aegis] fatal:", err);
    process.exit(1);
  });
} else if (command === "config" && args[0] === "validate") {
  const configPath = args[1] ?? "aegis.config.js";
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
