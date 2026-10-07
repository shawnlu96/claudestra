/**
 * Machine recovery policy (dispatch-recovery-LCFG1W): the whole-machine namespace of recovery-policy.json, for mechanisms
 * that belong to this machine rather than to any project (lendConfigFailure: the lender's provider config fault).
 * `{ projects: {...}, machine: { <MachineRecoveryKey>: { mode?, rev? } } }`; absent = observe. No pseudo project: a project
 * entry (even one named "lend") never answers a machine key, and old files without `machine` read as before.
 * - recovery-policy.ts's file parser takes the section as an opaque object and hands it to parseMachineSection (injected:
 *   readRecoveryFile(path, parseMachineSection), no import cycle). An unknown machine key or a bad value makes the file invalid
 *   for every machine reader → off with a diagnostic, and the machine writer refuses it; project readers keep their own entries.
 * - Writes (`ledger scheduler-recovery --machine`) are owner / master only: the machine-wide identities. PMs, peers, workers
 *   and guests have only project scope; a PM who needs a switch asks the owner. The file lock, the atomic writer, the file
 *   reader and the published / void settle notes are recovery-policy.ts's own (imported, not copied); both writers hold the
 *   same lock and keep the other's section, so concurrent project / machine saves lose nothing.
 * Audits are ledger decisions in the master bucket with their own op, so project settling never sees them. tests/recovery-machine-policy*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MASTER_PROJECT } from "./ledger-asks.js";
import { acquireLock } from "./file-lock.js";
import { textOneLine } from "./ledger-scheduler-settle.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { tx } from "./ledger-tx.js";
import { appendEvent, type WriteCtx } from "./ledger-write.js";
import {
  commitRecoveryFile, isRecoveryMode, RECOVERY_MODES, RECOVERY_POLICY_PATH, readRecoveryFile, recoveryPublishedKey, recoveryVoidKey, settleRecoveryNote,
  type RecoveryMode, type RecoveryPolicy,
} from "./recovery-policy.js";

/** One per machine-wide mechanism; a new one adds its key here (file, CLI and reader all follow). */
export const MACHINE_RECOVERY_KEYS = ["lendConfigFailure"] as const;
export type MachineRecoveryKey = (typeof MACHINE_RECOVERY_KEYS)[number];
const isMachineKey = (v: unknown): v is MachineRecoveryKey => MACHINE_RECOVERY_KEYS.includes(v as MachineRecoveryKey);
/** rev = seq of the audit whose change this entry is (same proof-of-publish as a project entry). */
interface MachineEntry { mode?: RecoveryMode; rev?: number }
export type MachineRecovery = Partial<Record<MachineRecoveryKey, MachineEntry>>;
/** What mechanisms are handed; machineRecoveryPolicy is the file-backed one. */
export type MachinePolicyPort = (mechanism: MachineRecoveryKey) => RecoveryPolicy;
const DEFAULT_MODE: RecoveryMode = "observe";
const MACHINE_OP = "scheduler_recovery_machine";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const stopped = (diagnostic: string): RecoveryPolicy => ({ mode: "off", manualAfterMs: null, source: "error", diagnostic });

/** Strict, injected into recovery-policy.ts's file parser: throws on any unknown name or bad value. */
export function parseMachineSection(m: unknown): MachineRecovery {
  if (!isObj(m)) throw new Error("machine 要是 { <整机恢复键>: {...} }");
  for (const [k, e] of Object.entries(m)) {
    if (!isMachineKey(k)) throw new Error(`machine 只认 ${MACHINE_RECOVERY_KEYS.join(" / ")}，收到 ${k}`);
    if (!isObj(e) || Object.keys(e).some((f) => f !== "mode" && f !== "rev")) throw new Error(`machine.${k} 只能有 mode / rev`);
    if (e.mode !== undefined && !isRecoveryMode(e.mode)) throw new Error(`machine.${k} 的 mode 要是 ${RECOVERY_MODES.join(" / ")}`);
    if (e.rev !== undefined && !(Number.isSafeInteger(e.rev) && (e.rev as number) >= 1)) throw new Error(`machine.${k} 的 rev 要是正整数`);
  }
  return m as MachineRecovery;
}

/** Read every time, never throws. machine.<key>.mode → observe; unknown key / bad file → off with a diagnostic. */
export function machineRecoveryPolicy(mechanism: MachineRecoveryKey, path = RECOVERY_POLICY_PATH): RecoveryPolicy {
  if (!isMachineKey(mechanism)) return stopped(`未知整机恢复键 ${String(mechanism)}（只认 ${MACHINE_RECOVERY_KEYS.join(" / ")}）`);
  const r = readRecoveryFile(path, parseMachineSection);
  if (r.status === "corrupt") return stopped(`${path} 读不了，恢复停手：${r.error}`);
  const mode = r.status === "ok" ? (r.data.machine as MachineRecovery | undefined)?.[mechanism]?.mode : undefined;
  return { mode: mode ?? DEFAULT_MODE, manualAfterMs: null, source: mode ? "config" : "default" };
}

export function machineRecoveryPolicies(path = RECOVERY_POLICY_PATH): Record<MachineRecoveryKey, RecoveryPolicy> {
  return Object.fromEntries(MACHINE_RECOVERY_KEYS.map((k) => [k, machineRecoveryPolicy(k, path)])) as Record<MachineRecoveryKey, RecoveryPolicy>;
}

/** Machine-wide identities only; project roles (PM / dispatcher / executor / peer / guest) never reach the whole machine. */
const actorMayConfigureMachine = (actor: string): boolean => actor === "owner" || actor === "master";
const forbidden = (actor: string) =>
  new LedgerError("forbidden", `整机恢复策略只有 owner / master 能改（你是 ${actor}）；项目 PM 要切换请向 owner 申请批准，由 owner 执行`);

/** inherit = drop the override (back to the default observe). */
export interface MachineSet { key: MachineRecoveryKey; mode: RecoveryMode | "inherit" }
type MachineState = { mode: RecoveryMode | null };

function checkSet(set: MachineSet): void {
  if (!isMachineKey(set.key)) throw new LedgerError("invalid", `--key 只能是 ${MACHINE_RECOVERY_KEYS.join(" / ")}，收到 ${String(set.key)}`);
  const modes: readonly string[] = [...RECOVERY_MODES, "inherit"];
  if (!modes.includes(set.mode)) throw new LedgerError("invalid", `恢复模式只能是 ${modes.join(" / ")}，收到 ${String(set.mode)}`);
}

/** Pending machine audits (prepared, neither published nor void) settled from the file's rev under the lock, like a project's. */
function settlePending(db: Database, ctx: WriteCtx, path: string): void {
  const pending = (db.prepare(`SELECT seq, data FROM events WHERE project = ? AND kind = 'decision' AND json_extract(data, '$.op') = ?
    AND json_extract(data, '$.publish') = 'prepared' ORDER BY seq`).all(MASTER_PROJECT, MACHINE_OP) as { seq: number; data: string }[])
    .filter((p) => !getEventByDedup(db, recoveryVoidKey(p.seq)) && !getEventByDedup(db, recoveryPublishedKey(p.seq)));
  if (!pending.length) return;
  const f = readRecoveryFile(path, parseMachineSection);
  if (f.status === "corrupt") throw new LedgerError("invalid", `${path} 坏了（${f.error}），审计 #${pending.map((p) => p.seq).join(" / ")} 生没生效核不了；没写，先手动修好`);
  tx(db, () => {
    if (!actorMayConfigureMachine(ctx.actor)) throw forbidden(ctx.actor);
    for (const p of pending) {
      const key = (JSON.parse(p.data) as { key?: MachineRecoveryKey }).key;
      const rev = f.status === "ok" && key ? (f.data.machine as MachineRecovery | undefined)?.[key]?.rev : undefined;
      settleRecoveryNote(db, ctx, MASTER_PROJECT, p.seq, rev === p.seq);
    }
  });
}

function replayed(db: Database, ctx: WriteCtx, key: MachineRecoveryKey) {
  if (ctx.dedupKey === "") throw new LedgerError("invalid", "dedupKey 不能是空字符串（不要幂等就别传）");
  const prev = ctx.dedupKey ? getEventByDedup(db, ctx.dedupKey) : null;
  if (!prev) return null;
  if (prev.project !== MASTER_PROJECT || prev.kind !== "decision" || prev.data.op !== MACHINE_OP || prev.data.key !== key) {
    throw new LedgerError("dedup_mismatch", `dedupKey ${ctx.dedupKey} 已被别的动作用过`);
  }
  if (getEventByDedup(db, recoveryVoidKey(prev.seq))) throw new LedgerError("dedup_mismatch", `dedupKey ${ctx.dedupKey} 那次改动没生效（审计 #${prev.seq} 已作废），换个 dedupKey 重试`);
  if (!getEventByDedup(db, recoveryPublishedKey(prev.seq))) throw new LedgerError("busy", `dedupKey ${ctx.dedupKey} 那次改动（审计 #${prev.seq}）生没生效还没核定，稍后重试`);
  return { from: prev.data.from as MachineState, to: prev.data.to as MachineState, event: prev.seq };
}

/**
 * Same protocol as setRecovery, on the machine section: permission (fast fail) → the file's lock → settle pending machine
 * audits → immediate ledger tx { re-check → read → edit → prepared audit } → COMMIT → atomic write with rev = audit seq,
 * keeping `projects` byte-for-byte as parsed → published note (void on a failed write). A corrupt file is refused, never
 * overwritten; nothing is written for a refused actor.
 */
export async function setMachineRecovery(db: Database, ctx: WriteCtx, input: { set: MachineSet; reason: string },
  opts: { path?: string; lockMs?: number } = {}) {
  const path = opts.path ?? RECOVERY_POLICY_PATH, { set } = input;
  const reason = textOneLine(input.reason, "原因", 600);
  checkSet(set);
  if (!actorMayConfigureMachine(ctx.actor)) throw forbidden(ctx.actor);
  mkdirSync(dirname(path), { recursive: true });
  const lockMs = opts.lockMs ?? 10_000;
  const lock = await acquireLock(`${path}.lock`, lockMs);
  if (!lock) throw new LedgerError("busy", `${path} 正被别的进程占着（${Math.round(lockMs / 1000)} 秒没拿到锁），这次没改，稍后重试`);
  try {
    settlePending(db, ctx, path);
    let text: string | null = null;
    const r = tx(db, () => {
      if (!actorMayConfigureMachine(ctx.actor)) throw forbidden(ctx.actor);
      const dup = replayed(db, ctx, set.key);
      if (dup) return { key: set.key, ...dup, changed: false, duplicate: true, path };
      const f = readRecoveryFile(path, parseMachineSection);
      if (f.status === "corrupt") throw new LedgerError("invalid", `${path} 坏了（${f.error}），恢复已按 off 停手；没写，先手动修好`);
      const doc = f.status === "ok" ? f.data : { projects: {} };
      const machine = doc.machine as MachineRecovery | undefined, cur = machine?.[set.key];
      const from: MachineState = { mode: cur?.mode ?? null }, to: MachineState = { mode: set.mode === "inherit" ? null : set.mode };
      if (from.mode === to.mode) return { key: set.key, from, to, changed: false, duplicate: false, event: null as number | null, path };
      const ev = appendEvent(db, ctx, { project: MASTER_PROJECT, target: "", kind: "decision", text: reason,
        data: { op: MACHINE_OP, key: set.key, from, to, publish: "prepared" } });
      if (ev.duplicate) throw new LedgerError("dedup_mismatch", `dedupKey ${ctx.dedupKey} 已被别的动作用过`);
      if (!lock.held()) throw new LedgerError("busy", `提交前发现 ${path} 的锁已被别人回收，这次没改，重试即可`);
      const entry: MachineEntry = { ...(to.mode ? { mode: to.mode } : {}), rev: ev.event.seq };
      text = JSON.stringify({ ...doc, machine: { ...machine, [set.key]: entry } }, null, 2) + "\n";
      return { key: set.key, from, to, changed: true, duplicate: false, event: ev.event.seq as number | null, path };
    });
    if (text === null) return r;
    try { commitRecoveryFile(path, text, lock); }
    catch (e) {
      try { settleRecoveryNote(db, ctx, MASTER_PROJECT, r.event!, false); }
      catch (ve) { console.error(`⚠️ 整机恢复策略审计 #${r.event} 已提交但 ${path} 没写成，作废记录也没记上（${(ve as Error).message}）：策略仍是旧的，下次改整机策略时按文件 rev 核定`); }
      if (e instanceof LedgerError) throw e;
      throw new LedgerError("busy", `审计 #${r.event} 已提交但 ${path} 没写成（${(e as Error).message}），策略仍是旧的；这次没生效，换个 dedupKey 重试`);
    }
    try { settleRecoveryNote(db, ctx, MASTER_PROJECT, r.event!, true); }
    catch (pe) { console.error(`⚠️ 整机恢复策略审计 #${r.event} 已写进 ${path}，已生效记录没记上（${(pe as Error).message}）：下次改整机策略时按文件 rev 补记`); }
    return r;
  } finally {
    lock.release();
  }
}
