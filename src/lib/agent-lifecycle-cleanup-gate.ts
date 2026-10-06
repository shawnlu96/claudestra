/**
 * Quiets the pending-cleanup retries (agent-lifecycle-run.ts): a debt whose result does not change is neither written to the ledger
 * again nor reported as failed again, and it is retried with a growing back-off (BACKOFF_BASE_MS doubling up to BACKOFF_MAX_MS)
 * instead of every pass. A changed result (other files, other reason, cleanup finished) is recorded and reported once, and the debt
 * is due again on the next pass. The state is a small JSON file (survives restarts), keyed by agent + original session (or the
 * pending row's createdAt when the session is unknown), so a re-created name never shares a debt's state.
 * The gate only ever withholds noise: the first retire is always recorded, a finished cleanup always closes its row, and when the
 * state file cannot be read or written retries run and record as before (logged), never skipped for good.
 */
import { createHash } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import type { RetireRecord } from "./agent-lifecycle-store.js";
import type { Action } from "./agent-lifecycle.js";
import { acquireLock } from "./file-lock.js";
import { statePath } from "./paths.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { writeJsonAtomic } from "./state-file.js";

export const BACKOFF_BASE_MS = 10 * 60_000;
const BACKOFF_MAX_MS = 2 * 3_600_000;
/** A key nobody touched for this long belongs to a debt that is gone. */
const FORGET_MS = 30 * 24 * 3_600_000;

interface Slot { digest: string; n: number; nextAt: number; at: number }
type State = Record<string, Slot>;
export interface GateDeps { now(): number; record(r: RetireRecord): Promise<void>; cleanupStatePath?: string }
type Outcome = { freed: number | null; left: number; quiet?: boolean } | { error: string };

const path = (d: Pick<GateDeps, "cleanupStatePath">) => d.cleanupStatePath ?? statePath("lifecycle-cleanup.json");

function gateKey(a: Pick<Action, "agent" | "sessionId" | "regAt">): string | null {
  if (a.sessionId) return `${a.agent}\0${a.sessionId}`;
  return typeof a.regAt === "number" ? `${a.agent}\0\0${a.regAt}` : null;
}

/** null = unreadable (the caller falls back to ungated). A file that does not parse is set aside and read as empty. */
async function load(d: Pick<GateDeps, "cleanupStatePath" | "now">): Promise<State | null> {
  const p = path(d);
  let raw: string;
  try { raw = await readFile(p, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    console.error(`[lifecycle] 补清退避状态读不了，这轮不退避：${(e as Error).message}`);
    return null;
  }
  try {
    const s = JSON.parse(raw) as unknown;
    if (s && typeof s === "object" && !Array.isArray(s)) return s as State;
  } catch { /* set aside below */ }
  const aside = `${p}.corrupt-${d.now()}`;
  await rename(p, aside).catch((e: Error) => console.error(`[lifecycle] 坏的补清退避状态挪不开：${e.message}`));
  console.error(`[lifecycle] 补清退避状态坏了，已挪到 ${aside}，从空开始（最多多报一次）`);
  return {};
}

async function update(d: GateDeps, key: string, slot: Slot | null): Promise<void> {
  const lock = await acquireLock(`${path(d)}.lock`, 5_000);
  try {
    const s = await load(d);
    if (!s) return;
    const now = d.now();
    for (const [k, v] of Object.entries(s)) if (now - v.at > FORGET_MS) delete s[k];
    if (slot) s[key] = slot;
    else delete s[key];
    await writeJsonAtomic(path(d), s);
  } catch (e) {
    console.error(`[lifecycle] 补清退避状态没写上（下轮按没退避处理）：${(e as Error).message}`);
  } finally { lock?.release(); }
}

/** The retries due this pass: a debt in back-off is left out, so it does not take a slot of the pass's budget either. */
export async function dueRetries(actions: Action[], d: Pick<GateDeps, "cleanupStatePath" | "now">): Promise<Action[]> {
  const s = actions.length ? await load(d) : {};
  if (!s) return actions;
  return actions.filter((a) => {
    const k = gateKey(a);
    return !k || !s[k] || s[k].nextAt <= d.now();
  });
}

/** What a PM would read as "the same": what is left on disk, and the reasons given for exactly those paths. */
function digestOf(r: Pick<RetireRecord, "pending" | "steps">): string {
  const paths = r.pending.flatMap((p) => (p.tmp ? [p.checkout, p.tmp] : [p.checkout]));
  const why = r.steps.filter((s) => paths.some((p) => s.includes(p)));
  return createHash("sha256").update(JSON.stringify({ pending: r.pending, why })).digest("hex");
}

const errorDigest = (msg: string) => createHash("sha256").update(`error:${msg}`).digest("hex");

/**
 * Runs `collect` for one action. A first retire is recorded as always, and remembers its result when disk is left; a retry whose
 * result (or error) equals the last one is not recorded and comes back `quiet`, and backs off. A changed one is recorded, reported
 * and due again next pass. A finished one forgets its key.
 */
export async function gatedCollect<D extends GateDeps>(a: Action, deps: D, collect: (a: Action, deps: D) => Promise<Outcome>): Promise<Outcome> {
  const key = gateKey(a);
  if (!key) return collect(a, deps);
  const retry = a.rule === "cleanup_retry";
  const prev = retry ? (await load(deps))?.[key] ?? null : null;
  const seen: { digest: string | null; same: boolean } = { digest: null, same: false };
  const wrapped: D = { ...deps, record: async (r: RetireRecord) => {
    seen.digest = r.pending.length ? digestOf(r) : null;
    seen.same = !!seen.digest && prev?.digest === seen.digest;
    if (!seen.same) await deps.record(r);
  } };
  const next = (d: string, unchanged: boolean): Slot => {
    const n = unchanged ? (prev?.n ?? 0) + 1 : 0, now = deps.now();
    return { digest: d, n, at: now, nextAt: now + (n ? Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_MAX_MS) : retry ? 0 : BACKOFF_BASE_MS) };
  };
  let out: Outcome;
  try { out = await collect(a, wrapped); } catch (e) {
    if (e instanceof SchedulerStopped || !retry) throw e;
    const d = errorDigest((e as Error).message), unchanged = prev?.digest === d;
    await update(deps, key, next(d, unchanged));
    if (unchanged) return { freed: null, left: a.entries?.length ?? 1, quiet: true };
    throw e;
  }
  if ("error" in out) return out;
  if (!out.left || !seen.digest) { if (retry) await update(deps, key, null); return out; }
  await update(deps, key, next(seen.digest, seen.same));
  return seen.same ? { ...out, quiet: true } : out;
}
