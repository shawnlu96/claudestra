/** Read the PR's base and exact delivered head. argv only; fetch fills objects without checking out another branch. */
import { execFileSync } from "node:child_process";
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { readRegistryAgentsSync } from "./registry.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import { ghEnv } from "./peer-pr-github.js";

export interface ScopeFile { path: string; added: number | null; deleted: number | null }
export interface ScopeDiff { base: string; files: ScopeFile[] }

/** --no-renames makes both sides of a move visible, including binary files and names containing tabs/newlines. */
export function scopeNumstat(out: string): ScopeFile[] {
  if (out && !out.endsWith("\0")) throw new Error("git numstat 文件列表不完整");
  return out.split("\0").filter(Boolean).map((row) => {
    const m = row.match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/);
    if (!m) throw new Error("git numstat 文件列表不完整");
    return { path: m[3], added: m[1] === "-" ? null : Number(m[1]), deleted: m[2] === "-" ? null : Number(m[2]) };
  });
}

export function scopeDiff(db: Database, task: LedgerTask, head: string): ScopeDiff {
  const dir = readSchedulerConfig().projects[task.project]?.repoDir ??
    readRegistryAgentsSync().find((a) => a.name === (getSchedulerSession(db, task.id, "author")?.agent ?? task.agent))?.cwd;
  if (!dir) throw new Error("找不到本卡仓库目录");
  const pr = task.pr?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/);
  if (!pr || !/^[0-9a-f]{40}$/.test(head)) throw new Error("缺少本次 PR 或完整 head");
  const deadline = Date.now() + 15_000;
  const run = (cmd: string, args: string[]) => execFileSync(cmd, args,
    { cwd: dir, env: ghEnv(), encoding: "utf8", timeout: Math.max(1, deadline - Date.now()), maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  return readScopeGit(pr[1], pr[2], head, run);
}

/** Shared command seam lets tests use real local git objects and an isolated PR metadata fixture. */
export function readScopeGit(repo: string, pr: string, head: string, run: (cmd: string, args: string[]) => string): ScopeDiff {
  const info = JSON.parse(run("gh", ["pr", "view", pr, "--repo", repo, "--json", "baseRefOid,headRefOid"]));
  const base = info.baseRefOid;
  if (info.headRefOid !== head || typeof base !== "string" || !/^[0-9a-f]{40}$/.test(base)) throw new Error("PR head 已变化或 base 读不到");
  for (const sha of [head, base]) {
    try { run("git", ["cat-file", "-e", `${sha}^{commit}`]); }
    catch { run("git", ["fetch", "--no-tags", "--quiet", "origin", sha]); /* 缺对象先 fetch；失败交调用方登记，仍然派审。 */ }
  }
  return { base, files: scopeNumstat(run("git", ["diff", "--numstat", "-z", "--no-renames", `${base}...${head}`, "--"])) };
}
