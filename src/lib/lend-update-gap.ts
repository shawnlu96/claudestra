/**
 * Lender update gap (UPDW): a lend host whose workers keep the launcher's "all agents idle" check busy never updates.
 * The gap is one journal meta row (GAP_KEY) that holds intake (lend-inbox admit, lend-drive claimProblem, lend-loop poll)
 * while the live orders finish or settle on their own; nothing here kills a worker or guesses a terminal state.
 * - The launcher records what it wants (WANT_KEY, refreshed every check) and only spawns `manager update` from a ready gap
 *   (or, with no gap, exactly as before). The lend tick, under the scheduler lease, opens / advances / closes the gap.
 * - Policy is the injected CFG reader for key updateGap: off opens nothing, observe records the plan once per target with no
 *   effect, on opens the gap. An issued update (phase updating) is never withdrawn: it ends only when the update left nothing
 *   behind (no live holder, no unfinished / abandoned update-inflight marker: manager update's own completion record) and the
 *   checkout is at the target (success) or verifiably not (failure: never switched, or rolled back). A version that cannot be
 *   read, or an update left half done, keeps intake held with a diagnostic until the existing update recovery settles it.
 * - The gap is its own row: closing it never clears lend.json grants, revocations, the Codex quota pause or Claude auth pause.
 * tests/lend-update-gap*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { getMeta, LEASED_STATES, setMeta } from "./lend-journal.js";

export const GAP_KEY = "updateGap";
const WANT_KEY = "updateGap:want";
const OBSERVED_KEY = "updateGap:observed";
const COOLDOWN_KEY = "updateGap:cooldown";
/** The launcher checks every 30 minutes; a want older than this means it stopped asking (auto-update off, already updated). */
const WANT_FRESH_MS = 75 * 60_000;
/** A ready gap the launcher has not turned into an update within this long is withdrawn (dirty tree, other agents busy). */
export const READY_MAX_MS = 15 * 60_000;
/** After a withdrawn ready gap, no new gap for the same target this long, so intake is not paused in a loop. */
export const COOLDOWN_MS = 2 * 3600_000;
/** An issued update that left no lock / marker and no exit record is judged failed after this (update waits ≤ 5 min for the lease). */
export const SETTLE_MS = 10 * 60_000;
/** Draining longer than this is reported as stuck in the status line (still never killed: order budgets keep their meaning). */
const DRAIN_DIAG_MS = 3 * 3600_000;

export interface UpdateTarget { channel: "release" | "beta"; ref: string; label: string }
interface Want extends UpdateTarget { at: number; busy: string[] }
type Phase = "draining" | "ready" | "updating";
export interface Gap { phase: Phase; target: UpdateTarget; since: number; readyAt?: number; updatingAt?: number; exited?: { at: number; code: number | null } }

export type GapMode = "on" | "observe" | "off";
/** CFG's updateGap read for this host; diag set when the mode is not a plain read of the configured value. */
export type GapPolicy = () => Promise<{ mode: GapMode; diag?: string }>;

/**
 * What `manager update` left behind (update-inflight.ts): running = a live holder; unfinished = its marker says the tail
 * (install / build / migrate / reload) is still owed; abandoned = the marker for this target was given up on; unknown = the
 * marker or HEAD cannot be read; none = nothing in flight or owed (a marker whose reload provably finished counts as none).
 */
export type UpdateState = { kind: "none" } | { kind: "running" } | { kind: "unfinished"; step: string } | { kind: "abandoned" | "unknown"; why: string };

export interface GapPort {
  policy: GapPolicy;
  /** Has this checkout reached (or passed) the target? null = could not tell. */
  reached(t: UpdateTarget): Promise<boolean | null>;
  /** The update's completion record for this target; only none lets the gap judge success / failure. */
  updateState(t: UpdateTarget): Promise<UpdateState>;
}

function readJson<T>(db: Database, key: string): T | null {
  const v = getMeta(db, key);
  if (!v) return null;
  try { return JSON.parse(v) as T; } catch { return null; /* a torn value reads as absent: worst case one tick without the gap */ }
}

export const readGap = (db: Database): Gap | null => readJson<Gap>(db, GAP_KEY);
const writeGap = (db: Database, g: Gap | null): void => setMeta(db, GAP_KEY, g ? JSON.stringify(g) : "");
/** Intake is held while any gap row exists, whatever its phase. */
export const gapHolds = (db: Database): boolean => readGap(db) !== null;

function freshWant(db: Database, now: number): Want | null {
  const w = readJson<Want>(db, WANT_KEY);
  return w && now - w.at <= WANT_FRESH_MS ? w : null;
}

/** Orders that keep the host busy: holding A's lease, or terminal with settle effects (result hand-over, notices) still owed. */
function drainBlockers(db: Database): { orderId: string; state: string }[] {
  const marks = LEASED_STATES.map(() => "?").join(",");
  return db.query(`SELECT orderId, state FROM lend_orders WHERE state IN (${marks}) OR settle IS NOT NULL ORDER BY createdAt`)
    .all(...LEASED_STATES) as { orderId: string; state: string }[];
}

export interface GapView {
  /** true = intake held this tick */
  held: boolean;
  /** one status line for doctor / lend status; null = nothing to say */
  line: string | null;
}

const ago = (ms: number) => `${Math.round(ms / 60_000)} 分钟`;

/** Writes the tick makes: compare-and-set against the row it read, so a launcher flip to updating in between is never undone. */
type Put = (next: Gap | null) => boolean;
const RACED: GapView = { held: true, line: "出借更新空档：launcher 刚改过空档状态，下一轮再看" };

function casPut(db: Database, raw: string): Put {
  return (next) => db.transaction((): boolean => {
    if ((getMeta(db, GAP_KEY) ?? "") !== raw) return false;
    writeGap(db, next);
    return true;
  }).immediate();
}

/** Close the gap: only its own row; the reason goes to the log. */
function close(put: Put, why: string, log: (m: string) => void): GapView {
  if (!put(null)) return RACED;
  log(`出借更新空档结束，恢复接单：${why}`);
  return { held: false, line: null };
}

/** Held lines of an issued update; stuck (needs the owner, or past DRAIN_DIAG_MS) lines say 卡住 so doctor warns. */
function heldUpdating(g: Gap, now: number, what: string, stuck = false): GapView {
  const t = now - (g.updatingAt ?? g.since);
  return { held: true, line: `出借更新空档：${stuck || t >= DRAIN_DIAG_MS ? `已等 ${ago(t)}，卡住：` : ""}更新到 ${g.target.label} ${what}` };
}

/**
 * An issued update: never withdrawn by policy. Closes only on manager update's own evidence: nothing running or owed
 * (marker cleared after a full reload, or after a rollback) plus a checkout that is verifiably at the target (success) or
 * verifiably not, once the process is gone (failure: never switched or rolled back, the old code still runs). Anything else
 * (live, tail owed, abandoned, unreadable marker / HEAD / version) stays held and says what the owner has to do.
 */
async function settleUpdating(put: Put, g: Gap, port: GapPort, now: number, log: (m: string) => void): Promise<GapView> {
  const u = await port.updateState(g.target);
  if (u.kind === "running") return heldUpdating(g, now, "进行中");
  if (u.kind === "unfinished") return heldUpdating(g, now, `停在「${u.step}」没做完（进程已不在）：跑 bun src/manager.ts update 补完，补完前暂停接单`, true);
  if (u.kind === "abandoned") return heldUpdating(g, now, `的补完被放弃（${u.why}）：按 doctor 的 update 检查人工处理，处理前暂停接单`, true);
  if (u.kind === "unknown") return heldUpdating(g, now, `的进行中标记核不了（${u.why}）：不猜结果，暂停接单`, true);
  const reached = await port.reached(g.target);
  if (reached === true) return close(put, `已到 ${g.target.label}，更新尾段已做完（无进行中 / 待补完标记）`, log);
  if (reached === null) return heldUpdating(g, now, "后核不了版本（git / 版本读不了）：不猜结果，暂停接单，等能读到版本再判", true);
  const gone = g.exited ? `更新进程已退出（code ${g.exited.code ?? "?"}）` : now - (g.updatingAt ?? g.since) >= SETTLE_MS ? `更新发出 ${ago(SETTLE_MS)} 后已不在` : null;
  if (!gone) return heldUpdating(g, now, "已发出，等它开始");
  return close(put, `${gone}，版本没到 ${g.target.label} 且没有待补完标记（没切换或已回退，仍跑原版本）：按已验证失败处理`, log);
}

/** draining / ready: no update issued yet, so a policy change or a lost want can still withdraw it honestly. */
async function advanceOpen(db: Database, put: Put, g: Gap, port: GapPort, now: number, log: (m: string) => void): Promise<GapView> {
  const pol = await port.policy();
  if (pol.mode !== "on") return close(put, `策略改为 ${pol.mode}${pol.diag ? `（${pol.diag}）` : ""}，更新还没发出`, log);
  const want = freshWant(db, now);
  if (!want) return close(put, "launcher 已不再要求更新（自动更新关了或已更新）", log);
  if (want.ref !== g.target.ref) g = { ...g, target: { channel: want.channel, ref: want.ref, label: want.label } };
  const blockers = drainBlockers(db);
  const drained = g.phase === "draining" && !blockers.length;
  if (drained) g = { ...g, phase: "ready", readyAt: now };
  if (g.phase === "ready" && now - (g.readyAt ?? now) >= READY_MAX_MS) {
    const busy = want.busy.length ? `；launcher 说在忙：${want.busy.join(", ").slice(0, 200)}` : "";
    const v = close(put, `排空 ${ago(READY_MAX_MS)} 仍没发出更新${busy}；${ago(COOLDOWN_MS)} 内不再为 ${g.target.label} 开空档`, log);
    if (!v.held) setMeta(db, COOLDOWN_KEY, JSON.stringify({ ref: g.target.ref, until: now + COOLDOWN_MS }));
    return v;
  }
  if (!put(g)) return RACED;
  if (drained) log(`出借更新空档排空，等 launcher 更新到 ${g.target.label}`);
  if (g.phase === "ready") return { held: true, line: `出借更新空档：已排空，等 launcher 更新到 ${g.target.label}` };
  const stuck = now - g.since >= DRAIN_DIAG_MS ? `已等 ${ago(now - g.since)}，卡住：` : "";
  const list = blockers.slice(0, 5).map((b) => `${b.orderId}(${b.state})`).join(", ");
  return { held: true, line: `出借更新空档：暂停接新单，${stuck}等 ${blockers.length} 张在跑 / 待结清的单（${list}）后更新到 ${g.target.label}` };
}

/** No gap yet: open one only under on, for a fresh want, when lend orders are part of what keeps the host busy. */
async function maybeOpen(db: Database, put: Put, port: GapPort, now: number, log: (m: string) => void): Promise<GapView> {
  const want = freshWant(db, now);
  if (!want) return { held: false, line: null };
  const blockers = drainBlockers(db);
  if (!blockers.length) return { held: false, line: null };
  const cool = readJson<{ ref: string; until: number }>(db, COOLDOWN_KEY);
  if (cool && cool.ref === want.ref && now < cool.until) return { held: false, line: `出借更新空档冷却中（${want.label}），照常接单` };
  const pol = await port.policy();
  const plan = `暂停接新单，等 ${blockers.length} 张在跑 / 待结清的单结束后更新到 ${want.label}`;
  if (pol.mode === "off") return { held: false, line: null };
  if (pol.mode === "observe") {
    const seen = readJson<{ ref: string }>(db, OBSERVED_KEY);
    if (seen?.ref !== want.ref) {
      setMeta(db, OBSERVED_KEY, JSON.stringify({ ref: want.ref, at: now, orders: blockers.map((b) => b.orderId) }));
      log(`出借更新空档 observe：本会${plan}${pol.diag ? `（${pol.diag}）` : ""}`);
    }
    return { held: false, line: `出借更新空档 observe：本会${plan}${pol.diag ? `（${pol.diag}）` : ""}` };
  }
  if (!put({ phase: "draining", target: { channel: want.channel, ref: want.ref, label: want.label }, since: now })) return RACED;
  log(`出借更新空档开始：${plan}`);
  return { held: true, line: `出借更新空档：${plan}` };
}

/** The lend tick's step (lend-loop.ts), after the offline revocations and before any intake; under the scheduler lease. */
export async function gapTick(db: Database, port: GapPort, now: number, log: (m: string) => void): Promise<GapView> {
  const raw = getMeta(db, GAP_KEY) ?? "", g = readGap(db), put = casPut(db, raw);
  if (!g) return maybeOpen(db, put, port, now, log);
  if (g.phase === "updating") return settleUpdating(put, g, port, now, log);
  // Not issued by the gap, yet already there (a manual update): close only once that update has finished its tail too.
  if ((await port.reached(g.target)) === true && (await port.updateState(g.target)).kind === "none") return close(put, `已到 ${g.target.label}`, log);
  return advanceOpen(db, put, g, port, now, log);
}

// ---- launcher side (thin wiring in src/launcher.ts through lend-update-gap-host.ts) ----

export type LauncherGo = { go: true } | { go: false; why: string };

/**
 * The launcher found a newer version and auto-update is on: record the want and say whether it may go on. No gap = unchanged
 * behaviour (only when nothing is busy); draining = wait; updating = an update is already out, never a second one; ready =
 * go once nothing is busy. Nothing is flipped here: the launcher still has bail-outs (cooldown, dirty tree, merge queue).
 */
export function launcherGapStep(db: Database, t: UpdateTarget, busy: string[], now: number): LauncherGo {
  setMeta(db, WANT_KEY, JSON.stringify({ ...t, at: now, busy } satisfies Want));
  const g = readGap(db);
  if (g?.phase === "updating") return { go: false, why: `出借空档里已发出更新到 ${g.target.label}，等它的结果` };
  if (g?.phase === "draining") return { go: false, why: "出借空档排空中" };
  if (busy.length) return { go: false, why: `${g ? "出借空档已排空，但" : ""}在忙: ${busy.join(", ")}` };
  return { go: true };
}

/**
 * Right before the spawn: a ready gap becomes updating in one immediate transaction (the tick re-reads the row), so it is
 * never withdrawn after this. No gap = go as before; a gap that turned draining / updating meanwhile = do not spawn.
 */
export function launcherBeginUpdate(db: Database, t: UpdateTarget, now: number): { go: boolean; flipped: boolean } {
  return db.transaction(() => {
    const g = readGap(db);
    if (!g) return { go: true, flipped: false };
    if (g.phase !== "ready") return { go: false, flipped: false };
    writeGap(db, { ...g, target: t, phase: "updating", updatingAt: now });
    return { go: true, flipped: true };
  }).immediate();
}

/** The spawned update exited while the launcher is still alive (a successful update reloads the launcher first). */
export function launcherUpdateExited(db: Database, ref: string, code: number | null, now: number): void {
  db.transaction(() => {
    const g = readGap(db);
    if (g?.phase === "updating" && g.target.ref === ref) writeGap(db, { ...g, exited: { at: now, code } });
  }).immediate();
}

/** The launcher polls faster while a ready gap waits for it (intake is paused meanwhile). */
export const gapAwaitsLauncher = (db: Database): boolean => readGap(db)?.phase === "ready";
