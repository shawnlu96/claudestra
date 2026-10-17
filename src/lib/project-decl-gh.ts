/**
 * generality-PROJSCAN1 · the declaration PR's git / gh calls, following private-merge-gh.ts: structured argv, bounded, failures
 * told as class and exit code only (stderr may carry a remote URL or a local path and is never echoed). The commit is built with
 * plumbing on a private index so it changes exactly `.floka/project.json` on top of the fixed target head. There is deliberately
 * no merge operation: the PM or owner reviews and merges; the existing git / gh identity is the only authority used.
 */
import { join } from "node:path";
import type { BoundedResult } from "./run-bounded.js";
import { scanGit, scanGitEnv, type ScanRunner } from "./project-decl-scan-run.js";
import { assertPlainDir, writeExclusive } from "./project-decl-scan-tree.js";

const GH_MS = 60_000;
export const DECL_FILE = ".floka/project.json";
type DeclPrFail = { fail: string };
interface DeclPrRef { number: number; url: string; state: string }
export interface DeclPrRequest {
  repoRoot: string; repo: string; base: string; head: string; branch: string; content: string; title: string; body: string;
  /** Control directory of the isolation area: outside every command boundary; each file is created exclusively, never followed. */
  controlDir: string;
}
export type DeclPrOutcome = { status: "created" | "existing"; pr: DeclPrRef } | DeclPrFail;

const failOf = (what: string, r: BoundedResult): DeclPrFail => ({ fail: r.timedOut ? `${what} 超时` : `${what} 失败（exit ${r.code ?? "无"}）` });
const isHex = (s: string) => new RegExp("^[a-f0-9]{40}([a-f0-9]{24})?$").test(s);

/** A PR of any state for this branch counts: a retry never opens a second one, and a closed one is not reopened behind the PM. */
async function findPr(run: ScanRunner, req: DeclPrRequest): Promise<DeclPrRef | null | DeclPrFail> {
  const r = await run(["gh", "pr", "list", "--repo", req.repo, "--head", req.branch, "--state", "all", "--json", "number,url,state", "--limit", "5"],
    { cwd: req.repoRoot, env: scanGitEnv(), timeoutMs: GH_MS });
  if (r.code !== 0 || r.timedOut) return failOf("gh pr list", r);
  let list: unknown;
  try { list = JSON.parse(r.stdout); } catch { return { fail: "gh pr list 输出不合规" }; /* told as malformed, never as no PR */ }
  if (!Array.isArray(list)) return { fail: "gh pr list 输出不合规" };
  const pr = list.find((p) => typeof p?.number === "number" && typeof p?.url === "string");
  return pr ? { number: pr.number, url: pr.url, state: String(pr.state ?? "UNKNOWN") } : null;
}

/** A pre-existing name or a planted link in the control directory is a failure, never something to follow or replace. */
function writeControl(dir: string, files: [string, string][]): DeclPrFail | null {
  try { assertPlainDir(dir); for (const [file, data] of files) writeExclusive(file, data); return null; }
  catch { return { fail: "控制文件无法排他创建" }; }
}

/** read-tree + hash-object + update-index + write-tree + commit-tree on a private index: only the declaration file differs. */
async function writeCommit(run: ScanRunner, req: DeclPrRequest): Promise<string | DeclPrFail> {
  const env = { GIT_INDEX_FILE: join(req.controlDir, "decl-index") };
  const file = join(req.controlDir, "project.json"), message = join(req.controlDir, "commit-message.txt");
  const written = writeControl(req.controlDir, [[file, req.content], [message, `${req.title}\n\n${req.body}\n`]]);
  if (written) return written;
  // --no-filters: the blob is the draft byte for byte; no clean filter configured for the repository is started.
  const steps: [string, string[]][] = [["git read-tree", ["read-tree", req.head]],
    ["git hash-object", ["hash-object", "-w", "--no-filters", "--", file]]];
  const outputs: string[] = [];
  for (const [what, args] of steps) {
    const r = await scanGit(run, req.repoRoot, args, env);
    if (r.code !== 0 || r.timedOut) return failOf(what, r);
    outputs.push(r.stdout.trim());
  }
  const blob = outputs[1];
  if (!isHex(blob)) return { fail: "git hash-object 输出不合规" };
  const update = await scanGit(run, req.repoRoot, ["update-index", "--add", "--cacheinfo", `100644,${blob},${DECL_FILE}`], env);
  if (update.code !== 0 || update.timedOut) return failOf("git update-index", update);
  const tree = await scanGit(run, req.repoRoot, ["write-tree"], env);
  if (tree.code !== 0 || tree.timedOut || !isHex(tree.stdout.trim())) return failOf("git write-tree", tree);
  const commit = await scanGit(run, req.repoRoot, ["commit-tree", tree.stdout.trim(), "-p", req.head, "-F", message]);
  if (commit.code !== 0 || commit.timedOut || !isHex(commit.stdout.trim())) return failOf("git commit-tree", commit);
  return commit.stdout.trim();
}

export async function openDeclarationPr(run: ScanRunner, req: DeclPrRequest): Promise<DeclPrOutcome> {
  const existing = await findPr(run, req);
  if (existing && "fail" in existing) return existing;
  if (existing) return { status: "existing", pr: existing };
  const remote = await scanGit(run, req.repoRoot, ["ls-remote", "--heads", "origin", `refs/heads/${req.branch}`]);
  if (remote.code !== 0 || remote.timedOut) return failOf("git ls-remote", remote);
  if (!remote.stdout.trim()) {
    const commit = await writeCommit(run, req);
    if (typeof commit !== "string") return commit;
    const push = await scanGit(run, req.repoRoot, ["push", "--no-verify", "origin", `${commit}:refs/heads/${req.branch}`]);
    if (push.code !== 0 || push.timedOut) return failOf("git push", push);
  }
  const bodyFile = join(req.controlDir, "pr-body.md");
  const written = writeControl(req.controlDir, [[bodyFile, req.body]]);
  if (written) return written;
  const created = await run(["gh", "pr", "create", "--repo", req.repo, "--base", req.base, "--head", req.branch, "--title", req.title,
    "--body-file", bodyFile], { cwd: req.repoRoot, env: scanGitEnv(), timeoutMs: GH_MS });
  if (created.code !== 0 || created.timedOut) return failOf("gh pr create", created);
  const after = await findPr(run, req);
  if (!after || "fail" in after) return { fail: "gh pr create 之后查不到 PR" };
  return { status: "created", pr: after };
}
