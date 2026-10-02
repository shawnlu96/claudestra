/**
 * Card retirement, the card's own unregistered executor (i28-RT1): an executor PM started by hand for a card (named in
 * `tasks.agent`, never bound in scheduler_sessions) is invisible to the session steps, so it would keep the card's worktree forever.
 * Before the worktrees are looked at, such an agent still working in one of them is archived and killed; the worktree step then
 * runs unchanged (a dirty tree still stays for PM). Any other agent in a checkout — another name, a registered session, one an
 * unfinished card still uses — is left alone and the worktree step keeps the checkout and tells PM, as before.
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import type { LiveAgent } from "./scheduler-retire.js";
import { RETIRE_STAGES } from "./scheduler-sessions.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
type Kill = { receipt: string } | { busy: string } | { failed: string };

/** What the step borrows from scheduler-retire.ts (passed in: a runtime import back would make a cycle). */
export interface OwnerStopInput {
  db: Database;
  task: LedgerTask;
  /** The card's checkouts (worktreeDirs). */
  dirs: string[];
  agent: Manager;
  agents(): Promise<LiveAgent[]>;
  stopped(a: LiveAgent): boolean;
  within(path: string, dir: string): boolean;
  /** An unfinished card still using the agent (agentStillInUse), or null. */
  inUse(agent: string): string | null;
  archiveReceipt(r: Record<string, unknown>): string;
  killOutcome(r: Record<string, unknown>): Kill;
}

/** Bound in scheduler_sessions on any card, retired or not: such an agent belongs to the session steps, never to this one. */
const registered = (db: Database, agent: string): boolean => !!db.query("SELECT 1 FROM scheduler_sessions WHERE agent = ? LIMIT 1").get(agent);

/**
 * The card's own executor, if it still works in one of the card's checkouts and nothing else claims it: named exactly as
 * `tasks.agent`, not in scheduler_sessions, not used by an unfinished card, on a verified / done / cancelled card.
 */
function ownHolder(input: OwnerStopInput, agents: LiveAgent[]): LiveAgent | null {
  const { db, task } = input, name = task.agent;
  if (!name || !RETIRE_STAGES.includes(task.stage)) return null;
  const holder = agents.find((a) => a.name === name && !input.stopped(a) && a.cwd && input.dirs.some((d) => input.within(a.cwd!, d)));
  if (!holder || registered(db, name) || input.inUse(name)) return null;
  return holder;
}

/**
 * Archive then kill the card's own unregistered executor (ownHolder). `receipts` go into the retire event; `busy` = the kill
 * is still running, or answered ok with the window / pending still there: the card is held and the next pass tries again.
 * A kill that already began (registry `stopped`) is not archived again: runKill writes that only after the archive ran.
 */
export async function stopOwnExecutor(input: OwnerStopInput): Promise<{ receipts: string[] } | { busy: string }> {
  const holder = ownHolder(input, await input.agents());
  if (!holder) return { receipts: [] };
  const who = `本卡执行者 ${holder.name}（不在 scheduler_sessions）`;
  const archived = holder.status === "stopped" ? "kill 已开始过，不再归档" : input.archiveReceipt(await input.agent("archive", holder.name));
  const k = input.killOutcome(await input.agent("kill", holder.name));
  if ("busy" in k) return { busy: `${who} kill 还在进行（下轮再 kill）：${k.busy}` };
  // a failed kill leaves the agent in the checkout: the worktree step keeps it and PM hears, with this receipt in the event
  if ("failed" in k) return { receipts: [`${who}：归档 ${archived}；kill 失败，交 PM：${k.failed}`] };
  const after = (await input.agents()).find((a) => a.name === holder.name);
  if (after && !input.stopped(after)) return { busy: `${who} kill 回了 ok，但窗口 / pending 还在（下轮再 kill）` };
  return { receipts: [`${who}：归档 ${archived}；停止 ${k.receipt}`] };
}
