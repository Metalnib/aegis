import { readFileSync } from "node:fs";
import type { SecretsProvider } from "@aegis/sdk";

/**
 * 12-factor-style secrets provider. For each `name`, checks `${name}_FILE`
 * first - if set, reads that file path, trims trailing whitespace, and caches
 * the result. Otherwise falls back to the env var. The `_FILE` indirection
 * is the standard pattern for k8s file-mounted secrets and Docker secrets;
 * adapters don't need to know which form is in use.
 *
 * Caveat: file contents are cached for the lifetime of the process. If
 * Kubernetes rotates a mounted secret in place, Aegis will keep using the
 * old value until the pod restarts. Operators rotating credentials must
 * trigger a pod restart. A log line is emitted the first time a file
 * secret is loaded so this behavior is discoverable.
 */
export class EnvSecrets implements SecretsProvider {
  private readonly fileCache = new Map<string, string>();
  private fileNoticeLogged = false;

  constructor(private readonly logger?: { info(msg: string): void }) {}

  get(name: string): string {
    const filePath = process.env[`${name}_FILE`];
    if (filePath && filePath !== "") {
      let cached = this.fileCache.get(filePath);
      if (cached === undefined) {
        try {
          cached = readFileSync(filePath, "utf-8").replace(/\s+$/, "");
        } catch (err) {
          throw new Error(`Failed to read secret ${name} from ${filePath}: ${(err as Error).message}`);
        }
        if (cached === "") throw new Error(`Secret file for ${name} (${filePath}) is empty`);
        this.fileCache.set(filePath, cached);
        if (!this.fileNoticeLogged) {
          this.logger?.info(`[secrets] file-mounted secret in use; rotation requires a pod restart`);
          this.fileNoticeLogged = true;
        }
      }
      return cached;
    }

    const value = process.env[name];
    if (value == null || value === "") {
      throw new Error(`Required secret ${name} is not set (env var ${name} or ${name}_FILE)`);
    }
    return value;
  }
}
