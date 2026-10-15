/**
 * `ledger local-merge` (ONB-2, docs/architecture/local-merge.md): the PM merges a reviewed card of a localMerge project into the
 * local main. Order matters: the ledger gate first (nothing touched on a refusal), then the project lock, then the commit that will
 * land (fast-forward to the head, or git's clean merge of main and the head), the project's checks on that exact tree in a temporary
 * worktree, a last look that main did not move, `git merge --ff-only` in the main directory, and only then the ledger record.
 * A failure after main moved leaves the head on main: the rerun sees it there and only writes the record (backfill).
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { LedgerError } from "./ledger-store.js";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { runBounded, type BoundedResult } from "./run-bounded.js";
import { checkArgv, type LocalMergeProject } from "./scheduler-config.js";
import { assertMayLocalMerge, localMergeGate, localMergeRecord, recordLocalMerge, type CheckResult, type LocalMergeMode } from "./local-merge.js";

/** Each check gets this long (PM default, 2026-10-15); a hung check fails the merge instead of holding the project lock forever. */
const CHECK_TIMEOUT_MS = 30 * 60_000;
const GIT_TIMEOUT_MS = 120_000;
const MAIN = "refs/heads/main";

type Command = (argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs: number }) => Promise<BoundedResult>;
export interface LocalMergeRunDeps { command?: Command; checkTimeoutMs?: number; tmpRoot?: string }
export interface LocalMergeOutcome {
  ok: true; duplicate: boolean; seq: number; mode: LocalMergeMode; head: string; mergeSha: string; base: string; checks: CheckResult[];
}

const refuse = (why: string): never => { throw new LedgerError("conflict", why); };
const first = (r: BoundedResult): string => r.stderr.trim().split("\n")[0]?.slice(0, 200) || `exit ${r.code ?? "timeout"}`;

/** git in one directory; a failed step throws with its first stderr line. */
function gitAt(dir: string, command: Command) {
  const raw = (...args: string[]) => command(["git", ...args], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
  const out = async (...args: string[]): Promise<string> => {
    const r = await raw(...args);
    if (r.code !== 0 || r.timedOut) throw new LedgerError("conflict", `git ${args[0]} 失败：${first(r)}`);
    return r.stdout.trim();
  };
  return { raw, out };
}

type Git = ReturnType<typeof gitAt>;

/** The main directory must sit on main with nothing uncommitted or untracked: ff-only into a dirty tree is refused, not merged around. */
async function mainState(git: Git): Promise<string> {
  const branch = await git.raw("symbolic-ref", "-q", "HEAD");
  if (branch.code !== 0 || branch.stdout.trim() !== MAIN) refuse("仓库主目录不在 main 分支上");
  const dirty = await git.out("status", "--porcelain");
  if (dirty) refuse(`仓库主目录有未提交的改动：${dirty.split("\n").slice(0, 3).join("；")}`);
  return git.out("rev-parse", "--verify", `${MAIN}^{commit}`);
}

/** ff = main is an ancestor of the head; merge = git's clean merge as a commit with parents (main, head); a conflict refuses. */
async function landingCommit(git: Git, head: string, base: string, taskId: string): Promise<{ mode: LocalMergeMode; target: string }> {
  if ((await git.raw("merge-base", "--is-ancestor", base, head)).code === 0) return { mode: "ff", target: head };
  const tree = await git.raw("merge-tree", "--write-tree", "--no-messages", base, head);
  if (tree.code === 1) refuse(`main 和 ${head.slice(0, 12)} 有冲突，退回 fix 重新基于 main`);
  if (tree.code !== 0 || tree.timedOut) refuse(`git merge-tree 失败：${first(tree)}`);
  const treeSha = tree.stdout.trim().split("\n")[0]!;
  const target = await git.out("commit-tree", treeSha, "-p", base, "-p", head, "-m", `Merge ${taskId} (${head.slice(0, 12)}) into main`);
  return { mode: "merge", target };
}

/** Every check in order on a temporary worktree of `target`; stops at the first failure. The worktree is always removed. */
async function runChecks(git: Git, target: string, checks: readonly string[], deps: LocalMergeRunDeps): Promise<CheckResult[]> {
  const command = deps.command ?? runBounded, dir = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "local-merge-"));
  const out: CheckResult[] = [];
  try {
    await git.out("worktree", "add", "--detach", dir, target);
    for (const check of checks) {
      const t0 = Date.now(), r = await command(checkArgv(check), { cwd: dir, timeoutMs: deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS });
      out.push({ check, code: r.code, timedOut: r.timedOut, ms: Date.now() - t0 });
      if (r.code !== 0 || r.timedOut) break;
    }
  } finally {
    const rm = await git.raw("worktree", "remove", "--force", dir);
    if (rm.code !== 0) console.error(`⚠️ [local-merge] 临时 worktree 没删掉（${first(rm)}），已直接删目录并 prune`);
    rmSync(dir, { recursive: true, force: true });
    await git.raw("worktree", "prune");
  }
  return out;
}

/** Busy = another local merge of the same repository holds its lock right now (no waiting: the PM reruns later). */
async function lockRepo(git: Git, repoDir: string) {
  const common = await git.out("rev-parse", "--git-common-dir");
  const lock = await acquireLock(join(isAbsolute(common) ? common : join(repoDir, common), "claudestra-local-merge.lock"), 0);
  if (!lock) throw new LedgerError("busy", "这个项目正在跑另一次本地合并，等它结束再跑");
  return lock;
}

export async function runLocalMerge(db: Database, ctx: WriteCtx, local: LocalMergeProject | null, input: { taskId: string; head: string },
  deps: LocalMergeRunDeps = {}): Promise<LocalMergeOutcome> {
  const done = (seq: number, data: Record<string, unknown>, duplicate: boolean): LocalMergeOutcome => ({ ok: true, duplicate, seq,
    mode: data.mode as LocalMergeMode, head: String(data.head), mergeSha: String(data.mergeSha), base: String(data.base), checks: data.checks as CheckResult[] });
  // caller and project first: a rerun's earlier record is only handed back to someone who may merge, while the project is local
  const current = mustTask(db, input.taskId);
  assertMayLocalMerge(db, ctx.actor, current);
  if (!local) refuse(`项目 ${current.project} 不是 localMerge 项目（scheduler.json），合并走 PR 流程`);
  const prev = localMergeRecord(db, current, input.head);
  if (prev) return done(prev.seq, prev.data, true);
  const { task } = localMergeGate(db, ctx.actor, input.taskId, input.head, ctx.now ?? Date.now());
  if (!local!.repoDir || !isAbsolute(local!.repoDir)) refuse("scheduler.json 里本项目的 repoDir 不是绝对路径");
  const head = task.headSHA!, git = gitAt(local!.repoDir, deps.command ?? runBounded);
  const lock = await lockRepo(git, local!.repoDir);
  try {
    const base = await mainState(git);
    if ((await git.raw("cat-file", "-e", `${head}^{commit}`)).code !== 0) refuse(`仓库里没有提交 ${head.slice(0, 12)}`);
    const record = (mode: LocalMergeMode, mergeSha: string, checks: CheckResult[]) => {
      const r = recordLocalMerge(db, { ...ctx, now: Date.now() }, { taskId: task.id, head, mergeSha, base, mode, checks });
      return done(r.event.seq, r.event.data, r.duplicate);
    };
    // merged earlier but the record was lost (the write after the ff failed): only the record is missing
    if ((await git.raw("merge-base", "--is-ancestor", head, base)).code === 0) return record("backfill", base, []);
    const { mode, target } = await landingCommit(git, head, base, task.id);
    const checks = await runChecks(git, target, local!.checks, deps);
    const bad = checks.find((c) => c.code !== 0 || c.timedOut);
    if (bad) refuse(`检查没过：${bad.check}（${bad.timedOut ? "超时" : `exit ${bad.code}`}），main 没动`);
    if ((await mainState(git)) !== base) refuse("检查期间 main 变了，重跑 local-merge");
    localMergeGate(db, ctx.actor, task.id, head, Date.now()); // the ledger may have moved during the checks
    await git.out("merge", "--ff-only", target);
    return record(mode, target, checks);
  } finally {
    lock.release();
  }
}
