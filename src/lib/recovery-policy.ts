/**
 * Dispatch recovery policy (dispatch-recovery-CFG): the one typed switch every recovery mechanism reads, so no mechanism
 * keeps its own flag. Own file recovery-policy.json (never scheduler.json, whose semantics stay as they are):
 * `{ projects: { <id>: { mode?, manualStallHours?, keys?: { <RecoveryKey>: mode } } } }`; absent = observe, no threshold.
 * - off: no action, nothing recorded. observe: only record the would-be action (recordObserved: one ledger note per dedup
 *   key, no dispatch, no state change, no notification). on: the mechanism acts.
 * An unknown key or an unreadable / invalid file answers off with a diagnostic (conservative stop). manualStallHours is the
 * owner's number: unset = a manual card is never force-recovered whatever the mode. Writes: `ledger scheduler-recovery`.
 * Mechanisms take a RecoveryPolicyPort injected at wiring time instead of binding this file. tests/recovery-policy*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { acquireLock, type LockHandle } from "./file-lock.js";
import { actorMayConfigure, textOneLine } from "./ledger-scheduler-settle.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { appendEvent, type WriteCtx } from "./ledger-write.js";
import { statePath } from "./paths.js";
import { writeTextAtomicSync } from "./state-file.js";

export const RECOVERY_POLICY_PATH = statePath("recovery-policy.json");
type RecoveryMode = "on" | "observe" | "off";
const RECOVERY_MODES: readonly RecoveryMode[] = ["on", "observe", "off"];
const isRecoveryMode = (v: unknown): v is RecoveryMode => RECOVERY_MODES.includes(v as RecoveryMode);
/** One per recovery mechanism; a new mechanism adds its key here so the file, the CLI and the reader all know it. */
export const RECOVERY_KEYS = ["materials", "localFallback", "localDelivery", "modelOutcome", "askReminder", "manualStall", "planGap", "audit"] as const;
export type RecoveryKey = (typeof RECOVERY_KEYS)[number];
const isRecoveryKey = (v: unknown): v is RecoveryKey => RECOVERY_KEYS.includes(v as RecoveryKey);
const DEFAULT_RECOVERY_MODE: RecoveryMode = "observe";
export const MANUAL_STALL_HOURS_MAX = 720;
const HOUR_MS = 3_600_000;
const validHours = (h: unknown): h is number => Number.isInteger(h) && (h as number) >= 1 && (h as number) <= MANUAL_STALL_HOURS_MAX;
const RECOVERY_OP = "scheduler_recovery";
const RECOVERY_OBSERVE_OP = "recovery_observe";

interface ProjectRecovery { mode?: RecoveryMode; manualStallHours?: number; keys?: Partial<Record<RecoveryKey, RecoveryMode>> }
interface RecoveryFile { projects: Record<string, ProjectRecovery> }
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Strict: unknown names and bad values make the whole file invalid, so a typo never silently means "observe". */
function parseRecoveryFile(data: unknown): RecoveryFile {
  if (!isObj(data) || !isObj(data.projects) || Object.keys(data).some((k) => k !== "projects")) throw new Error("顶层要是 { projects: {...} }");
  for (const [id, p] of Object.entries(data.projects)) {
    if (!isObj(p) || Object.keys(p).some((k) => !["mode", "manualStallHours", "keys"].includes(k))) throw new Error(`项目 ${id} 只能有 mode / manualStallHours / keys`);
    if (p.mode !== undefined && !isRecoveryMode(p.mode)) throw new Error(`项目 ${id} 的 mode 要是 ${RECOVERY_MODES.join(" / ")}`);
    if (p.manualStallHours !== undefined && !validHours(p.manualStallHours)) throw new Error(`项目 ${id} 的 manualStallHours 要是 1..${MANUAL_STALL_HOURS_MAX} 的整数`);
    if (p.keys !== undefined && (!isObj(p.keys) || Object.entries(p.keys).some(([k, m]) => !isRecoveryKey(k) || !isRecoveryMode(m)))) {
      throw new Error(`项目 ${id} 的 keys 只能是 { ${RECOVERY_KEYS.join(" / ")}: ${RECOVERY_MODES.join(" / ")} }`);
    }
  }
  return data as unknown as RecoveryFile;
}

type FileRead = { status: "missing" } | { status: "ok"; data: RecoveryFile; raw: string } | { status: "corrupt"; error: string };
function readRecoveryFile(path: string): FileRead {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { status: "missing" } : { status: "corrupt", error: (e as Error).message }; }
  try { return { status: "ok", data: parseRecoveryFile(JSON.parse(raw)), raw }; }
  catch (e) { return { status: "corrupt", error: (e as Error).message }; }
}

export interface RecoveryPolicy {
  mode: RecoveryMode;
  /** null = never force-recover a manual card */
  manualAfterMs: number | null;
  /** config = this project has an entry; default = file or entry absent; error = unknown key / bad file, mode forced off */
  source: "config" | "default" | "error";
  diagnostic?: string;
}
/** What mechanisms are handed (tests inject a fake); recoveryPolicy is the file-backed one. */
export type RecoveryPolicyPort = (project: string, key: RecoveryKey) => RecoveryPolicy;
const stopped = (diagnostic: string): RecoveryPolicy => ({ mode: "off", manualAfterMs: null, source: "error", diagnostic });

/** Read every time, never throws. Effective mode: keys[key] → project mode → observe. */
export function recoveryPolicy(project: string, key: RecoveryKey, path = RECOVERY_POLICY_PATH): RecoveryPolicy {
  if (!isRecoveryKey(key)) return stopped(`未知恢复键 ${String(key)}（只认 ${RECOVERY_KEYS.join(" / ")}）`);
  const r = readRecoveryFile(path);
  if (r.status === "corrupt") return stopped(`${path} 读不了，恢复停手：${r.error}`);
  const cfg = r.status === "ok" && Object.hasOwn(r.data.projects, project) ? r.data.projects[project] : undefined;
  return { mode: cfg?.keys?.[key] ?? cfg?.mode ?? DEFAULT_RECOVERY_MODE, manualAfterMs: cfg?.manualStallHours ? cfg.manualStallHours * HOUR_MS : null,
    source: cfg ? "config" : "default" };
}

/** What a mechanism may do with one candidate: act (on), observe (record only) or skip (off / below threshold). */
export type RecoveryDecision = { kind: "act" } | { kind: "observe" } | { kind: "skip"; reason: string };

/**
 * manualStalledMs: set only when the candidate is a manual card, with how long it has been stalled. Such a candidate needs
 * the owner's threshold and must be past it, in every mode, so observe never reports a forced recovery that on would refuse.
 */
export function decideRecovery(policy: RecoveryPolicy, candidate: { manualStalledMs?: number } = {}): RecoveryDecision {
  if (policy.mode === "off") return { kind: "skip", reason: policy.diagnostic ?? "恢复策略是 off" };
  if (candidate.manualStalledMs !== undefined) {
    if (policy.manualAfterMs === null) return { kind: "skip", reason: "没设 manualStallHours：手动卡不强制恢复" };
    if (candidate.manualStalledMs < policy.manualAfterMs) return { kind: "skip", reason: `手动卡停滞未满 ${policy.manualAfterMs / HOUR_MS} 小时` };
  }
  return { kind: policy.mode === "on" ? "act" : "observe" };
}

const PART = /^[\w.:@/-]{1,120}$/;
/** What observe records; dedup = project + key + target + actionKey, so the same would-be action is one event. */
export interface ObservedAction { project: string; key: RecoveryKey; target: string; actionKey: string; action: string; data?: Record<string, unknown> }

export function observeDedupKey(a: Pick<ObservedAction, "project" | "key" | "target" | "actionKey">): string {
  if (!isRecoveryKey(a.key)) throw new LedgerError("invalid", `未知恢复键 ${String(a.key)}`);
  if (!PART.test(a.actionKey) || (a.target && !PART.test(a.target))) {
    throw new LedgerError("invalid", `恢复观察的 actionKey / target 要是 1..120 个 [\\w.:@/-] 字符，收到 ${JSON.stringify([a.actionKey, a.target])}`);
  }
  return `recovery-observe:${a.project}:${a.key}:${a.target || "-"}:${a.actionKey}`;
}

/**
 * One note event per would-be action. The dedup key is UNIQUE in the ledger and appendEvent runs in an immediate
 * transaction, so concurrent ticks recording the same action leave exactly one event. Returns whether this call wrote it.
 */
export function recordObserved(db: Database, a: ObservedAction, now: number): { recorded: boolean; seq: number } {
  const dedupKey = observeDedupKey(a);
  const text = textOneLine(`恢复观察（${a.key}）：本会 ${a.action}`, "观察说明", 600);
  const r = appendEvent(db, { actor: "scheduler", now, dedupKey },
    { project: a.project, target: a.target, kind: "note", text, data: { ...a.data, op: RECOVERY_OBSERVE_OP, key: a.key, actionKey: a.actionKey } });
  return { recorded: !r.duplicate, seq: r.event.seq };
}

export type GateOutcome<T> = { outcome: "acted"; value: T } | { outcome: "observed"; recorded: boolean } | { outcome: "skipped"; reason: string };
/**
 * The gate a mechanism wraps its action in. The policy is read right before acting; observe records instead of calling act.
 * act runs only under on and past the thresholds; its own writes keep their own CAS / locks.
 */
export async function gateRecovery<T>(db: Database, a: ObservedAction & { manualStalledMs?: number }, act: () => Promise<T> | T,
  opts: { now: number; policy?: RecoveryPolicyPort }): Promise<GateOutcome<T>> {
  const d = decideRecovery((opts.policy ?? recoveryPolicy)(a.project, a.key), a);
  if (d.kind === "skip") return { outcome: "skipped", reason: d.reason };
  if (d.kind === "observe") return { outcome: "observed", recorded: recordObserved(db, a, opts.now).recorded };
  return { outcome: "acted", value: await act() };
}

/** What `scheduler-recovery` may set. key + mode = that key's override ("inherit" drops it); manualStallHours null = clear. */
export interface RecoverySet { mode?: RecoveryMode | "inherit"; key?: RecoveryKey; manualStallHours?: number | null }
type RecoveryState = { mode: RecoveryMode | null; manualStallHours: number | null; keys: Partial<Record<RecoveryKey, RecoveryMode>> };

function checkSet(set: RecoverySet): void {
  if (set.mode === undefined && set.manualStallHours === undefined) throw new LedgerError("invalid", "至少要改恢复模式或 manualStallHours 其中一个");
  if (set.key !== undefined && !isRecoveryKey(set.key)) throw new LedgerError("invalid", `--key 只能是 ${RECOVERY_KEYS.join(" / ")}，收到 ${String(set.key)}`);
  if (set.key !== undefined && set.mode === undefined) throw new LedgerError("invalid", "--key 要和模式一起给（on / observe / off / inherit）");
  const modes: readonly string[] = set.key ? [...RECOVERY_MODES, "inherit"] : RECOVERY_MODES;
  if (set.mode !== undefined && !modes.includes(set.mode)) throw new LedgerError("invalid", `恢复模式只能是 ${modes.join(" / ")}，收到 ${String(set.mode)}`);
  const h = set.manualStallHours;
  if (h !== undefined && h !== null && !validHours(h)) {
    throw new LedgerError("invalid", `manualStallHours 要是 1..${MANUAL_STALL_HOURS_MAX} 的整数（或 none 清掉），收到 ${String(h)}`);
  }
}

const stateOf = (p: ProjectRecovery | undefined): RecoveryState => ({ mode: p?.mode ?? null, manualStallHours: p?.manualStallHours ?? null, keys: { ...p?.keys } });

/** Pure: the project's entry after `set`; empty parts are dropped so a cleared project leaves no residue. */
function applySet(cur: ProjectRecovery | undefined, set: RecoverySet): ProjectRecovery {
  const next: ProjectRecovery = { ...cur, keys: { ...cur?.keys } };
  if (set.key && set.mode === "inherit") delete next.keys![set.key];
  else if (set.key) next.keys![set.key] = set.mode as RecoveryMode;
  else if (set.mode !== undefined) next.mode = set.mode as RecoveryMode;
  if (set.manualStallHours === null) delete next.manualStallHours;
  else if (set.manualStallHours !== undefined) next.manualStallHours = set.manualStallHours;
  if (!Object.keys(next.keys!).length) delete next.keys;
  return next;
}

/** --dedup replay: the same key already recorded this op for this project → report it, touch nothing. */
function replayed(db: Database, ctx: WriteCtx, project: string) {
  if (ctx.dedupKey === "") throw new LedgerError("invalid", "dedupKey 不能是空字符串（不要幂等就别传）");
  const prev = ctx.dedupKey ? getEventByDedup(db, ctx.dedupKey) : null;
  if (!prev) return null;
  if (prev.project !== project || prev.target !== "" || prev.kind !== "decision" || prev.data.op !== RECOVERY_OP) {
    throw new LedgerError("dedup_mismatch", `dedupKey ${ctx.dedupKey} 已被别的动作用过`);
  }
  return { from: prev.data.from as RecoveryState, to: prev.data.to as RecoveryState, event: prev.seq };
}

/**
 * Modes: same permission as every scheduler switch (actorMayConfigure: PM other than the dispatcher / master / owner).
 * manualStallHours is the owner's number and is never delegated: anyone else touching it is refused before the lock.
 * Check → lock → read → edit → atomic write (only while the lock is ours) → audit event; a failed audit puts the old bytes
 * back. A corrupt file is refused, never overwritten: readers already treat it as off.
 */
export async function setRecovery(db: Database, ctx: WriteCtx, input: { project: string; set: RecoverySet; reason: string },
  opts: { path?: string; lockMs?: number } = {}) {
  const path = opts.path ?? RECOVERY_POLICY_PATH, { project, set } = input;
  const reason = textOneLine(input.reason, "原因", 600);
  checkSet(set);
  if (set.manualStallHours !== undefined && ctx.actor !== "owner") throw new LedgerError("forbidden", `manualStallHours 只有 owner 能设（你是 ${ctx.actor}）`);
  if (!actorMayConfigure(db, ctx.actor, project)) throw new LedgerError("forbidden", `改恢复策略要项目 ${project} 的 PM（调度助理除外）/ master / owner（你是 ${ctx.actor}）`);
  mkdirSync(dirname(path), { recursive: true });
  const lockMs = opts.lockMs ?? 10_000;
  const lock = await acquireLock(`${path}.lock`, lockMs);
  if (!lock) throw new LedgerError("busy", `${path} 正被别的进程占着（${Math.round(lockMs / 1000)} 秒没拿到锁），这次没改，稍后重试`);
  try {
    const dup = replayed(db, ctx, project);
    if (dup) return { project, ...dup, changed: false, duplicate: true, event: dup.event, path };
    const r = readRecoveryFile(path);
    if (r.status === "corrupt") throw new LedgerError("invalid", `${path} 坏了（${r.error}），恢复已按 off 停手；没写，先手动修好`);
    const doc = r.status === "ok" ? r.data : { projects: {} };
    const next = applySet(Object.hasOwn(doc.projects, project) ? doc.projects[project] : undefined, set);
    const from = stateOf(doc.projects[project]), to = stateOf(next);
    if (JSON.stringify(from) === JSON.stringify(to)) return { project, from, to, changed: false, duplicate: false, event: null, path };
    const before = r.status === "ok" ? r.raw : null;
    commit(path, JSON.stringify({ projects: { ...doc.projects, [project]: next } }, null, 2) + "\n", lock);
    try {
      const ev = appendEvent(db, ctx, { project, target: "", kind: "decision", text: reason, data: { op: RECOVERY_OP, from, to } });
      if (ev.duplicate) throw new LedgerError("dedup_mismatch", `dedupKey ${ctx.dedupKey} 已被别的动作用过`);
      return { project, from, to, changed: true, duplicate: false, event: ev.event.seq, path };
    } catch (e) {
      try { if (before === null) rmSync(path, { force: true }); else commit(path, before, lock); }
      catch (re) { console.error(`⚠️ 恢复策略审计没写成，${path} 也没能还原（${(re as Error).message}）：请手动核对`); }
      throw e;
    }
  } finally {
    lock.release();
  }
}

function commit(path: string, text: string, lock: LockHandle): void {
  try { writeTextAtomicSync(path, text, { preserveMode: true, commitIf: lock.held }); }
  catch (e) {
    if (!lock.held()) throw new LedgerError("busy", `提交前发现 ${path} 的锁已被别人回收，这次没写，重试即可`);
    throw e;
  }
}

/** Every key's effective policy for one project (the CLI's read view). */
export function recoveryPolicies(project: string, path = RECOVERY_POLICY_PATH): Record<RecoveryKey, RecoveryPolicy> {
  return Object.fromEntries(RECOVERY_KEYS.map((k) => [k, recoveryPolicy(project, k, path)])) as Record<RecoveryKey, RecoveryPolicy>;
}

/** The last `last` would-be actions observe recorded for a project, newest first (dedup prefix, so other notes never match). */
export function observedRecent(db: Database, project: string, last: number) {
  const rows = db.prepare("SELECT seq, ts, target, text, data FROM events WHERE project = ? AND kind = 'note' AND dedupKey LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT ?")
    .all(project, `recovery-observe:${project.replace(/[%_\\]/g, "\\$&")}:%`, last) as { seq: number; ts: number; target: string; text: string; data: string }[];
  return rows.map((r) => {
    const d = JSON.parse(r.data) as { key?: string };
    return { seq: r.seq, at: new Date(r.ts).toISOString(), target: r.target, key: d.key ?? "", text: r.text };
  });
}
