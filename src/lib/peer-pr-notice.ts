/**
 * Shared plumbing of the peer PR tick (i28-A2): the injected edges, the per-database memory, the ledger record call and the
 * "PM hears exactly once" notice. A notice is written to the ledger first (its text fixed there), then sent, then marked sent;
 * a failed send is retried every NOTICE_RETRY_MS until the mark exists, so an outage delays a notice instead of losing it,
 * and only a crash between the send and the mark can repeat one. Every edge is wrapped by the pass's liveness guard.
 */
import type { Database } from "bun:sqlite";
import type { bridgeSend } from "./bridge-client.js";
import { getEventByDedup } from "./ledger-store.js";
import type { PeerPrConfig } from "./peer-pr-config.js";
import type { PeerPrGithub } from "./peer-pr-github.js";
import { pushDedupKey, unsentNotices, type PushResult } from "./peer-pr-ledger.js";
import type { LocalIdentity } from "./peer-pr-redact.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

export type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
export type BridgeSendResult = Awaited<ReturnType<typeof bridgeSend>>;

export interface PeerPrDeps {
  github: PeerPrGithub;
  /** 40 / 64-hex values that are commits of repoDir (git cat-file --batch-check). */
  commits(shas: readonly string[]): Promise<Set<string>>;
  /** The ledger CLI under the scheduler identity. */
  manager: Manager;
  /** One `peer_pr_push` frame to the bridge (bridgeSend with the pass's stillActive). */
  bridge(frame: Record<string, unknown>): Promise<BridgeSendResult>;
  notifyPm(project: string, text: string): Promise<void>;
  /** A review report, only from under ledger/reviews and at most REPORT_MAX_BYTES. */
  readReport(path: string): { text: string } | { error: string };
  identity: LocalIdentity;
  now(): number;
}

export interface PeerPrState {
  /** PR number → the head seen, since when, how many polls in a row. */
  heads: Map<number, { head: string; since: number; seen: number }>;
  lastPoll: number;
  repo: string | null;
  noticeFailAt: Map<string, number>;
  verifyAt: Map<string, number>;
}

export interface PeerPrCtx { db: Database; cfg: PeerPrConfig; deps: PeerPrDeps; state: PeerPrState }

const states = new WeakMap<Database, PeerPrState>();
export function stateFor(db: Database): PeerPrState {
  let s = states.get(db);
  if (!s) states.set(db, (s = { heads: new Map(), lastPoll: 0, repo: null, noticeFailAt: new Map(), verifyAt: new Map() }));
  return s;
}

const NOTICE_RETRY_MS = 60_000;
export const oneLine = (s: string, max = 400): string => s.replace(/\s+/g, " ").trim().slice(0, max);

/** A stop / lost lease always ends the pass; any other failure of one step is logged and the step is retried later. */
export function logUnlessStopped(what: string, e: unknown): void {
  if (e instanceof SchedulerStopped) throw e;
  console.error(`⚠️ [peer-pr] ${what}：${(e as Error).message}`);
}

export async function record(c: PeerPrCtx, target: string, key: string, result: PushResult, text: string, data?: Record<string, unknown>) {
  return c.deps.manager("ledger", "peer-pr-push-record", target || "-", "--project", c.cfg.project, "--key", key, "--result", result,
    "--text", text, ...(data ? ["--data", JSON.stringify(data)] : []));
}

/** PM hears `text` once per (target, key); target "" = project level. Returns once the notice is marked sent (or will retry). */
export async function noticeOnce(c: PeerPrCtx, target: string, key: string, text: string): Promise<void> {
  const scope = target || `-${c.cfg.project}`;
  if (getEventByDedup(c.db, pushDedupKey(scope, key, "notice_sent")!)) return;
  const memo = `${scope}:${key}`;
  const failedAt = c.state.noticeFailAt.get(memo);
  if (failedAt !== undefined && c.deps.now() - failedAt < NOTICE_RETRY_MS) return;
  let msg = getEventByDedup(c.db, pushDedupKey(scope, key, "notice")!)?.text;
  if (!msg) {
    const r = await record(c, target, key, "notice", text);
    if (r.ok !== true) return console.error(`⚠️ [peer-pr] 通知 PM 没记上台账（下一轮再试）：${String(r.error)}`);
    msg = text;
  }
  try {
    await c.deps.notifyPm(c.cfg.project, msg);
  } catch (e) {
    logUnlessStopped("通知 PM 没发出去（台账已记，稍后重发）", e);
    c.state.noticeFailAt.set(memo, c.deps.now());
    return;
  }
  c.state.noticeFailAt.delete(memo);
  const done = await record(c, target, key, "notice_sent", "已通知 PM");
  if (done.ok !== true) console.error(`⚠️ [peer-pr] 通知已发出但送达没记上（可能再发一次）：${String(done.error)}`);
}

/** One more try for every notice still unsent, whatever wrote it; each keeps its own NOTICE_RETRY_MS spacing. */
export async function retryNotices(c: PeerPrCtx): Promise<string[]> {
  const out: string[] = [];
  for (const n of unsentNotices(c.db, c.cfg.project)) {
    await noticeOnce(c, n.target, n.key, n.text);
    if (getEventByDedup(c.db, pushDedupKey(n.target || `-${c.cfg.project}`, n.key, "notice_sent")!)) out.push(`通知 ${n.target || "-"} ${n.key} 补发了`);
  }
  return out;
}

/** Give the card to PM through the existing fallback, then tell PM once. */
export async function fallbackOnce(c: PeerPrCtx, taskId: string, code: string, reason: string): Promise<void> {
  const r = await c.deps.manager("ledger", "scheduler-fallback-manual", taskId, "--reason", oneLine(reason, 560));
  if (r.ok !== true) return console.error(`⚠️ [peer-pr] ${taskId} 退回人工没写进台账：${String(r.error)}`);
  await noticeOnce(c, taskId, `fallback:${code}`, `[调度引擎] ${taskId} peer PR 自动流程停下，退回人工，请接手：${oneLine(reason)}`);
}
