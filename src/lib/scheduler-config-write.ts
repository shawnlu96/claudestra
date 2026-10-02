import { hasLocalFamilies, localFamiliesPatch, type LocalFamiliesSet } from "./scheduler-local-families-config.js";
/**
 * The only writer of scheduler.json: one project's `remote.mode` (i28-W5b, `ledger scheduler-remote`) and this machine's
 * `remote.localPriority` / `maxActiveWorkers` (i28-Q1, `ledger scheduler-local`). The scheduler re-reads
 * the file every pass and idles on a parse error, so a bad write stops every auto card: the whole file is validated before
 * anything touches disk. The edit is made on the raw JSON object, never on parseSchedulerConfig's result (that one fills
 * defaults, drops unknown keys and carries notes). Lock as lend-config.ts updateLend: no lock = no write. The audit event
 * goes through appendEvent (not ledger-tx); if it fails the file is put back. tests/scheduler-config-write.test.ts.
 */
import { hasLocalRuntimeSlot, localRuntimePatch, type LocalAuthorRuntime } from "./scheduler-local-runtime-config.js";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { acquireLock, type LockHandle } from "./file-lock.js";
import { actorMayConfigure, textOneLine } from "./ledger-scheduler-settle.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { appendEvent, type WriteCtx } from "./ledger-write.js";
import { isPriority, PRIORITIES, type Priority } from "./lend-config.js";
import { parseSchedulerConfig, SCHEDULER_CONFIG_PATH } from "./scheduler-config.js";
import { writeTextAtomicSync } from "./state-file.js";

export type SettableRemoteMode = "balance" | "off";
const SETTABLE_REMOTE_MODES: readonly SettableRemoteMode[] = ["balance", "off"];
const SCHEDULER_REMOTE_OP = "scheduler_remote";
const SCHEDULER_LOCAL_OP = "scheduler_local";

export interface RemoteModePatch {
  /** New file text; equals the input when nothing changed. */
  text: string;
  /** Mode as written in the file before (legacy spellings kept); null = no remote / no mode (= balance). */
  from: string | null;
  to: SettableRemoteMode;
  changed: boolean;
  /** pollMs of the resulting config: the scheduler picks the change up within one pass. */
  pollMs: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** First indented line = depth 1 of a pretty-printed file; a one-line file gets 2 spaces. */
function detectIndent(raw: string): string | number {
  const m = raw.match(/\n([ \t]+)\S/);
  if (!m) return 2;
  return m[1].includes("\t") ? "\t" : Math.min(m[1].length, 10);
}

/** The raw project object to edit (and the whole doc); throws LedgerError (invalid / not_found). */
function projectOf(raw: string, project: string): { doc: Record<string, unknown>; p: Record<string, unknown>; remote: Record<string, unknown> | undefined } {
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch (e) { throw new LedgerError("invalid", `scheduler.json 不是合法 JSON：${(e as Error).message}`); }
  if (!isObj(doc)) throw new LedgerError("invalid", "scheduler.json 顶层不是对象");
  const projects = doc.projects;
  if (!isObj(projects) || !Object.hasOwn(projects, project)) throw new LedgerError("not_found", `scheduler.json 里没有项目 ${project}`);
  const p = projects[project];
  if (!isObj(p)) throw new LedgerError("invalid", `scheduler.json 里项目 ${project} 不是对象`);
  if (p.remote !== undefined && !isObj(p.remote)) throw new LedgerError("invalid", `scheduler.json 里项目 ${project} 的 remote 不是对象`);
  return { doc, p, remote: p.remote as Record<string, unknown> | undefined };
}

/** Validate the whole edited doc, then serialize in the file's own indent; unchanged = the input text byte for byte. */
function finish(raw: string, doc: Record<string, unknown>, changed: boolean): { text: string; pollMs: number } {
  let pollMs: number;
  try { pollMs = parseSchedulerConfig(doc).pollMs; }
  catch (e) { throw new LedgerError("invalid", `${changed ? "改完" : "现在"}的 scheduler.json 过不了校验，没写：${(e as Error).message}`); }
  if (!changed) return { text: raw, pollMs };
  return { text: JSON.stringify(doc, null, detectIndent(raw)) + (raw.endsWith("\n") ? "\n" : ""), pollMs };
}

/** Pure: edit one project's remote.mode in the raw JSON text; throws LedgerError (invalid / not_found) without producing text. */
export function patchRemoteMode(raw: string, project: string, mode: SettableRemoteMode): RemoteModePatch {
  if (!SETTABLE_REMOTE_MODES.includes(mode)) throw new LedgerError("invalid", `remote.mode 只能切成 balance / off，收到 ${String(mode)}`);
  const { doc, p, remote } = projectOf(raw, project);
  const from = remote?.mode === undefined ? null : String(remote.mode);
  const changed = (from ?? "balance") !== mode;
  if (changed) {
    if (remote) remote.mode = mode;
    else p.remote = { mode };
  }
  return { ...finish(raw, doc, changed), from, to: mode, changed };
}

/** What `scheduler-local` may set; an absent key is left exactly as it is in the file. */
export interface LocalSlots extends LocalFamiliesSet { localPriority?: Priority; maxActiveWorkers?: number; localAuthorRuntime?: LocalAuthorRuntime }
export interface LocalSlotsPatch { text: string; from: LocalSlots; to: LocalSlots; changed: boolean; pollMs: number }

/** maxActiveWorkers' range is parseSchedulerConfig's (0..32); checked here too so a bad value never takes the lock. */
function checkLocalSlots(set: LocalSlots): void {
  if (![hasLocalRuntimeSlot(set), hasLocalFamilies(set)].some(Boolean)) throw new LedgerError("invalid", "至少要改本机档位 / 并发 / 作者运行时 / 家族其中一个");
  if (set.localPriority !== undefined && !isPriority(set.localPriority)) throw new LedgerError("invalid", `localPriority 只能是 ${PRIORITIES.join(" / ")}`);
  const n = set.maxActiveWorkers;
  if (n !== undefined && (!Number.isInteger(n) || n < 0 || n > 32)) throw new LedgerError("invalid", `maxActiveWorkers 要是 0..32 的整数，收到 ${String(n)}`);
}

/** Pure: edit this machine's tier (remote.localPriority, absent = balance) and/or the project's maxActiveWorkers. */
export function patchLocalSlots(raw: string, project: string, set: LocalSlots): LocalSlotsPatch {
  checkLocalSlots(set);
  const { doc, p, remote } = projectOf(raw, project);
  const from: LocalSlots = { ...localRuntimePatch(p, set.localAuthorRuntime), ...localFamiliesPatch(p, set),
    ...(set.localPriority !== undefined ? { localPriority: (remote?.localPriority ?? "balance") as Priority } : {}),
    ...(set.maxActiveWorkers !== undefined ? { maxActiveWorkers: p.maxActiveWorkers as number } : {}),
  };
  const changed = Object.entries(set).some(([k, v]) => from[k as keyof LocalSlots] !== v);
  if (changed && set.localPriority !== undefined) {
    if (remote) remote.localPriority = set.localPriority;
    else p.remote = { ...(p.remote as Record<string, unknown> | undefined), localPriority: set.localPriority };
  }
  if (changed && set.maxActiveWorkers !== undefined) p.maxActiveWorkers = set.maxActiveWorkers;
  return { ...finish(raw, doc, changed), from, to: { ...set }, changed };
}

export interface SetRemoteModeResult {
  project: string;
  from: string | null;
  to: SettableRemoteMode;
  changed: boolean;
  path: string;
  /** seq of the audit event; null when nothing changed */
  event: number | null;
  duplicate: boolean;
  pollMs: number | null;
}

type Patch<F, T> = { text: string; from: F; to: T; changed: boolean; pollMs: number };
interface Write<F, T> { op: string; project: string; reason: string; what: string; patch: (raw: string) => Patch<F, T> }
type WriteResult<F, T> = { project: string; from: F; to: T; changed: boolean; path: string; event: number | null; duplicate: boolean; pollMs: number | null };

/** --dedup replay: the same key already recorded this op for this project → report it, touch nothing. */
function replayed<F, T>(db: Database, ctx: WriteCtx, w: Write<F, T>, path: string): WriteResult<F, T> | null {
  if (ctx.dedupKey === "") throw new LedgerError("invalid", "dedupKey 不能是空字符串（不要幂等就别传）");
  const prev = ctx.dedupKey ? getEventByDedup(db, ctx.dedupKey) : null;
  if (!prev) return null;
  if (prev.project !== w.project || prev.target !== "" || prev.kind !== "decision" || prev.data.op !== w.op) {
    throw new LedgerError("dedup_mismatch", `dedupKey ${ctx.dedupKey} 已被别的动作用过`);
  }
  const d = prev.data as { from: F; to: T };
  return { project: w.project, from: d.from, to: d.to, changed: false, path, event: prev.seq, duplicate: true, pollMs: null };
}

const missing = (path: string) => new LedgerError("not_found", `${path} 不存在，先配置调度服务（这条命令不新建 scheduler.json）`);

/** Atomic write that commits only while the lock is still ours; a lost lock is reported as busy (nothing written). */
function commit(path: string, text: string, lock: LockHandle): void {
  try {
    writeTextAtomicSync(path, text, { preserveMode: true, commitIf: lock.held });
  } catch (e) {
    if (!lock.held()) throw new LedgerError("busy", `提交前发现 ${path} 的锁已被别人回收（进程被挂起太久？），这次没写，重试即可`);
    throw e;
  }
}

/** Audit the edit; if that fails, put the original bytes back under the same lock and rethrow. */
function audit(db: Database, ctx: WriteCtx, path: string, lock: LockHandle, raw: string, ev: { op: string; project: string; reason: string; from: unknown; to: unknown }): number {
  try {
    const r = appendEvent(db, ctx, { project: ev.project, target: "", kind: "decision", text: ev.reason, data: { op: ev.op, from: ev.from, to: ev.to } });
    if (r.duplicate) throw new LedgerError("dedup_mismatch", `dedupKey ${ctx.dedupKey} 已被别的动作用过`);
    return r.event.seq;
  } catch (e) {
    try { commit(path, raw, lock); }
    catch (re) { console.error(`⚠️ 审计事件没写成，${path} 也没能写回原样（${(re as Error).message}）：现在是 ${JSON.stringify(ev.to)}，请手动核对`); }
    throw e;
  }
}

/** Check → lock → read → patch → write → audit. Every refusal leaves the file untouched (bytes and mtime). */
async function writeProject<F, T>(db: Database, ctx: WriteCtx, w: Write<F, T>, opts: { path?: string; lockMs?: number }): Promise<WriteResult<F, T>> {
  const path = opts.path ?? SCHEDULER_CONFIG_PATH;
  if (!actorMayConfigure(db, ctx.actor, w.project)) {
    throw new LedgerError("forbidden", `${w.what}要项目 ${w.project} 的 PM（调度助理除外）/ master / owner（你是 ${ctx.actor}）`);
  }
  if (!existsSync(path)) throw missing(path); // the lock dir lives next to it: a missing directory would only time out as busy
  const lockMs = opts.lockMs ?? 10_000;
  const lock = await acquireLock(`${path}.lock`, lockMs);
  if (!lock) throw new LedgerError("busy", `${path} 正被别的进程占着（${Math.round(lockMs / 1000)} 秒没拿到锁），这次没改，稍后重试`);
  try {
    const dup = replayed(db, ctx, w, path);
    if (dup) return dup;
    let raw: string;
    try { raw = readFileSync(path, "utf8"); }
    catch (e) { throw (e as NodeJS.ErrnoException).code === "ENOENT" ? missing(path) : e; }
    const patch = w.patch(raw);
    const base = { project: w.project, from: patch.from, to: patch.to, path, duplicate: false, pollMs: patch.pollMs };
    if (!patch.changed) return { ...base, changed: false, event: null };
    commit(path, patch.text, lock);
    const event = audit(db, ctx, path, lock, raw, { op: w.op, project: w.project, reason: w.reason, from: patch.from, to: patch.to });
    return { ...base, changed: true, event };
  } finally {
    lock.release();
  }
}

export async function setRemoteMode(
  db: Database,
  ctx: WriteCtx,
  input: { project: string; mode: string; reason: string },
  opts: { path?: string; lockMs?: number } = {},
): Promise<SetRemoteModeResult> {
  const reason = textOneLine(input.reason, "原因", 600);
  const mode = input.mode as SettableRemoteMode;
  if (!SETTABLE_REMOTE_MODES.includes(mode)) throw new LedgerError("invalid", `remote.mode 只能切成 balance / off，收到 ${input.mode}`);
  return writeProject(db, ctx, { op: SCHEDULER_REMOTE_OP, project: input.project, reason, what: "切 remote.mode ", patch: (raw) => patchRemoteMode(raw, input.project, mode) }, opts);
}

export type SetLocalSlotsResult = WriteResult<LocalSlots, LocalSlots>;

/** This machine's tier / project concurrency (i28-Q1); same lock, whole-file validation and audit as setRemoteMode. */
export async function setLocalSlots(
  db: Database,
  ctx: WriteCtx,
  input: { project: string; set: LocalSlots; reason: string },
  opts: { path?: string; lockMs?: number } = {},
): Promise<SetLocalSlotsResult> {
  const reason = textOneLine(input.reason, "原因", 600);
  checkLocalSlots(input.set); // before the permission check and the lock, as setRemoteMode checks the mode
  return writeProject(db, ctx, { op: SCHEDULER_LOCAL_OP, project: input.project, reason, what: "改本机档位 / 并发上限", patch: (raw) => patchLocalSlots(raw, input.project, input.set) }, opts);
}
