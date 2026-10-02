/**
 * Card retirement, the card's own unregistered executor (i28-RT1): an executor PM started by hand for a card (named in
 * `tasks.agent`, never bound in scheduler_sessions) is invisible to the session steps, so it would keep the card's worktree forever.
 * Before the worktrees are looked at, such an agent still working in one of them is archived and killed; the worktree step then
 * runs unchanged (a dirty tree still stays for PM). Any other agent in a checkout — another name, a registered session, one an
 * unfinished card still uses — is left alone and the worktree step keeps the checkout and tells PM, as before.
 */
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { getIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { writeJsonLeased } from "./scheduler-lease-env.js";
import type { LiveAgent } from "./scheduler-retire.js";
import { RETIRE_STAGES } from "./scheduler-sessions.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
type Kill = { receipt: string } | { busy: string } | { failed: string };

/** What the step borrows from scheduler-retire.ts (passed in: a runtime import back would make a cycle). */
export interface OwnerStopInput {
  db: Database;
  task: LedgerTask;
  /** The card's submitted retire intent: the effects done for it are remembered under its id. */
  intentId: string;
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
  /** Receipt prefix of an archive that did not happen (scheduler-retire.ts ARCHIVE_FAILED). */
  archiveFailed: string;
}

/** `receipts` go into the retire event; `pm` = what PM must follow up (an archive that failed), like a session's left receipts. */
export type OwnerStop = { receipts: string[]; pm: string[] } | { busy: string };

/**
 * Effects done on the card's own executor, per retire intent, journaled before the next effect runs: a pass that ends before its
 * settle lands (settle refused, agents / git throwing, a held kill, a service restart) still writes them into the event later,
 * whatever the registry shows by then. The journal sits next to the ledger file (only the leased scheduler writes it); an
 * in-memory ledger (tests) keeps it in memory. An entry whose intent is no longer submitted was settled with it and is dropped.
 */
type Done = { archive?: string; kill?: string; note?: string };
type Journal = Record<string, Done>;
const inMemory = new WeakMap<Database, Journal>();
const journalPath = (db: Database): string | null => (db.filename && db.filename !== ":memory:" ? `${db.filename}.retire-owner.json` : null);

function loadJournal(db: Database): Journal {
  const path = journalPath(db);
  let all: Journal = {};
  if (!path) all = inMemory.get(db) ?? {};
  else if (existsSync(path)) {
    try { all = JSON.parse(readFileSync(path, "utf8")) as Journal; } catch (e) {
      throw new Error(`本卡执行者收尾记录读不出来（${path}），这轮不收：${(e as Error).message}`); // dropping it would lose receipts
    }
  }
  return Object.fromEntries(Object.entries(all).filter(([id]) => getIntent(db, id)?.status === "submitted"));
}

async function saveJournal(db: Database, all: Journal): Promise<void> {
  const path = journalPath(db);
  if (path) await writeJsonLeased(path, all); else inMemory.set(db, all);
}

/** Bound in scheduler_sessions on any card, retired or not: such an agent belongs to the session steps, never to this one. */
const registered = (db: Database, agent: string): boolean => !!db.query("SELECT 1 FROM scheduler_sessions WHERE agent = ? LIMIT 1").get(agent);

/**
 * The card's own executor, if it is (or was, when the registry shows it stopped) in one of the card's checkouts and nothing else
 * claims it: named exactly as `tasks.agent`, not in scheduler_sessions, not used by an unfinished card, on a verified / done /
 * cancelled card. Read again after the archive: the agent may have been given to another card while it ran.
 */
function ownHolder(input: OwnerStopInput, agents: LiveAgent[]): LiveAgent | null {
  const { db, task } = input, name = task.agent;
  if (!name || !RETIRE_STAGES.includes(task.stage)) return null;
  const holder = agents.find((a) => a.name === name && a.cwd && input.dirs.some((d) => input.within(a.cwd!, d)));
  if (!holder || registered(db, name) || input.inUse(name)) return null;
  return holder;
}

/** The journaled effects as event receipts; `kill` = this pass's stop line when the journal has none. */
function report(input: OwnerStopInput, d: Done | undefined, kill?: string): OwnerStop {
  if (!d && !kill) return { receipts: [], pm: [] };
  const who = `本卡执行者 ${input.task.agent}（不在 scheduler_sessions）`;
  const stop = d?.kill ? `停止 ${d.kill}` : kill;
  const line = [d?.archive ? `归档 ${d.archive}` : d?.note ? "" : "归档 无回执", d?.note ?? "", stop ?? ""].filter(Boolean).join("；");
  const pm = [d?.archive, d?.note].filter((x): x is string => !!x?.includes(input.archiveFailed)).map((x) => `${who}：${x}`);
  return { receipts: [`${who}：${line}`], pm };
}

/**
 * Archive then kill the card's own unregistered executor (ownHolder). `busy` = the kill is still running, or answered ok with the
 * window / pending still there: the card is held and the next pass tries again. Each effect is journaled before the next runs
 * and runs once per retire intent; receipts come from the journal first, so they survive the agent leaving the registry.
 */
export async function stopOwnExecutor(input: OwnerStopInput): Promise<OwnerStop> {
  const { db, intentId } = input, journal = loadJournal(db);
  const holder = ownHolder(input, await input.agents());
  if (!holder) return report(input, journal[intentId]);
  const d = (journal[intentId] ??= {}), name = holder.name;
  if (input.stopped(holder)) {
    // stopped by an earlier pass whose settle never landed, or by someone else before this card retired: nothing more to do
    d.archive ??= d.note ? undefined : "未归档（registry 已是 stopped，不再归档）";
    return report(input, d, "停止 registry 已是 stopped，不再 kill");
  }
  if (!d.archive) {
    d.archive = holder.status === "stopped" ? "kill 已开始过，不再归档" : input.archiveReceipt(await input.agent("archive", name));
    delete d.note;
    await saveJournal(db, journal);
    // the archive ran as a manager child: the agent may have been given to an unfinished card meanwhile
    const now = ownHolder(input, await input.agents());
    if (!now) {
      const user = input.inUse(name);
      d.note = `归档 ${d.archive}；之后${user ? `被未收尾的 ${user} 接用` : "不再是本卡占着 checkout 的执行者"}：不 kill`;
      delete d.archive; // archived again before any later kill
      await saveJournal(db, journal);
      return report(input, d);
    }
    if (input.stopped(now)) return report(input, d, "停止 归档期间已停，不再 kill");
  }
  const k = input.killOutcome(await input.agent("kill", name));
  if ("busy" in k) return { busy: `本卡执行者 ${name} kill 还在进行（下轮再 kill）：${k.busy}` };
  // a failed kill leaves the agent in the checkout: the worktree step keeps it and PM hears, with this receipt in the event
  if ("failed" in k) return report(input, d, `kill 失败，交 PM：${k.failed}`);
  d.kill = k.receipt;
  await saveJournal(db, journal); // reported only once a read shows the agent stopped: here, or next pass if this read throws
  const after = (await input.agents()).find((a) => a.name === name);
  if (after && !input.stopped(after)) return { busy: `本卡执行者 ${name} kill 回了 ok，但窗口 / pending 还在（下轮再 kill）` };
  return report(input, d);
}
