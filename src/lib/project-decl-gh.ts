/**
 * generality-PROJSCAN1 · the declaration PR's git / gh calls, following private-merge-gh.ts: structured argv, bounded, failures
 * told as class and exit code only (stderr may carry a remote URL or a local path and is never echoed). The commit is built with
 * plumbing on a private index so it changes exactly `.floka/project.json` on top of the fixed target head. There is deliberately
 * no merge operation: the PM or owner reviews and merges; the existing git / gh identity is the only authority used.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoundedResult } from "./run-bounded.js";
import { scanGit, scanGitEnv, type ScanRunner } from "./project-decl-scan-run.js";

const GH_MS = 60_000;
export const DECL_FILE = ".floka/project.json";
type DeclPrFail = { fail: string };
interface DeclPrRef { number: number; url: string; state: string }
export interface DeclPrRequest {
  repoRoot: string; repo: string; base: string; head: string; branch: string; content: string; title: string; body: string; areaRoot: string;
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

/** read-tree + hash-object + update-index + write-tree + commit-tree on a private index: only the declaration file differs. */
async function writeCommit(run: ScanRunner, req: DeclPrRequest): Promise<string | DeclPrFail> {
  const env = { GIT_INDEX_FILE: join(req.areaRoot, "decl-index") };
  const file = join(req.areaRoot, "project.json"), message = join(req.areaRoot, "commit-message.txt");
  writeFileSync(file, req.content); writeFileSync(message, `${req.title}\n\n${req.body}\n`);
  const steps: [string, string[]][] = [["git read-tree", ["read-tree", req.head]], ["git hash-object", ["hash-object", "-w", "--", file]]];
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
  const bodyFile = join(req.areaRoot, "pr-body.md");
  writeFileSync(bodyFile, req.body);
  const created = await run(["gh", "pr", "create", "--repo", req.repo, "--base", req.base, "--head", req.branch, "--title", req.title,
    "--body-file", bodyFile], { cwd: req.repoRoot, env: scanGitEnv(), timeoutMs: GH_MS });
  if (created.code !== 0 || created.timedOut) return failOf("gh pr create", created);
  const after = await findPr(run, req);
  if (!after || "fail" in after) return { fail: "gh pr create 之后查不到 PR" };
  return { status: "created", pr: after };
}
