/**
 * Scheduler pass step for the repository owner's review pushes (RRL-1): books every inbox file the bridge stashed through
 * `ledger scheduler-remote-review` (oldest first), applies earlier bookings whose head the card has reached since (`--apply`),
 * then sends the PM notices those asked for and marks each sent.
 * A booked file is deleted; a held card (v2 skip / pause) keeps its file for a later pass; a refused one moves to failed/ and PM
 * is told where the raw text is, so a push the bridge already answered 202 is never silently lost. Only runs for projects that
 * name a handoffPeer. tests/remote-review-intake-tick.test.ts.
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { notifyProjectPm } from "./pm-notify.js";
import { quoteExternal } from "./quote-text.js";
import { listInbox, readInbox, REMOTE_INBOX_DIR } from "./remote-review-inbox.js";
import { lateRemoteMatches, unsentRemoteNotices } from "./remote-review-read.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
type Failed = { taskId: string; error: string }[];

export interface RemoteReviewStepDeps {
  manager: Manager;
  active: () => void;
  notify?: (project: string, text: string) => Promise<void>;
  dir?: string;
  now?: () => number;
}

const NOTICE_RETRY_MS = 60_000;
const failedAt = new WeakMap<Database, Map<number, number>>();

function rethrowStop(e: unknown): void {
  if (e instanceof SchedulerStopped) throw e;
}

/** The refused file goes aside (never retried by itself) and PM hears where it is. */
async function park(file: string, dir: string, project: string | undefined, error: string, notify: RemoteReviewStepDeps["notify"] & {}): Promise<string> {
  const aside = join(dir, "failed", basename(file));
  mkdirSync(join(dir, "failed"), { recursive: true, mode: 0o700 });
  renameSync(file, aside);
  // ponytail: one try; a lost notice still leaves the file in failed/ and the error in the pass log
  if (project) {
    await notify(project, `[调度引擎] 仓库方审查结论没入账（${quoteExternal(error, 300)}），原文在 ${aside}，请 PM 看一眼`)
      .catch((e: unknown) => { rethrowStop(e); console.error(`⚠️ [remote-review] 入账失败的通知没发出：${(e as Error).message}`); });
  }
  return aside;
}

async function bookInbox(config: SchedulerConfig, deps: RemoteReviewStepDeps, dir: string, notify: RemoteReviewStepDeps["notify"] & {}): Promise<Failed> {
  const failed: Failed = [];
  for (const file of listInbox(dir)) {
    let taskId = "-", peer: string | undefined;
    try { ({ taskId, peer } = readInbox(file, dir)); } catch { /* the ledger command reads it again, refuses and says why; the file is parked below */ }
    const r = await deps.manager("ledger", "scheduler-remote-review", taskId, "--inbox", file);
    if (r.ok === true) { unlinkSync(file); continue; }
    if (r.held === true) continue;
    const project = Object.entries(config.projects).find(([, p]) => p.handoffPeer && p.handoffPeer === peer)?.[0];
    const error = String(r.error ?? r.code ?? "unknown");
    const aside = await park(file, dir, project, error, notify);
    failed.push({ taskId, error: `仓库方审查结论没入账，原文移到 ${aside}：${error}` });
  }
  return failed;
}

async function sendNotices(db: Database, projects: readonly string[], deps: RemoteReviewStepDeps, notify: RemoteReviewStepDeps["notify"] & {}): Promise<Failed> {
  const failed: Failed = [], now = deps.now ?? Date.now;
  const memo = failedAt.get(db) ?? new Map<number, number>();
  failedAt.set(db, memo);
  for (const project of projects) {
    for (const n of unsentRemoteNotices(db, project)) {
      if (now() - (memo.get(n.seq) ?? -Infinity) < NOTICE_RETRY_MS) continue;
      try { await notify(project, n.text); } catch (e) {
        rethrowStop(e);
        memo.set(n.seq, now());
        failed.push({ taskId: n.taskId, error: `仓库方审查结论通知 PM 没发出（稍后重发）：${(e as Error).message}` });
        continue;
      }
      memo.delete(n.seq);
      const r = await deps.manager("ledger", "scheduler-remote-review", n.taskId, "--notified", String(n.seq));
      if (r.ok !== true && r.held !== true) failed.push({ taskId: n.taskId, error: `通知已发出但送达没记上（可能再发一次）：${String(r.error ?? r.code)}` });
    }
  }
  return failed;
}

/** Bookings that arrived before the card reached their head act once it has (a P0 must not wait for the next push). */
async function applyLate(db: Database, projects: readonly string[], deps: RemoteReviewStepDeps): Promise<Failed> {
  const failed: Failed = [];
  for (const project of projects) {
    for (const m of lateRemoteMatches(db, project)) {
      const r = await deps.manager("ledger", "scheduler-remote-review", m.taskId, "--apply", String(m.seq));
      if (r.ok !== true && r.held !== true) failed.push({ taskId: m.taskId, error: `仓库方审查结论到 head 后没补上（下一轮再试）：${String(r.error ?? r.code)}` });
    }
  }
  return failed;
}

export async function remoteReviewStep(db: Database, config: SchedulerConfig, deps: RemoteReviewStepDeps): Promise<Failed> {
  const projects = Object.entries(config.projects).filter(([, p]) => p.handoffPeer).map(([id]) => id);
  if (!projects.length) return [];
  const alive = () => { try { deps.active(); return true; } catch { return false; /* not provably active: send nothing */ } };
  const notify = deps.notify ?? ((project: string, text: string) => notifyProjectPm(db, project, text, { fromName: "scheduler", stillActive: alive }));
  const dir = deps.dir ?? REMOTE_INBOX_DIR;
  const booked = await bookInbox(config, deps, dir, notify), late = await applyLate(db, projects, deps);
  return [...booked, ...late, ...await sendNotices(db, projects, deps, notify)];
}
