/**
 * SWAPFIX1 2: a family-swap author whose `manager create` was killed mid-way (the 90 s child budget under load) leaves a tmux window
 * at a bare shell and a `creating` registry placeholder with no session id; after CLAIM_LEASE_MS the intent used to go unknown for PM.
 * Only when all three hold — the claim is past CLAIM_LEASE_MS (the caller's check), the registry row under the name still has no
 * session id, and the window holds nothing but shells (or is gone) — the existing manager kill path (runManager, never a tmux
 * command of its own) clears the window and placeholder; once the registry no longer has the name the intent is cancelled
 * (「半建会话已清理」) and the planner's next fix_swap waits the same backoff as retryCleanCreate (2 → 4 → 8 → 15 min). The third
 * half-built create of the card's author is left unknown as before, and so is anything uncertain (tmux unreadable, an unknown
 * process in the window, a session id in the registry). Switch: recovery key authorRebuild (off = the old unknown; observe =
 * record「本会清理重建」, then the old unknown; on = clear and rebuild). A manual card never heals. tests/fix-swap-halfbuilt*.test.ts.
 *
 * The kill runs in a manager child that reads the registry after this process did. It is only sent for a placeholder whose creating
 * process is dead, and it carries that placeholder's marker (`--expect-create <pid>@<startedAt>`): the child re-reads the registry
 * and refuses, touching nothing, unless the entry is still that marker with no session id and a dead creator — a same-name create
 * that finished meanwhile is never killed by name. Only then does create-guard.ts clearCreateResidue run (marker re-checked,
 * recorded window id or a bare shell only).
 */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow, type SchedulerIntent } from "./ledger-scheduler.js";
import { getEventByDedup, getTask } from "./ledger-store.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import type { LedgerTask } from "./ledger-stages.js";
import { REGISTRY_PATH, type RegistryAgent } from "./registry.js";
import { pidAlive } from "./pending-ops.js";
import { createRetryDelay } from "./scheduler-create-retry.js";
import { isShellCommand } from "./tmux-send-guard.js";
import { defaultIo, type LivenessIo } from "./worker-liveness.js";
import { selfHealMode, selfHealSample } from "./fix-swap-halfbuilt-sample.js";

export const HALF_BUILT_MARK = "半建会话已清理";
/** the third half-built create of one card's author stays unknown for PM */
const HALF_BUILT_LIMIT = 3;

type Lifecycle = { manager(...args: string[]): Promise<Record<string, unknown>>; registry(): RegistryAgent[]; active(): void; registryPath?: string };

type Probe = { io: LivenessIo; alive(pid: number): boolean };
const probes = new WeakMap<Database, Probe>();
/** Tests inject the tmux / ps reads and the pid check; the service reads them the way worker-liveness.ts / pending-ops.ts do. */
export const setHalfBuiltIo = (db: Database, io: LivenessIo, alive: (pid: number) => boolean = pidAlive): void => void probes.set(db, { io, alive });
const probeOf = (db: Database): Probe => probes.get(db) ?? { io: defaultIo, alive: pidAlive };

/** A create placeholder's identity (create-guard.ts sameMarker), or "absent" = no registry entry under the name at all. */
type Placeholder = { pid: number; startedAt: string } | "absent";

/**
 * The raw registry entry under `name` (the normalized view drops `pending`), read synchronously. Only two shapes may be cleared:
 * no entry at all, or a create placeholder without a session id whose creating process is dead (checked by pid, never by the
 * staleness timeout: a slow create past it is still alive). null = anything else, an unreadable registry included.
 */
function placeholderOf(db: Database, name: string, deps: Lifecycle): Placeholder | null {
  let entry: Record<string, unknown> | undefined;
  try { entry = (JSON.parse(readFileSync(deps.registryPath ?? REGISTRY_PATH, "utf8")) as { agents: Record<string, Record<string, unknown>> }).agents[name]; }
  catch { return null; }
  if (!entry) return "absent";
  const p = entry.pending as { op?: unknown; pid?: unknown; startedAt?: unknown } | undefined;
  if (entry.sessionId || p?.op !== "create" || typeof p.pid !== "number" || typeof p.startedAt !== "string") return null;
  return probeOf(db).alive(p.pid) ? null : { pid: p.pid, startedAt: p.startedAt };
}

const samePlaceholder = (a: Placeholder | null, b: Placeholder): boolean =>
  a === "absent" || b === "absent" ? a === b : !!a && a.pid === b.pid && a.startedAt === b.startedAt;

type WindowVerdict = "gone" | "shell" | "busy" | "unknown";

/** Every pane is a bare shell with no child process in one ps snapshot; a pane missing from the snapshot = unknown. */
export function shellOnlyVerdict(panePids: readonly number[], psOut: string): "shell" | "busy" | "unknown" {
  const cmd = new Map<number, string>(), parents = new Set<number>();
  for (const line of psOut.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    cmd.set(Number(m[1]), m[3].trim());
    parents.add(Number(m[2]));
  }
  if (!panePids.length || panePids.some((p) => !cmd.has(p))) return "unknown";
  return panePids.every((p) => isShellCommand(basename(cmd.get(p)!.split(/\s+/)[0] ?? "")) && !parents.has(p)) ? "shell" : "busy";
}

async function windowVerdict(name: string, io: LivenessIo): Promise<WindowVerdict> {
  let names: string[];
  try { names = await io.windows(); } catch { return "unknown"; }
  if (!names.includes(name)) return "gone";
  try { return shellOnlyVerdict(await io.panePids(name), await io.ps()); } catch { return "unknown"; }
}

/** Consecutive half-built cleanups of this card's fix_swap author, newest first; any other settled fix_swap ends the streak. */
function streak(db: Database, taskId: string): { n: number; last: number } {
  const rows = db.query(`SELECT receipt, updatedAt FROM scheduler_intents WHERE taskId = ? AND action = 'fix_swap'
    AND status NOT IN ('pending','submitted') ORDER BY eventSeq DESC LIMIT 100`).all(taskId) as { receipt: string | null; updatedAt: number }[];
  const n = rows.findIndex((r) => !r.receipt?.startsWith(HALF_BUILT_MARK));
  return { n: n === -1 ? rows.length : n, last: rows[0]?.updatedAt ?? 0 };
}

/** The re-planned family swap's backoff after a cleanup (retryCleanCreate's schedule); null = may create now. */
export function halfBuiltBackoff(db: Database, taskId: string, now: number): string | null {
  const { n, last } = streak(db, taskId);
  if (!n) return null;
  const left = last + createRetryDelay(n) - now;
  return left > 0 ? `换家族作者会话连续 ${n} 次半建（已清理），${Math.ceil(left / 1000)}s 后重建` : null;
}

/**
 * The whole permission the cleanup acts on, read synchronously with no await before the effect it guards (the kill, the settle):
 * auto card, authorRebuild still on, the card still where the intent pins it, the intent still submitted with this name's creating
 * claim, and the registry entry still exactly `expect` (the dead creator's placeholder before the kill, no entry after it). A permission
 * read before the tmux / ps awaits proves nothing here.
 */
function healRefusal(db: Database, intent: SchedulerIntent, name: string, deps: Lifecycle, expect: Placeholder): string | null {
  deps.active();
  const task = getTask(db, intent.taskId), now = getIntent(db, intent.id);
  if (!task || getWorkflow(db, task.id)?.mode !== "auto") return "卡不在 auto";
  if (selfHealMode(db, task.project, "authorRebuild") !== "on") return "authorRebuild 不在 on";
  if (!now || now.status !== "submitted" || now.head !== intent.head || task.headSHA !== now.head || task.specRev !== now.specRev || task.rev !== now.taskRev) {
    return "意图或卡已变化";
  }
  if (getEventByDedup(db, `scheduler:${intent.id}:creating`)?.data.agent !== name) return "建会话认领已不是这个名字";
  if (deps.registry().find((r) => r.name === name)?.sessionId) return "registry 已有 session id";
  return samePlaceholder(placeholderOf(db, name, deps), expect) ? null : "registry 占位已变化或建会话进程还活着";
}

/**
 * Called once the creating claim is past CLAIM_LEASE_MS with no session id. Returns the wait text after the cleanup cancelled the
 * intent, or null = the old path (unknown for PM). The permission is read again right before the kill and right before the settle.
 */
export async function healHalfBuilt(db: Database, ctx: WriteCtx, intent: SchedulerIntent, task: LedgerTask, name: string,
  role: "author" | "reviewer", deps: Lifecycle): Promise<string | null> {
  if (role !== "author" || intent.action !== "fix_swap" || !intent.head || getWorkflow(db, task.id)?.mode !== "auto") return null;
  const mode = selfHealMode(db, task.project, "authorRebuild");
  const nth = streak(db, task.id).n + 1;
  if (mode === "off" || nth >= HALF_BUILT_LIMIT) return null;
  const unbound = () => !deps.registry().find((r) => r.name === name)?.sessionId;
  const before = unbound() ? placeholderOf(db, name, deps) : null;
  if (!before) return null;
  const window = await windowVerdict(name, probeOf(db).io); deps.active();
  // a shell window no placeholder owns is not provably this create's (no entry and no window = nothing left)
  if (window !== "gone" && (window !== "shell" || before === "absent")) return null;
  const now = ctx.now ?? Date.now();
  const sample = { project: task.project, key: "authorRebuild" as const, taskId: task.id, head: intent.head, action: "halfbuilt-rebuild" as const, nth,
    text: `清理重建半建的换家族作者会话 ${name}（窗口${window === "gone" ? "已不在" : "只剩 shell"}，registry 无 session id，第 ${nth} 次）`,
    data: { intentId: intent.id, agent: name, window } };
  if (mode === "observe") {
    // the observation, too, stands on the current card: a takeover or a switch flip during the tmux read records nothing
    if (getWorkflow(db, task.id)?.mode === "auto" && selfHealMode(db, task.project, "authorRebuild") === "observe" && unbound()
      && samePlaceholder(placeholderOf(db, name, deps), before)) selfHealSample(db, "observe", sample, now);
    return null;
  }
  if (healRefusal(db, intent, name, deps, before)) return null;
  if (before !== "absent") { // nothing under the name at all needs no kill
    const killed = await deps.manager("kill", name, "--expect-create", `${before.pid}@${before.startedAt}`); deps.active();
    if (killed.ok !== true) return null;
  }
  if (healRefusal(db, intent, name, deps, "absent")) return null;
  const wait = createRetryDelay(nth);
  const receipt = `${HALF_BUILT_MARK}（${name} 第 ${nth} 次；${wait / 60_000} 分钟后重新规划换家族）`;
  settleIntent(db, ctx, { id: intent.id, from: "submitted", to: "cancelled", receipt });
  selfHealSample(db, "on", sample, now);
  return receipt;
}
