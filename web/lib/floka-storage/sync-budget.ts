/**
 * WEBQUOTA1 · recovery key `webStorageBudget` (bridge settings deliver it read-only; a bridge without the field = off, the
 * pre-card path). on: the floka_* localStorage mirror gets a byte budget, skips drafts/css, and a failed round undoes only its
 * own mirror writes that nobody changed since; repeated machine syncs coalesce behind a dirty flag (storage events,
 * BroadcastChannel and a short TTL re-mark it). observe: run the off path, record what on would do (one sample per target +
 * action + revision, identifiers only). off: exactly the pre-card behaviour. Independent of `rename.webStorage`; legacy
 * `cstra*` stays the only read authority either way.
 */
import type { StorageMode, StoragePort } from "./config";

export type BudgetMode = StorageMode;
/** Bumped when the budget rules change, so observe samples of a new rule set are recorded again. */
export const BUDGET_REV = "r1";
/** localStorage counts UTF-16 code units; a typical origin quota is ~5 MB, so the mirror stays far below it. */
export const MIRROR_BUDGET_BYTES = 256 * 1024;
export const MIRROR_ENTRY_MAX_BYTES = 32 * 1024;
/** How long a clean sync stays fresh: old pages cannot announce their writes, so this bounds how stale a mirror can get. */
export const SYNC_TTL_MS = 30_000;
const MODE_TTL_MS = 60_000;
const DRAFT_PREFIX = "cstra_draft_";

let delivered: BudgetMode | null = null;
let deliveredAt = Number.NEGATIVE_INFINITY;
let refresher: (() => void) | null = null;

/** Settings response hook: anything but a literal mode (older bridge, missing field) is the legacy path. */
export function noteBudgetMode(value: unknown, now = Date.now()): void {
  delivered = value === "on" || value === "observe" || value === "off" ? value : null;
  deliveredAt = now;
}
export function setBudgetModeRefresher(refresh: (() => void) | null): void {
  refresher = refresh;
}
/** Read before every action. A stale value asks the bridge again in the background, so switching needs no reload. */
export function budgetMode(now = Date.now()): BudgetMode {
  if (refresher && now - deliveredAt > MODE_TTL_MS) {
    deliveredAt = now;
    try { refresher(); } catch { /* the next action asks again */ }
  }
  return delivered ?? "off";
}

export const entryBytes = (key: string, value: string): number => (key.length + value.length) * 2;
/** Drafts and generated css are large, rewritten often and read only from legacy (boot.js, drafts.ts). */
export const mirrorExcluded = (legacyKey: string): boolean => legacyKey.startsWith(DRAFT_PREFIX) || legacyKey.endsWith("_css");
/** Sample target: a draft key carries an agent name, so all drafts share one target. */
export const sampleTarget = (legacyKey: string): string => (legacyKey.startsWith(DRAFT_PREFIX) ? DRAFT_PREFIX : legacyKey);

export function mirrorUsage(storage: StoragePort, prefix: string): number {
  let used = 0;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(prefix)) used += entryBytes(key, storage.getItem(key) ?? "");
  }
  return used;
}

export type Admission = "write" | "excluded" | "entry-too-large" | "over-budget";
/** `used` = current mirror bytes; the key's own old mirror is replaced, so it does not count against itself. */
export function admitMirror(legacyKey: string, mirrorKey: string, value: string, previous: string | null, used: number): Admission {
  if (mirrorExcluded(legacyKey)) return "excluded";
  const size = entryBytes(mirrorKey, value);
  if (size > MIRROR_ENTRY_MAX_BYTES) return "entry-too-large";
  const others = used - (previous === null ? 0 : entryBytes(mirrorKey, previous));
  return others + size > MIRROR_BUDGET_BYTES ? "over-budget" : "write";
}

/** One sync round's own mirror writes, so a failure can undo exactly those. Deletions are never undone. */
export class MirrorRound {
  private writes: { key: string; before: string | null; after: string }[] = [];
  record(key: string, before: string | null, after: string): void {
    this.writes.push({ key, before, after });
  }
  /** Keys whose value changed since our write (another tab, a delete) are left alone; returns the keys undone. */
  revert(storage: StoragePort): string[] {
    const undone: string[] = [];
    for (const write of this.writes.reverse()) {
      try {
        if (storage.getItem(write.key) !== write.after) continue;
        if (write.before === null) storage.removeItem(write.key);
        else {
          try { storage.setItem(write.key, write.before); } catch { storage.removeItem(write.key); } // freeing space wins
        }
        undone.push(write.key);
      } catch {
        // Storage denied mid-undo: the mirror is never read, the next round retries.
      }
    }
    this.writes = [];
    return undone.sort();
  }
}

/** Mirror values this page wrote (hashed): a later mismatch on such a key is our own stale copy, not a conflict. */
const selfWrites = new Map<string, string>();
const digest = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  return `${value.length}:${(hash >>> 0).toString(36)}`;
};
export function noteSelfWrite(mirrorKey: string, value: string | null): void {
  if (value === null) selfWrites.delete(mirrorKey);
  else selfWrites.set(mirrorKey, digest(value));
}
export const isSelfWrite = (mirrorKey: string, value: string | null): boolean => value !== null && selfWrites.get(mirrorKey) === digest(value);

/** What leaves the browser: a key name or area and the would-be action, never a stored value. */
export interface BudgetSample { target: string; actionKey: string }
let sink: ((sample: BudgetSample) => void) | null = null;
const sampled = new Set<string>();
export function setBudgetSampleSink(next: ((sample: BudgetSample) => void) | null): void {
  sink = next;
}
/** observe: what on would have done, once per target + action + rule revision for this page; never a stored value. */
export function observeBudget(area: "localStorage" | "indexedDB", target: string, action: string): void {
  const actionKey = `${area}:${action}:${BUDGET_REV}`;
  if (sampled.has(`${target}\0${actionKey}`)) return;
  sampled.add(`${target}\0${actionKey}`);
  console.info("[floka-storage] webStorageBudget observe", { target, action: actionKey });
  try { sink?.({ target, actionKey }); } catch { /* samples are best effort */ }
}

/** Repeated reports (each access re-reports the same plan) are logged once until they change. */
const lastReports = new Map<string, string>();
export function reportOnce(area: string, signature: string, log: () => void): void {
  if (lastReports.get(area) === signature) return;
  lastReports.set(area, signature);
  log();
}

/**
 * Coalesces sync requests: a clean, fresh state answers at once; while one sync runs, every request joins it, or (when
 * something changed meanwhile) one shared follow-up. At most two runs are ever in line, however many callers.
 */
export function coalescedSync(run: () => Promise<void>, options: { ttlMs?: number; now?: () => number } = {}) {
  const ttl = options.ttlMs ?? SYNC_TTL_MS;
  const now = options.now ?? Date.now;
  let dirty = true;
  let syncedAt = Number.NEGATIVE_INFINITY;
  let running: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  const start = (): Promise<void> => {
    dirty = false;
    const current = run().then(
      () => { syncedAt = now(); },
      () => { dirty = true; }, // failures retry on the next access; the caller already read legacy
    ).finally(() => { if (running === current) running = null; });
    running = current;
    return current;
  };
  return {
    markDirty(): void { dirty = true; },
    isDirty: (): boolean => dirty || now() - syncedAt > ttl,
    request(): Promise<void> {
      const stale = dirty || now() - syncedAt > ttl;
      if (!running) return stale ? start() : Promise.resolve();
      if (!dirty) return running;
      queued ??= running.then(() => { queued = null; return start(); });
      return queued;
    },
  };
}

/** Reset module state between tests. */
export function resetBudgetForTest(): void {
  delivered = null;
  deliveredAt = Number.NEGATIVE_INFINITY;
  refresher = null;
  sink = null;
  sampled.clear();
  selfWrites.clear();
  lastReports.clear();
}
