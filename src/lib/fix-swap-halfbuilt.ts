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
 */
import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import type { WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow, type SchedulerIntent } from "./ledger-scheduler.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import type { LedgerTask } from "./ledger-stages.js";
import type { RegistryAgent } from "./registry.js";
import { createRetryDelay } from "./scheduler-create-retry.js";
import { isShellCommand } from "./tmux-send-guard.js";
import { defaultIo, type LivenessIo } from "./worker-liveness.js";
import { selfHealMode, selfHealSample } from "./fix-swap-halfbuilt-sample.js";

export const HALF_BUILT_MARK = "半建会话已清理";
/** the third half-built create of one card's author stays unknown for PM */
const HALF_BUILT_LIMIT = 3;

type Lifecycle = { manager(...args: string[]): Promise<Record<string, unknown>>; registry(): RegistryAgent[]; active(): void };

const windowIo = new WeakMap<Database, LivenessIo>();
/** Tests inject the tmux / ps reads; the service reads them the way worker-liveness.ts does (strict tmux, checked ps). */
export const setHalfBuiltIo = (db: Database, io: LivenessIo): void => void windowIo.set(db, io);

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

async function windowVerdict(name: string, io: LivenessIo = defaultIo): Promise<WindowVerdict> {
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
 * Called once the creating claim is past CLAIM_LEASE_MS with no session id. Returns the wait text after the cleanup cancelled the
 * intent, or null = the old path (unknown for PM).
 */
export async function healHalfBuilt(db: Database, ctx: WriteCtx, intent: SchedulerIntent, task: LedgerTask, name: string,
  role: "author" | "reviewer", deps: Lifecycle): Promise<string | null> {
  if (role !== "author" || intent.action !== "fix_swap" || !intent.head || getWorkflow(db, task.id)?.mode !== "auto") return null;
  const mode = selfHealMode(db, task.project, "authorRebuild");
  const nth = streak(db, task.id).n + 1;
  if (mode === "off" || nth >= HALF_BUILT_LIMIT) return null;
  const unbound = () => !deps.registry().find((r) => r.name === name)?.sessionId;
  if (!unbound()) return null;
  const window = await windowVerdict(name, windowIo.get(db)); deps.active();
  if (window !== "gone" && window !== "shell") return null;
  const now = ctx.now ?? Date.now();
  const sample = { project: task.project, key: "authorRebuild" as const, taskId: task.id, head: intent.head, action: "halfbuilt-rebuild" as const, nth,
    text: `清理重建半建的换家族作者会话 ${name}（窗口${window === "gone" ? "已不在" : "只剩 shell"}，registry 无 session id，第 ${nth} 次）`,
    data: { intentId: intent.id, agent: name, window } };
  if (mode === "observe") { selfHealSample(db, "observe", sample, now); return null; }
  if (!unbound() || getIntent(db, intent.id)?.status !== "submitted") return null;
  const killed = await deps.manager("kill", name); deps.active();
  if (killed.ok !== true || deps.registry().some((r) => r.name === name) || getIntent(db, intent.id)?.status !== "submitted") return null;
  const wait = createRetryDelay(nth);
  const receipt = `${HALF_BUILT_MARK}（${name} 第 ${nth} 次；${wait / 60_000} 分钟后重新规划换家族）`;
  settleIntent(db, ctx, { id: intent.id, from: "submitted", to: "cancelled", receipt });
  selfHealSample(db, "on", sample, now);
  return receipt;
}
