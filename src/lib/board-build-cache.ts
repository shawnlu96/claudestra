/** Process-local board snapshots: keep payloads by reference and bound both query variants and idle projects. */
import type { Database } from "bun:sqlite";
import { recoveryPolicy, type ObservedAction, type RecoveryPolicyPort } from "./recovery-policy.js";

type Query = Readonly<Record<string, string | number | boolean | null>>;
interface Snapshot<T> { asOfSeq: number; value: T }
interface Build<T> {
  endpoint: string;
  project: string;
  query?: Query;
  source?: object;
  enabled?: boolean;
  seq(): number;
  build(): Snapshot<T> | Promise<Snapshot<T>>;
}
interface Entry { key: string; checkedAt: number; snapshot?: Snapshot<unknown> }

export class BoardBuildCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<unknown>>();
  private sources = new WeakMap<object, number>();
  private nextSource = 0;

  constructor(private readonly maxEntries = 64, private readonly intervalMs = 15_000, private readonly clock = Date.now) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(intervalMs) || intervalMs < 0) throw new Error("invalid board cache limits");
  }

  get size(): number { return this.entries.size; }

  async get<T>(input: Build<T>): Promise<T> {
    if (input.enabled === false) return (await input.build()).value;
    const slot = JSON.stringify([input.endpoint, input.project]);
    const key = this.key(input);
    const flight = this.pending.get(key);
    if (flight) {
      const active = this.entries.get(slot);
      if (active?.key === key) this.touch(slot, active);
      return flight as Promise<T>;
    }
    const entry = this.entries.get(slot);
    const now = this.clock();
    if (entry?.key === key && entry.snapshot) {
      this.touch(slot, entry);
      if (now - entry.checkedAt < this.intervalMs) return entry.snapshot.value as T;
      if (input.seq() === entry.snapshot.asOfSeq) {
        entry.checkedAt = now; // Validation time changes; the payload's now/asOfSeq continue to describe its original build.
        return entry.snapshot.value as T;
      }
    }
    const next: Entry = { key, checkedAt: now };
    this.touch(slot, next);
    // Defer the builder until pending is registered, including builders that synchronously re-enter this cache.
    const promise = Promise.resolve().then(input.build).then(snapshot => {
      if (this.entries.get(slot) === next) {
        next.snapshot = snapshot;
        next.checkedAt = this.clock();
      }
      return snapshot.value;
    }).catch(error => {
      if (this.entries.get(slot) === next) this.entries.delete(slot);
      throw error;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  private key(input: Build<unknown>): string {
    let source = input.source && this.sources.get(input.source);
    if (input.source && source === undefined) this.sources.set(input.source, source = ++this.nextSource);
    const query = Object.entries(input.query ?? {}).sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify([input.endpoint, input.project, source ?? null, query]);
  }

  private touch(slot: string, entry: Entry): void {
    this.entries.delete(slot);
    this.entries.set(slot, entry);
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }
}

const boards = new BoardBuildCache();
/** Observe samples go to the process log: board reads must never append ledger events or open a writer. */
function observeBoardBuild(action: ObservedAction): void {
  console.info("[board-build-cache] observe", action.project, action.actionKey, action.action, action.data);
}

/** One read snapshot supplies both the payload and its watermark; a replaced DB connection cannot reuse the previous DB's result. */
export function cachedBoardBuild<T>(db: Database, endpoint: string, project: string, query: Query, build: () => T,
  policy: RecoveryPolicyPort = recoveryPolicy, cache = boards): Promise<T> {
  const mode = policy(project, "boardBuildCache").mode;
  if (mode === "observe") observeBoardBuild({ project, mechanism: "boardBuildCache", target: "", actionKey: endpoint,
    action: "would cache board builds; building fresh in observe mode", data: { query } });
  if (mode !== "on") return Promise.resolve(db.transaction(build).deferred());
  const seq = () => (db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number }).seq;
  return cache.get({ endpoint, project, query, source: db, seq,
    build: () => db.transaction(() => ({ value: build(), asOfSeq: seq() })).deferred() });
}
