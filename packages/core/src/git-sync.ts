import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { Logger, CloneSpec } from "@aegis/sdk";

const execFileAsync = promisify(execFile);

export class GitSync {
  constructor(
    private readonly workspaceRoot: string,
    private readonly logger: Logger,
  ) {}

  async ensureClone(host: string, owner: string, repo: string, spec: CloneSpec): Promise<string> {
    const repoPath = path.join(this.workspaceRoot, host, owner, repo);
    await mkdir(repoPath, { recursive: true });

    try {
      await this.git(repoPath, ["rev-parse", "--git-dir"]);
      this.logger.debug(`[git-sync] ${repo} already cloned at ${repoPath}`);
    } catch {
      this.logger.info(`[git-sync] cloning ${spec.url} to ${repoPath}`);
      await mkdir(path.dirname(repoPath), { recursive: true });
      await this.gitWithCreds(path.dirname(repoPath), ["clone", "--filter=blob:none", spec.url, repo], spec);
    }

    return repoPath;
  }

  async fetchAndCheckout(repoPath: string, sha: string, spec: CloneSpec): Promise<void> {
    this.logger.info(`[git-sync] fetch + checkout ${sha} in ${repoPath}`);
    await this.gitWithCreds(repoPath, ["fetch", "--quiet", "origin", sha], spec);
    await this.git(repoPath, ["checkout", "--quiet", "--detach", sha]);
  }

  /**
   * Run git without credentials. Sets GIT_TERMINAL_PROMPT=0 so any unexpected
   * auth requirement fails fast rather than blocking on a missing TTY.
   */
  private async git(cwd: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return stdout.trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`git ${args[0]} failed in ${cwd}: ${sanitizeGitError(msg)}`);
    }
  }

  private async gitWithCreds(cwd: string, args: string[], spec: CloneSpec): Promise<string> {
    const askpass = await writeAskpassScript();
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        env: {
          ...process.env,
          GIT_ASKPASS: askpass,
          GIT_TERMINAL_PROMPT: "0",
          GIT_USERNAME: spec.username,
          GIT_PASSWORD: spec.password,
        },
      });
      return stdout.trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`git ${args[0]} failed in ${cwd}: ${sanitizeGitError(msg)}`);
    } finally {
      await rm(askpass, { force: true }).catch(() => {});
    }
  }
}

/**
 * Write a one-shot ASKPASS helper. Git invokes it with a prompt containing
 * "Username" or "Password" and reads the first stdout line as the answer.
 * The actual secret lives in env vars passed to the child git process only,
 * so it never appears in argv, the URL, or git's stderr.
 */
async function writeAskpassScript(): Promise<string> {
  const file = path.join(tmpdir(), `aegis-askpass-${crypto.randomUUID()}.sh`);
  const body = `#!/bin/sh
case "$1" in
  Username*) printf '%s' "$GIT_USERNAME" ;;
  *)         printf '%s' "$GIT_PASSWORD" ;;
esac
`;
  await writeFile(file, body, { mode: 0o700 });
  return file;
}

/** Strip credentials that may have slipped into a git error message. */
function sanitizeGitError(msg: string): string {
  return msg
    // https://user:pass@host or https://:pass@host
    .replace(/(https?:\/\/)([^@\s/]*):([^@\s]*)@/g, "$1$2:***@")
    // https://token@host (no colon, single token form)
    .replace(/(https?:\/\/)([^@\s/:]+)@/g, "$1***@");
}
