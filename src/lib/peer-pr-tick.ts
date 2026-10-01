/**
 * The peer PR step of a scheduler pass (i28-A2 §8), run before the merge and auto ticks: pushes first (a verdict recorded since
 * the last pass goes out now), then PM notices still unsent, then the hold checks, then — once per pollSec — the cards' PR state and the intake of new PRs.
 * peer-prs.json missing or off = nothing at all is called; unreadable = the step is skipped and reported to the service log.
 * Every gh / git / bridge / ledger child runs under the pass's liveness guard. tests/peer-pr-tick.test.ts drives it end to end.
 */
import type { Database } from "bun:sqlite";
import { realpathSync, statSync, readFileSync } from "node:fs";
import { sep } from "node:path";
import { bridgeSend } from "./bridge-client.js";
import { statePath } from "./paths.js";
import { notifyProjectPm } from "./pm-notify.js";
import { readPeerPrConfig, type PeerPrConfig, type PeerPrConfigRead } from "./peer-pr-config.js";
import { knownCommits, peerPrGithub } from "./peer-pr-github.js";
import { intakeTick } from "./peer-pr-intake.js";
import { REPORT_MAX_BYTES } from "./peer-pr-message.js";
import { retryNotices, stateFor, type Manager, type PeerPrCtx, type PeerPrDeps, type PeerPrState } from "./peer-pr-notice.js";
import { cardsTick, verifyHolds } from "./peer-pr-observe.js";
import { pushPending } from "./peer-pr-push.js";
import { localIdentity } from "./peer-pr-redact.js";
import { runBounded } from "./run-bounded.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

type Active = () => void;
export interface PeerPrTickResult { failed: { taskId: string; error: string }[]; log: string[] }

/** A review report as the reviewer wrote it: only a regular file under ledger/reviews (after symlinks), at most REPORT_MAX_BYTES. */
export function readReviewReport(path: string, root = statePath("ledger", "reviews")): { text: string } | { error: string } {
  if (!path) return { error: "审查事件没有报告路径" };
  try {
    const base = realpathSync.native(root);
    const real = realpathSync.native(path.startsWith("/") ? path : `${statePath("ledger")}/${path}`);
    if (!real.startsWith(base + sep)) return { error: "报告不在 ledger/reviews 下" };
    const st = statSync(real);
    if (!st.isFile()) return { error: "报告不是普通文件" };
    if (st.size > REPORT_MAX_BYTES) return { error: `报告 ${st.size} 字节，超过 ${REPORT_MAX_BYTES}` };
    return { text: readFileSync(real, "utf8") };
  } catch (e) {
    return { error: `报告读不了：${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
  }
}

export async function peerPrTick(db: Database, opts: { readConfig?: () => PeerPrConfigRead; deps: (cfg: PeerPrConfig) => PeerPrDeps; state?: PeerPrState }): Promise<PeerPrTickResult> {
  const read = (opts.readConfig ?? readPeerPrConfig)();
  if (read.kind === "off") return { failed: [], log: [] };
  if (read.kind === "error") return { failed: [{ taskId: "peer-pr", error: read.error }], log: [] };
  const c: PeerPrCtx = { db, cfg: read.config, deps: opts.deps(read.config), state: opts.state ?? stateFor(db) };
  const out: PeerPrTickResult = { failed: [], log: [] };
  const step = async (name: string, fn: () => Promise<string[] | void>) => {
    try { out.log.push(...((await fn()) ?? [])); } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      out.failed.push({ taskId: `peer-pr ${name}`, error: (e as Error).message.slice(0, 400) });
    }
  };
  const repo = async () => (c.state.repo ??= await c.deps.github.repo());
  await step("push", async () => (await pushPending(c)).filter((r) => r.outcome !== "backoff").map((r) => `${r.key} ${r.outcome}`));
  await step("notice", () => retryNotices(c));
  await step("verify", () => verifyHolds(c, repo));
  if (c.deps.now() - c.state.lastPoll < c.cfg.pollSec * 1000) return out;
  c.state.lastPoll = c.deps.now();
  await step("poll", async () => {
    const name = await repo();
    const open = await c.deps.github.listOpen(name);
    return [...(await cardsTick(c, name, open)), ...(await intakeTick(c, name, open))];
  });
  return out;
}

/** Checked right before the call and again when it settles (same contract as scheduler-pass.ts guard). */
const guarded = <A extends unknown[], R>(active: Active, fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
  active();
  try { return await fn(...a); } finally { active(); }
};

/** Production wiring; `manager` is the pass's guarded ledger CLI under the scheduler identity. */
export function peerPrStep(db: Database | null, active: Active, manager: Manager): Promise<PeerPrTickResult> {
  if (!db) return Promise.resolve({ failed: [], log: [] });
  const alive = () => { try { active(); return true; } catch { return false; /* a failed liveness check means "not provably active": send nothing */ } };
  return peerPrTick(db, { deps: (cfg) => ({
    github: peerPrGithub(cfg.repoDir, guarded(active, runBounded)),
    commits: guarded(active, (shas: readonly string[]) => knownCommits(cfg.repoDir, shas)),
    manager,
    bridge: guarded(active, (frame: Record<string, unknown>) => bridgeSend(frame, { timeoutMs: 30_000, stillActive: alive })),
    notifyPm: guarded(active, (project: string, text: string) => notifyProjectPm(db, project, text, { fromName: "scheduler", stillActive: alive })),
    readReport: (p) => readReviewReport(p),
    identity: localIdentity(),
    now: Date.now,
  }) });
}
