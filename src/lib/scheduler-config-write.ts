/**
 * The only writer of scheduler.json: one project's `remote.mode` (i28-W5b, `ledger scheduler-remote`). The scheduler re-reads
 * the file every pass and idles on a parse error, so a bad write stops every auto card: the whole file is validated before
 * anything touches disk. The edit is made on the raw JSON object, never on parseSchedulerConfig's result (that one fills
 * defaults, drops unknown keys and carries notes). Lock as lend-config.ts updateLend: no lock = no write. The audit event
 * goes through appendEvent (not ledger-tx); if it fails the file is put back. tests/scheduler-config-write.test.ts.
 */
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { acquireLock, type LockHandle } from "./file-lock.js";
import { actorMayConfigure, textOneLine } from "./ledger-scheduler-settle.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { appendEvent, type WriteCtx } from "./ledger-write.js";
import { parseSchedulerConfig, SCHEDULER_CONFIG_PATH } from "./scheduler-config.js";
import { writeTextAtomicSync } from "./state-file.js";

export type SettableRemoteMode = "balance" | "off";
const SETTABLE_REMOTE_MODES: readonly SettableRemoteMode[] = ["balance", "off"];
const SCHEDULER_REMOTE_OP = "scheduler_remote";

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

/** Pure: edit one project's remote.mode in the raw JSON text; throws LedgerError (invalid / not_found) without producing text. */
export function patchRemoteMode(raw: string, project: string, mode: SettableRemoteMode): RemoteModePatch {
  if (!SETTABLE_REMOTE_MODES.includes(mode)) throw new LedgerError("invalid", `remote.mode 只能切成 balance / off，收到 ${String(mode)}`);
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch (e) { throw new LedgerError("invalid", `scheduler.json 不是合法 JSON：${(e as Error).message}`); }
  if (!isObj(doc)) throw new LedgerError("invalid", "scheduler.json 顶层不是对象");
  const projects = doc.projects;
  if (!isObj(projects) || !Object.hasOwn(projects, project)) throw new LedgerError("not_found", `scheduler.json 里没有项目 ${project}`);
  const p = projects[project];
  if (!isObj(p)) throw new LedgerError("invalid", `scheduler.json 里项目 ${project} 不是对象`);
  if (p.remote !== undefined && !isObj(p.remote)) throw new LedgerError("invalid", `scheduler.json 里项目 ${project} 的 remote 不是对象`);
  const remote = p.remote as Record<string, unknown> | undefined;
  const from = remote?.mode === undefined ? null : String(remote.mode);
  const changed = (from ?? "balance") !== mode;
  if (changed) {
    if (remote) remote.mode = mode;
    else p.remote = { mode };
  }
  let pollMs: number;
  try { pollMs = parseSchedulerConfig(doc).pollMs; }
  catch (e) { throw new LedgerError("invalid", `${changed ? "改完" : "现在"}的 scheduler.json 过不了校验，没写：${(e as Error).message}`); }
  if (!changed) return { text: raw, from, to: mode, changed, pollMs };
  const text = JSON.stringify(doc, null, detectIndent(raw)) + (raw.endsWith("\n") ? "\n" : "");
  return { text, from, to: mode, changed, pollMs };
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

/** --dedup replay: the same key already recorded a scheduler_remote switch for this project → report it, touch nothing. */
function replayed(db: Database, ctx: WriteCtx, project: string, path: string): SetRemoteModeResult | null {
  if (ctx.dedupKey === "") throw new LedgerError("invalid", "dedupKey 不能是空字符串（不要幂等就别传）");
  const prev = ctx.dedupKey ? getEventByDedup(db, ctx.dedupKey) : null;
  if (!prev) return null;
  if (prev.project !== project || prev.target !== "" || prev.kind !== "decision" || prev.data.op !== SCHEDULER_REMOTE_OP) {
    throw new LedgerError("dedup_mismatch", `dedupKey ${ctx.dedupKey} 已被别的动作用过`);
  }
  const d = prev.data as { from: string | null; to: SettableRemoteMode };
  return { project, from: d.from, to: d.to, changed: false, path, event: prev.seq, duplicate: true, pollMs: null };
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

/** Audit the switch; if that fails, put the original bytes back under the same lock and rethrow. */
function audit(db: Database, ctx: WriteCtx, path: string, lock: LockHandle, raw: string, ev: { project: string; reason: string; from: string | null; to: string }): number {
  try {
    const r = appendEvent(db, ctx, { project: ev.project, target: "", kind: "decision", text: ev.reason, data: { op: SCHEDULER_REMOTE_OP, from: ev.from, to: ev.to } });
    if (r.duplicate) throw new LedgerError("dedup_mismatch", `dedupKey ${ctx.dedupKey} 已被别的动作用过`);
    return r.event.seq;
  } catch (e) {
    try { commit(path, raw, lock); }
    catch (re) { console.error(`⚠️ 审计事件没写成，${path} 也没能写回原样（${(re as Error).message}）：现在是 remote.mode = ${ev.to}，请手动核对`); }
    throw e;
  }
}

/** Check → lock → read → patch → write → audit. Every refusal leaves the file untouched (bytes and mtime). */
export async function setRemoteMode(
  db: Database,
  ctx: WriteCtx,
  input: { project: string; mode: string; reason: string },
  opts: { path?: string; lockMs?: number } = {},
): Promise<SetRemoteModeResult> {
  const path = opts.path ?? SCHEDULER_CONFIG_PATH;
  const reason = textOneLine(input.reason, "原因", 600);
  const mode = input.mode as SettableRemoteMode;
  if (!SETTABLE_REMOTE_MODES.includes(mode)) throw new LedgerError("invalid", `remote.mode 只能切成 balance / off，收到 ${input.mode}`);
  if (!actorMayConfigure(db, ctx.actor, input.project)) {
    throw new LedgerError("forbidden", `切 remote.mode 要项目 ${input.project} 的 PM（调度助理除外）/ master / owner（你是 ${ctx.actor}）`);
  }
  if (!existsSync(path)) throw missing(path); // the lock dir lives next to it: a missing directory would only time out as busy
  const lockMs = opts.lockMs ?? 10_000;
  const lock = await acquireLock(`${path}.lock`, lockMs);
  if (!lock) throw new LedgerError("busy", `${path} 正被别的进程占着（${Math.round(lockMs / 1000)} 秒没拿到锁），这次没改，稍后重试`);
  try {
    const dup = replayed(db, ctx, input.project, path);
    if (dup) return dup;
    let raw: string;
    try { raw = readFileSync(path, "utf8"); }
    catch (e) { throw (e as NodeJS.ErrnoException).code === "ENOENT" ? missing(path) : e; }
    const patch = patchRemoteMode(raw, input.project, mode);
    const base = { project: input.project, from: patch.from, to: mode, path, duplicate: false, pollMs: patch.pollMs };
    if (!patch.changed) return { ...base, changed: false, event: null };
    commit(path, patch.text, lock);
    const event = audit(db, ctx, path, lock, raw, { project: input.project, reason, from: patch.from, to: mode });
    return { ...base, changed: true, event };
  } finally {
    lock.release();
  }
}
