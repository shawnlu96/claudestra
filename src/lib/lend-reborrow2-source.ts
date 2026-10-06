/**
 * REBOR2 borrower-side source reconciliation, run outside any transaction. The original branch/head/PR and the new branch
 * are read separately and recorded separately; an absent original branch is accepted only when the old side provably never
 * started (so the original start head is reused, never a fresh main). Failure or unknown always throws. tests/lend-reborrow2-facts.test.ts.
 */
import { LedgerError } from "./ledger-store.js";
import type { Reborrow2Facts } from "./lend-reborrow2-facts.js";
import { lendRepoUrl } from "./lend-git.js";
import { runBounded, type BoundedResult } from "./run-bounded.js";
import { pickWorkerEnv } from "./runtimes/clean-env.js";
import { tmpdir } from "node:os";
import type { WriteProbe } from "./lend-write-materials.js";
import type { ReborrowFacts } from "./lend-reborrow-facts.js";
import { reborrowSourceProbe } from "./lend-reborrow-probe.js";

interface Reborrow2Pr { number: number; url: string; repo: string; branch: string; head: string; base: string }
/** head null = the branch is confirmed absent on the remote (not merely unreadable). */
export interface Reborrow2Remote { repo: string; branch: string; head: string | null; pr: Reborrow2Pr | null }

export interface Reborrow2Source {
  peer: string; fp: string; old: Reborrow2Remote; next: Reborrow2Remote;
  /** The successor's starting head: the original branch head, or the original order head when nothing was ever pushed. */
  startHead: string;
  /** The PR the successor binds: same peer keeps the original one; a new branch has none yet (the original stays quoted in `old`). */
  pr: Reborrow2Pr | null;
}

export interface Reborrow2SourceProbe {
  peerFp(peer: string): Promise<string | null>;
  /** null = unreadable; never a guess. */
  remote(peer: string, repo: string, branch: string): Promise<Reborrow2Remote | null>;
  isAncestor(repo: string, from: string, to: string): Promise<boolean | null>;
}

const fail = (why: string): never => { throw new LedgerError("conflict", `终态接续来源未对账：${why}`); };
const sha = /^[0-9a-f]{40}$/;

function checkPr(r: Reborrow2Remote): void {
  const p = r.pr;
  if (!p) return;
  if (r.head === null || !Number.isSafeInteger(p.number) || p.number < 1 || p.repo !== r.repo || p.branch !== r.branch || p.head !== r.head ||
    p.base !== "main" || p.url !== `https://github.com/${p.repo}/pull/${p.number}`) fail("PR 身份、head 或 main base 不符");
}

function validate(f: Reborrow2Facts, s: Reborrow2Source): void {
  const { lease, previous, task, target, samePeer, end } = f;
  if (s.peer !== target.peer || s.fp !== target.fp) fail("当前认证 peer 实例指纹失读或漂移");
  if (s.old.repo !== lease.repo || s.old.branch !== lease.branch || s.next.repo !== target.repo || s.next.branch !== target.branch) fail("仓库或分支不符");
  for (const r of [s.old, s.next]) if (r.head !== null && !sha.test(r.head)) fail("远端 head 不是完整 SHA");
  checkPr(s.old);
  checkPr(s.next);
  if (s.old.pr) {
    if ((task.pr && task.pr !== s.old.pr.url) || (previous.pr !== null && previous.pr !== s.old.pr.number)) fail("原 PR 关系发生变化");
  } else if (task.pr || previous.pr !== null) fail("原 PR 失读");
  if (s.old.head === null) {
    if (!["never_claimed", "not_started"].includes(end) || task.headSHA !== null || task.stage !== "build") fail("原分支不在远端，且原单不能证明从未开工");
    if (s.startHead !== previous.head) fail("未推送的原单只能从原起点续");
  } else if (s.startHead !== s.old.head) fail("起点不是原分支当前远端 head");
  if (samePeer) {
    if (JSON.stringify(s.next) !== JSON.stringify(s.old) || JSON.stringify(s.pr) !== JSON.stringify(s.old.pr)) fail("同 peer 续做却读到不同分支来源");
  } else if ((s.next.head !== null && s.next.head !== s.startHead) || s.next.pr || s.pr) fail("新出借分支已有别的来源或 PR");
}

/** Every reviewed / original / delivered head must already be contained in the remote start head. */
export async function prepareReborrow2Source(facts: Reborrow2Facts, probe: Reborrow2SourceProbe): Promise<Reborrow2Source> {
  const read = async (): Promise<Reborrow2Source> => {
    const fp = await probe.peerFp(facts.target.peer);
    const old = await probe.remote(facts.target.peer, facts.lease.repo, facts.lease.branch);
    const next = facts.samePeer ? old : await probe.remote(facts.target.peer, facts.target.repo, facts.target.branch);
    if (!fp || !old || !next) return fail("来源失读");
    return { peer: facts.target.peer, fp, old, next, startHead: old.head ?? facts.previous.head, pr: facts.samePeer ? old.pr : null };
  };
  const first = await read();
  validate(facts, first);
  const heads = new Set([facts.previous.head, facts.task.headSHA].filter((h): h is string => h !== null));
  for (const from of heads) {
    if (!sha.test(from) || (from !== first.startHead && await probe.isAncestor(first.old.repo, from, first.startHead) !== true)) {
      fail("原起点或已审 head 未包含在当前远端 head");
    }
  }
  const fresh = await read();
  if (JSON.stringify(fresh) !== JSON.stringify(first)) fail("核验期间来源发生漂移");
  return structuredClone(first);
}

/**
 * Confirmed head / absence of one remote branch. Runs from the temp dir with a filtered env, so a repo-local config of the
 * caller's cwd (e.g. a lend copy's transport lock) can neither block nor redirect the read.
 */
export async function remoteBranchState(repo: string, branch: string): Promise<{ head: string | null } | null> {
  const r = await runBounded(["git", "ls-remote", lendRepoUrl(repo), `refs/heads/${branch}`],
    { cwd: tmpdir(), env: { ...pickWorkerEnv(process.env), GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 15_000 });
  const state = parseBranchState(r, branch);
  return state.ok ? { head: state.head } : null;
}

/** ls-remote distinguishes "confirmed absent" (exit 0, no row) from failure; a timeout or error is never absence. */
function parseBranchState(r: BoundedResult, branch: string): { ok: true; head: string | null } | { ok: false } {
  if (r.timedOut || r.code !== 0) return { ok: false };
  const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { ok: true, head: null };
  const rows = lines.map((l) => l.split(/\s+/));
  if (rows.length !== 1 || rows[0].length !== 2 || rows[0][1] !== `refs/heads/${branch}` || !sha.test(rows[0][0])) return { ok: false };
  return { ok: true, head: rows[0][0] };
}

/**
 * Official borrower probes. Present branches reuse the unchanged REBOR probe (pinned key, ls-remote, gh PR list, ancestry);
 * only the confirmed-absent case is new, because REBOR treats absence as failure.
 */
export function reborrow2SourceProbe(write: WriteProbe): Reborrow2SourceProbe {
  const v1 = reborrowSourceProbe(write);
  return {
    peerFp: (peer) => write.peerFp(peer),
    async remote(peer, repo, branch) {
      const state = await remoteBranchState(repo, branch);
      if (!state) return null;
      if (state.head === null) return { repo, branch, head: null, pr: null };
      // REBOR's read only uses lease.{peer, repo, branch}; the current peer's pinned key is compared again in validate().
      const got = await v1.read({ lease: { peer, repo, branch } } as unknown as ReborrowFacts);
      return got && got.remoteHead === state.head ? { repo, branch, head: got.remoteHead, pr: got.pr } : null;
    },
    isAncestor: (repo, from, to) => v1.isAncestor(repo, from, to),
  };
}
