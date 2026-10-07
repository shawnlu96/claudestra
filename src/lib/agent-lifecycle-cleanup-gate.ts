/**
 * Quiets pending-cleanup retries (agent-lifecycle-run.ts): an unchanged result (or error) is neither recorded nor reported again and
 * backs off (BACKOFF_BASE_MS doubling to BACKOFF_MAX_MS); a changed one is recorded and reported once. State: a JSON file keyed by
 * agent + original session + the pending row's createdAt, so it survives restarts and a re-created name never shares it.
 * It only withholds noise: a first retire is always recorded, a finished cleanup always closes its row, an unreadable / malformed
 * state means "no back-off" (retry and record), never a debt skipped for good.
 */
import { Database } from "bun:sqlite";
import { LEDGER_PATH } from "./ledger-store.js";
import { createHash } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { manualDueFor, manualOutcome, withFingerprint, type ManualDeps, type ManualKind, type ManualMark, type Porcelain } from "./agent-lifecycle-backoff.js";
import { reportRetireSteps } from "./agent-lifecycle-cleanup-report.js";
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

interface Slot { digest: string; n: number; nextAt: number; at: number; manual?: ManualMark; notified?: ManualKind[] }
type State = Record<string, Slot>;
export interface GateDeps extends ManualDeps { now(): number; record(r: RetireRecord): Promise<void>; cleanupStatePath?: string; cleanupLedgerPath?: string }
type Outcome = { freed: number | null; left: number; quiet?: boolean; notice?: string } | { error: string };

const path = (d: Pick<GateDeps, "cleanupStatePath">) => d.cleanupStatePath ?? statePath("lifecycle-cleanup.json");

function gateKey(a: Pick<Action, "agent" | "sessionId" | "regAt">): string | null {
  return typeof a.regAt === "number" ? `${a.agent}\0${a.sessionId ?? ""}\0${a.regAt}` : null;
}

const finite = (v: unknown, min: number): boolean => typeof v === "number" && Number.isFinite(v) && v >= min;
const isSlot = (v: unknown): v is Slot => !!v && typeof v === "object" && typeof (v as Slot).digest === "string"
  && finite((v as Slot).n, 0) && Number.isInteger((v as Slot).n) && finite((v as Slot).nextAt, 0) && finite((v as Slot).at, 0);

/**
 * null = unreadable (the caller falls back to ungated). A file that does not parse, or holds any malformed slot (a slot without a
 * number nextAt would never be due again), is set aside and read as empty: at worst one more record / report, never a lost debt.
 */
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
    if (s && typeof s === "object" && !Array.isArray(s) && Object.values(s).every(isSlot)) return s as State;
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
export async function dueRetries(actions: Action[], d: Pick<GateDeps, "cleanupStatePath" | "now" | "git">): Promise<Action[]> {
  const s = actions.length ? await load(d) : {};
  if (!s) return actions;
  const now = d.now(), manual = await Promise.all(actions.map((a) => manualDueFor(s[gateKey(a) ?? ""]?.manual, s[gateKey(a) ?? ""]?.notified, a.entries ?? [], now, d.git)));
  // a nextAt further out than the longest back-off (clock moved back, hand edit) is due now rather than parked
  return actions.filter((a, i) => {
    const k = gateKey(a);
    return manual[i] ?? (!k || !s[k] || s[k].nextAt <= now || s[k].nextAt - now > BACKOFF_MAX_MS);
  });
}

/** What a PM would read as "the same": what is left on disk, and the reasons given for exactly those paths. */
function digestOf(r: Pick<RetireRecord, "pending" | "steps">): string {
  const paths = r.pending.flatMap((p) => (p.tmp ? [p.checkout, p.tmp] : [p.checkout]));
  const why = r.steps.filter((s) => paths.some((p) => s.includes(p)));
  return createHash("sha256").update(JSON.stringify({ pending: r.pending, why })).digest("hex");
}

const errorDigest = (msg: string) => createHash("sha256").update(`error:${msg}`).digest("hex");

/** A first retire acquires its concrete pending identities only after the ledger writer creates or updates the rows. */
function initialKeys(a: Action, d: GateDeps, pending: RetireRecord["pending"]): string[] {
  let db: Database | null = null;
  try {
    db = new Database(d.cleanupLedgerPath ?? LEDGER_PATH, { readonly: true });
    const rows = db.query(`SELECT sessionId, createdAt FROM worker_agents WHERE agent = ? AND sessionId = ?
      AND state = 'active' AND reason = ?`).all(a.agent, a.sessionId ?? "", `cleanup_pending:${JSON.stringify(pending)}`) as { sessionId: string; createdAt: number }[];
    return rows.map((r) => gateKey({ agent: a.agent, sessionId: r.sessionId, regAt: r.createdAt })!);
  } catch (e) {
    console.error(`[lifecycle] 首退待补清身份读不了，不预设退避：${(e as Error).message}`);
    return [];
  } finally { db?.close(); }
}

/**
 * Runs `collect` for one action. A first retire is recorded as always, and remembers its result when disk is left; a retry whose
 * result (or error) equals the last one is not recorded and comes back `quiet`, and backs off. A changed one is recorded, reported
 * and due again next pass. A finished one forgets its key.
 */
export async function gatedCollect<D extends GateDeps>(a: Action, deps: D, collect: (a: Action, deps: D) => Promise<Outcome>): Promise<Outcome> {
  const key = gateKey(a);
  const retry = a.rule === "cleanup_retry";
  if (!key && retry) return collect(a, deps);
  const prev = retry ? (await load(deps))?.[key!] ?? null : null;
  const seen: { digest: string | null; same: boolean; pending: RetireRecord["pending"]; steps: string[]; kind: ManualKind | null; por: Porcelain | null } =
    { digest: null, same: false, pending: [], steps: [], kind: null, por: null };
  const wrapped: D = { ...deps, record: async (raw: RetireRecord) => {
    const { r, kind, por } = await withFingerprint(deps, raw);
    seen.pending = r.pending; seen.steps = r.steps; seen.kind = kind; seen.por = por;
    seen.digest = r.pending.length ? digestOf(r) : null;
    seen.same = !!seen.digest && prev?.digest === seen.digest;
    if (!seen.same) await deps.record(await reportRetireSteps(r, path(deps)));
  } };
  const next = (d: string, unchanged: boolean): Slot => {
    const n = unchanged ? (prev?.n ?? 0) + 1 : 0, now = deps.now();
    return { digest: d, n, at: now, nextAt: now + (n ? Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_MAX_MS) : retry ? 0 : BACKOFF_BASE_MS) };
  };
  let out: Outcome;
  try { out = await collect(a, wrapped); } catch (e) {
    if (e instanceof SchedulerStopped || !retry) throw e;
    const d = errorDigest((e as Error).message), unchanged = prev?.digest === d;
    await update(deps, key!, next(d, unchanged));
    if (unchanged) return { freed: null, left: a.entries?.length ?? 1, quiet: true };
    throw e;
  }
  if ("error" in out) return out;
  if (!out.left || !seen.digest) { if (retry) await update(deps, key!, null); return out; }
  const m = await manualOutcome(deps, a, seen, prev?.notified);
  for (const k of retry ? [key!] : initialKeys(a, deps, seen.pending)) {
    await update(deps, k, { ...next(seen.digest, seen.same), ...(m.mark ? { manual: m.mark } : {}), ...(m.notified.length ? { notified: m.notified } : {}) });
  }
  return m.notice ? { ...out, notice: m.notice } : seen.same || m.told ? { ...out, quiet: true } : out;
}
