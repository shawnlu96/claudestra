/** Claude runtime failures are independent of Codex and survive scheduler/inbox process restarts. */
import type { Database } from "bun:sqlite";
import { getMeta, setMeta, type LendRow } from "./lend-journal.js";
import { PAUSE_FALLBACK_MS, type CodexFailureSeen, type QuotaView } from "./lend-health.js";

const KEY = "pause:claude";
export const CLAUDE_AUTH_FAILURE = "本机 Claude 登录失效（authentication_error / OAuth 刷新失败），请重新登录";
export interface ClaudeFailure extends CodexFailureSeen { resetsAt?: number | null }
interface Failure { at: number; key: string; session: string | null; until: number }
interface Pause { auth?: Failure; quota?: Failure }
interface Readiness { ready: boolean; reason: string | null; at: number }
let cached: Pause = {};

function read(db: Database): Pause {
  try {
    const p = JSON.parse(getMeta(db, KEY) ?? "{}") as Pause;
    if (!p || typeof p !== "object") return {};
    for (const f of [p.auth, p.quota]) {
      if (f && (!Number.isFinite(f.at) || !Number.isFinite(f.until) || typeof f.key !== "string")) return {};
    }
    return p;
  } catch { return {}; /* Invalid journal metadata cannot establish a runtime failure; the worker will be checked again. */ }
}

export function syncClaudePause(db: Database): void { cached = read(db); }
export function resetClaudePauseCache(): void { cached = {}; }

function update(db: Database, fn: (p: Pause) => void): void {
  db.transaction(() => {
    const p = read(db);
    const before = JSON.stringify(p);
    fn(p);
    if (JSON.stringify(p) !== before) setMeta(db, KEY, JSON.stringify(p));
    cached = p;
  }).immediate();
}

/** Re-reading the same failed session while kill is pending must not move the reset deadline. */
export function pauseClaude(db: Database, row: LendRow, f: ClaudeFailure, now: number): number | null {
  update(db, (p) => {
    const seen = `claudeFailure:${row.orderId}`;
    if (getMeta(db, seen) === f.askId) return;
    setMeta(db, seen, f.askId);
    const until = f.resetsAt ?? now + PAUSE_FALLBACK_MS;
    p[f.kind] = { at: now, key: f.askId, session: row.sessionId,
      until: f.kind === "quota" ? Math.max(p.quota?.until ?? 0, until) : 0 };
  });
  return cached.quota?.until ?? null;
}

/** A later auth probe admits a retry; only a real response from a new worker clears the auth latch. */
export function claudePauseReadiness(r: Readiness | null, now: number, pause: Pause = cached): Readiness | null {
  if (pause.auth && (!r?.ready || r.at <= pause.auth.at)) return { ready: false, reason: CLAUDE_AUTH_FAILURE, at: pause.auth.at };
  if (pause.quota && now < pause.quota.until) return {
    ready: false, reason: `本机 Claude 额度已满，${new Date(pause.quota.until).toISOString()} 重置`, at: pause.quota.at,
  };
  return r;
}

export function claudePauseNeedsQuota(): boolean { return !!cached.quota; }

/** loggedIn can remain true for a broken OAuth token: reopen one trial slot, never the whole grant, until a worker succeeds. */
export function claudePauseSlots(slots: number, pause: Pause = cached): number { return pause.auth ? Math.min(1, slots) : slots; }

/** A status reader uses the persisted pause without changing the scheduler cache, probing auth, or clearing a latch. */
export function claudeJournalSlots(db: Database | null, r: Readiness | null, slots: number, now: number): number {
  const pause = db ? read(db) : {};
  return claudePauseReadiness(r, now, pause)?.ready ? claudePauseSlots(slots, pause) : 0;
}

/** Unknown/stale snapshots cannot lift a runtime wall. Newer full snapshots may only extend it. */
export function refreshClaudePause(db: Database, q: QuotaView | null, now: number): void {
  update(db, (p) => {
    if (!p.quota) return;
    const fresh = q?.observedAt !== null && q?.observedAt !== undefined && q.observedAt > p.quota.at;
    if (fresh && q?.full === true && q.resetsAt !== null && q.resetsAt > now) p.quota.until = Math.max(p.quota.until, q.resetsAt);
    if (now >= p.quota.until || (fresh && q?.full === false)) delete p.quota;
  });
}

export function claudeWorkerRecovered(db: Database, row: LendRow, at: number): void {
  update(db, (p) => {
    if (p.auth && row.sessionId !== p.auth.session && (row.startedAt ?? 0) > p.auth.at && at > p.auth.at) delete p.auth;
  });
}
