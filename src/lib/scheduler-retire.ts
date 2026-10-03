/**
 * Card retirement (docs/architecture/scheduler-retire.md): once a card is verified / done / cancelled, archive and kill the
 * sessions the scheduler bound to it, then remove its clean worktrees; a dirty one, one a live agent still works in, or one git
 * refuses to remove stays and goes to PM. Every effect is recorded on the ledger before the next one runs, and kill is skipped
 * for an agent the registry already shows stopped, so a restart resumes where it stopped without killing twice. A card that owes
 * PM a notice settles only after the notice went out: a lost notice is resent next pass, never dropped.
 * Removal is only ever `git worktree remove` without --force, which itself refuses dirty trees.
 */
import type { Database } from "bun:sqlite";
import { hasUnsettledFinishedWrites } from "./ledger-scheduler-lease-finished.js";
import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import { getTask } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { RETIRE_STAGES, type SchedulerSession } from "./scheduler-sessions.js";
import type { Git } from "./scheduler-review-worktree.js";
import { rotateAfter, type TickPace } from "./scheduler-yield.js";
import { normalizeRegistryAgents, REGISTRY_PATH, type RegistryAgent } from "./registry.js";
import { readJsonLenient } from "./state-file.js";
import { agentWindowsOrNull } from "./agent-windows.js";
import { cleanSessionTmp, type TmpCleaner, type TmpStepInput } from "./scheduler-retire-tmp.js";
import { stopOwnExecutor } from "./scheduler-retire-owner.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

export interface RetireDeps {
  /** The ledger CLI under the scheduler identity (scheduler-retire / scheduler-session-retire / scheduler-settle). */
  ledger: Manager;
  /** Plain `manager` for archive / kill: the scheduler identity may only run ledger commands. */
  agent: Manager;
  git: Git;
  exists(path: string): boolean;
  worktreeRoot: string;
  notifyPm(task: LedgerTask, text: string): Promise<void>;
  /** The registry as it is now: kill skips an agent already stopped, and a checkout a live agent works in is kept. */
  agents(): Promise<LiveAgent[]>;
  /** Session temp folders (scheduler-retire-tmp.ts); absent = that step is skipped. */
  tmp?: TmpCleaner;
}

/**
 * An agent as retirement reads it: its registry entry (absent = only a window by that name is left) and whether a tmux window by
 * that name is still open. `pending` = an operation on it (a kill cut off half way, a create) has not finished.
 */
export type LiveAgent = Pick<RegistryAgent, "name" | "status" | "sessionId" | "cwd"> & { pending: boolean; window: boolean };
/** Stopped for good: runKill writes `stopped` + pending *before* it closes the window, so neither alone proves the stop. */
const stopped = (a: LiveAgent): boolean => a.status === "stopped" && !a.pending && !a.window;

const agentWindowNames = async (): Promise<string[] | null> => (await agentWindowsOrNull())?.map((w) => w.name) ?? null;

/**
 * The registry with each entry's pending flag, plus the agent windows tmux has open (`windows` null = tmux could not be read).
 * Either unreadable throws, failing the card for this pass: an empty answer would read as "every agent is gone".
 */
export async function readLiveAgents(path = REGISTRY_PATH, windows: () => Promise<string[] | null> = agentWindowNames): Promise<LiveAgent[]> {
  const raw = await readJsonLenient<{ agents?: Record<string, { pending?: unknown }> } | null>(path, null, { who: "registry", writersGuarded: false });
  if (!raw?.agents || typeof raw.agents !== "object") throw new Error(`registry 读不出来（${path}），这轮不收`);
  const open = await windows();
  if (!open) throw new Error("tmux 列不出窗口，判断不了 agent 停没停，这轮不收");
  const listed = normalizeRegistryAgents(raw).map((a) => ({ name: a.name, status: a.status, sessionId: a.sessionId, cwd: a.cwd,
    pending: !!raw.agents?.[a.name]?.pending, window: open.includes(a.name) }));
  const orphans = open.filter((w) => !listed.some((a) => a.name === w)).map((name) => ({ name, pending: false, window: true }));
  return [...listed, ...orphans];
}

interface RetireOutcome { taskId: string; step: "retired" | "handoff" | "held" | "unknown"; detail: string }
/** A card that owes PM a notice: it settles only after the pass's combined notice for its project went out. */
interface Owed { outcome: RetireOutcome; task: LedgerTask; intentId: string; to: "done" | "unknown"; receipt: string; notice: string }
export interface RetireTickResult { cards: RetireOutcome[]; failed: { taskId: string; error: string }[] }

/** Cards per pass: the first pass after rollout backfills dozens, and each kill is a manager child plus a channel delete. */
export const RETIRE_CARDS_PER_PASS = 5;
const RS = RETIRE_STAGES.map((s) => `'${s}'`).join(",");
const oneLine = (s: string, max = 560): string => s.replace(/\s+/g, " ").trim().slice(0, max) || "（空）";
/** Receipt markers of a session that retired but left something for PM (a failed archive, a kill skipped for a changed session). */
const ARCHIVE_FAILED = "归档没成", FOR_PM = "交 PM";
/** On a cancelled card these open intents are closed before retiring; merge / verify belong to the merge queue and are waited for. */
const QUEUE_ACTIONS = "('merge','verify')";

/**
 * Finished cards with a session still to retire or a claimed retire intent to finish, by id. A card with another open intent
 * waits (beginRetire would refuse it). Cancelled cards may close non-write strays themselves, but residual writes must first
 * pass finished-card reconciliation. An unknown non-write intent, retire or not, is PM's to reconcile.
 */
export function retireCandidates(db: Database, projects: readonly string[]): string[] {
  if (!projects.length || !db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_sessions'").get()) return [];
  const rows = db.query(`SELECT t.id FROM tasks t WHERE t.stage IN (${RS}) AND t.project IN (${projects.map(() => "?").join(",")})
    AND NOT EXISTS (SELECT 1 FROM scheduler_intents i WHERE i.taskId = t.id AND i.action = 'retire' AND i.status IN ('done','unknown','cancelled'))
    AND NOT EXISTS (SELECT 1 FROM scheduler_intents i WHERE i.taskId = t.id AND i.action != 'retire' AND (i.status = 'unknown'
      OR (i.status IN ('pending','submitted') AND (t.stage != 'cancelled' OR i.action IN ${QUEUE_ACTIONS}))))
    AND (EXISTS (SELECT 1 FROM scheduler_sessions s WHERE s.taskId = t.id AND s.state != 'retired')
      OR EXISTS (SELECT 1 FROM scheduler_intents i WHERE i.taskId = t.id AND i.action = 'retire' AND i.status = 'submitted'))
    ORDER BY t.id`).all(...projects) as { id: string }[];
  return rows.filter((r) => !hasUnsettledFinishedWrites(db, r.id)).map((r) => r.id);
}

/** An unfinished card still using this agent (bound session or named executor): killing it would kill that card's work. */
function agentStillInUse(db: Database, agent: string, taskId: string): string | null {
  const row = db.query(`SELECT t.id FROM tasks t WHERE t.id != ? AND t.stage NOT IN (${RS}) AND (t.agent = ?
    OR EXISTS (SELECT 1 FROM scheduler_sessions s WHERE s.taskId = t.id AND s.agent = ? AND s.state != 'retired')) LIMIT 1`)
    .get(taskId, agent, agent) as { id: string } | null;
  return row?.id ?? null;
}

/** dir itself or a path inside it, both resolved through symlinks (macOS tmp dirs live behind /private). */
function within(path: string, dir: string): boolean {
  const real = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); /* gone or unreadable: compare as written */ } };
  const p = real(path), d = real(dir);
  return p === d || p.startsWith(d + sep);
}

/** The two checkouts the scheduler makes per card: the executor's (dag-tools-start) and the reviewer's (scheduler-auto-deps). */
export function worktreeDirs(root: string, taskId: string): string[] {
  const low = taskId.toLowerCase();
  if (!/^[\w.-]+$/.test(low) || /^\.+$/.test(low)) return []; // never build a path from a name that could leave the root
  return [join(root, low), join(root, `rv-${low}`)];
}

export const archiveReceipt = (r: Record<string, unknown>): string => {
  if (r.ok === true) return oneLine(`已归档 ${Array.isArray(r.archived) ? r.archived.length : 0} 个文件${r.note ? `（${String(r.note)}）` : ""}`);
  const why = String(r.error ?? r.note ?? "");
  // archive failing never loses the session: kill leaves the source jsonl where it is (and tries the archive itself)
  return /不在 registry/.test(why) ? "agent 已不在 registry，无可归档" : oneLine(`归档没成，源 jsonl 留在原处：${why}`);
};

/** kill's answer: a receipt, "busy" (retry next pass) or a failure for PM. An agent already gone counts as killed. */
export function killOutcome(r: Record<string, unknown>): { receipt: string } | { busy: string } | { failed: string } {
  if (r.ok === true) return { receipt: oneLine(r.alreadyStopped ? "agent 早已停止" : String(r.message ?? "已停止")) };
  const err = String(r.error ?? "kill 失败");
  if (/不存在/.test(err)) return { receipt: "agent 已不存在（先前已清）" };
  if (/正在/.test(err)) return { busy: oneLine(err) };
  return { failed: oneLine(err) };
}

type Effect = { effect: "archive" | "kill"; receipt: string } | { busy: string } | { failed: string };

async function settle(deps: RetireDeps, intentId: string, to: "done" | "unknown", receipt: string): Promise<boolean> {
  const r = await deps.ledger("ledger", "scheduler-settle", intentId, "--from", "submitted", "--to", to, "--receipt", oneLine(receipt));
  return r.ok === true;
}

class RetireCard {
  constructor(readonly db: Database, readonly task: LedgerTask, readonly intent: SchedulerIntent, readonly deps: RetireDeps) {}

  out(step: RetireOutcome["step"], detail: string): RetireOutcome { return { taskId: this.task.id, step, detail: oneLine(detail) }; }

  async record(row: SchedulerSession, effect: "archive" | "kill", receipt: string): Promise<string | null> {
    const r = await this.deps.ledger("ledger", "scheduler-session-retire", this.task.id, "--role", row.role, "--intent", this.intent.id,
      "--effect", effect, "--receipt", receipt);
    return r.ok === true ? null : String(r.error ?? "记账失败");
  }

  async archive(row: SchedulerSession): Promise<Effect> {
    if (row.transport === "peer") return { effect: "archive", receipt: "peer 会话：不在本机，不归档" };
    return { effect: "archive", receipt: archiveReceipt(await this.deps.agent("archive", row.agent)) };
  }

  /**
   * kill only an agent the registry shows running the bound session: one already stopped is how a kill whose receipt never
   * reached the ledger looks next pass, and a name now running another session is not this card's to stop (PM decides).
   */
  async kill(row: SchedulerSession): Promise<Effect> {
    if (row.transport === "peer") return { effect: "kill", receipt: "peer 会话：不在本机，不发命令，只标退役" };
    const user = agentStillInUse(this.db, row.agent, this.task.id);
    if (user) return { effect: "kill", receipt: `agent 仍被未收尾的 ${user} 使用：不 kill，只标退役` };
    const live = (await this.deps.agents()).find((a) => a.name === row.agent);
    if (!live) return { effect: "kill", receipt: "agent 已不在（registry 没有条目，tmux 没有窗口）" };
    if (stopped(live)) return { effect: "kill", receipt: "agent 早已停止，不再 kill" }; // pending or a window left = a kill to finish
    if (live.sessionId && live.sessionId !== row.sessionId) {
      return { effect: "kill", receipt: oneLine(`agent 现在跑的是会话 ${live.sessionId}，不是本卡绑定的 ${row.sessionId}：不 kill，${FOR_PM}`) };
    }
    const k = killOutcome(await this.deps.agent("kill", row.agent));
    if (!("receipt" in k)) return k;
    // kill can answer ok without the window gone (tmux errors are not all propagated): only a stop seen here is receipted
    const after = (await this.deps.agents()).find((a) => a.name === row.agent);
    return after && !stopped(after) ? { busy: "kill 回了 ok，但窗口 / pending 还在（下轮再 kill）" } : { effect: "kill", receipt: k.receipt };
  }

  /** Archive, then kill: each receipt is on the ledger before the next effect; a receipt already there skips its effect. */
  async session(row: SchedulerSession): Promise<{ busy: string } | { failed: string } | null> {
    if (row.retireIntentId && row.retireIntentId !== this.intent.id) return { failed: `${row.role} session 已由另一个意图 ${row.retireIntentId} 退役` };
    for (const step of ["archive", "kill"] as const) {
      if (step === "archive" ? row.archiveReceipt : row.killReceipt) continue;
      const e = step === "archive" ? await this.archive(row) : await this.kill(row);
      if (!("effect" in e)) return e;
      const err = await this.record(row, e.effect, e.receipt);
      if (err) return { busy: `${row.role} ${e.effect} 回执没记上（下轮再记）：${err}` };
    }
    return null;
  }

  /** null = removed or not there; otherwise why the checkout stays (with porcelain lines when dirty). */
  async worktree(dir: string, agents: Awaited<ReturnType<RetireDeps["agents"]>>): Promise<string | null> {
    if (!this.deps.exists(dir)) return null;
    const holder = agents.find((a) => !stopped(a) && a.cwd && within(a.cwd, dir));
    if (holder) return `${holder.name} 还在这里工作（agent 没停）`;
    const g = (...args: string[]) => this.deps.git(["-C", dir, ...args]);
    const where = await g("rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir");
    const [gitDir, common] = where.out.split("\n");
    if (where.code !== 0 || !gitDir || !common) return `读不出是不是 git worktree：${where.out}`;
    if (gitDir === common) return "是主仓库而不是 linked worktree，不碰";
    const st = await g("status", "--porcelain");
    if (st.code !== 0) return `读不了工作区状态：${st.out}`;
    if (st.out) return `有未提交改动：${st.out.split("\n").slice(0, 5).join("; ")}`;
    const rm = await g("worktree", "remove", dir);
    return rm.code === 0 ? null : `git worktree remove 失败：${rm.out}`;
  }

  owe(outcome: RetireOutcome, to: Owed["to"], receipt: string, notice: string): Owed {
    return { outcome, task: this.task, intentId: this.intent.id, to, receipt, notice: oneLine(notice) };
  }

  /** Settled here when nothing is owed to PM; otherwise handed back to settle after the pass's notice (notifyAndSettle). */
  async run(): Promise<RetireOutcome | Owed> {
    const rows = this.db.query("SELECT * FROM scheduler_sessions WHERE taskId = ? AND state != 'retired' ORDER BY role").all(this.task.id) as SchedulerSession[];
    for (const row of rows) {
      const stop = await this.session(row);
      if (!stop) continue;
      if ("busy" in stop) return this.out("held", stop.busy);
      const why = `${row.role} session ${row.agent} 收不掉：${stop.failed}`;
      return this.owe(this.out("unknown", why), "unknown", why, `${this.task.id} 收尾卡住，意图转 unknown 待核对：${why}`);
    }
    const own = await stopOwnExecutor({ ...this.deps, db: this.db, task: this.task, intentId: this.intent.id, archiveFailed: ARCHIVE_FAILED,
      dirs: worktreeDirs(this.deps.worktreeRoot, this.task.id), stopped, within, archiveReceipt, killOutcome, inUse: (name) => agentStillInUse(this.db, name, this.task.id) }); // i28-RT1
    if ("busy" in own) return this.out("held", own.busy);
    // re-derived from durable state every time, so a notice resent after a lost one says the same thing
    const kept: string[] = [], agents = await this.deps.agents(), checkouts: TmpStepInput["checkouts"] = [];
    for (const [i, dir] of worktreeDirs(this.deps.worktreeRoot, this.task.id).entries()) {
      const why = await this.worktree(dir, agents);
      if (why) kept.push(`${dir}：${why}`);
      checkouts.push({ dir, role: i === 0 ? "author" : "reviewer", kept: !!why });
    }
    const all = this.db.query("SELECT * FROM scheduler_sessions WHERE taskId = ? ORDER BY role").all(this.task.id) as SchedulerSession[];
    const left = [...own.pm, ...all.flatMap((r) => [r.archiveReceipt, r.killReceipt].filter((x): x is string => !!x && (x.startsWith(ARCHIVE_FAILED) || x.includes(FOR_PM)))
      .map((x) => `${r.role} ${r.agent}：${x}`))];
    const others = (this.db.query("SELECT id FROM tasks WHERE id != ?").all(this.task.id) as { id: string }[])
      .flatMap((t) => worktreeDirs(this.deps.worktreeRoot, t.id));
    const tmp = await cleanSessionTmp(this.deps.tmp, { stage: getTask(this.db, this.task.id)?.stage ?? "", checkouts, sessions: all,
      liveCwds: agents.flatMap((a) => (!stopped(a) && a.cwd ? [{ name: a.name, cwd: a.cwd }] : [])), otherCheckouts: others });
    const sessions = (rows.length ? `${rows.length} 个 session 已退役` : "session 早已退役") + own.receipts.map((r) => `；${r}`).join("")
      + (tmp.done.length ? `；临时目录 ${tmp.done.join("、")}` : "");
    if (!kept.length && !left.length && !tmp.failed.length) {
      return this.out((await settle(this.deps, this.intent.id, "done", `${sessions}；worktree 已清`)) ? "retired" : "held", sessions);
    }
    const parts = [...(kept.length ? [`worktree 没删：${kept.join(" | ")}`] : []), ...left, ...tmp.failed];
    const text = `${sessions}；交 PM：${parts.join(" | ")}`;
    return this.owe(this.out("handoff", text), "done", text, `${this.task.id} 请看一眼：${parts.join(" | ")}`);
  }
}

/** For a cancelled card: close non-write strays only after write reconciliation has removed its writer guard. */
async function closeStray(db: Database, deps: RetireDeps, task: LedgerTask): Promise<string | null> {
  if (task.stage !== "cancelled") return null;
  if (hasUnsettledFinishedWrites(db, task.id)) return "仍有未结写意图，等待写方空闲后结清";
  const open = db.query(`SELECT id, status FROM scheduler_intents WHERE taskId = ? AND action NOT IN ('retire', 'merge', 'verify')
    AND status IN ('pending','submitted') ORDER BY id`).all(task.id) as { id: string; status: string }[];
  for (const i of open) {
    const r = await deps.ledger("ledger", "scheduler-settle", i.id, "--from", i.status, "--to", "cancelled", "--receipt", "卡已取消：收尾前关掉这个没结的意图");
    if (r.ok !== true) return `取消卡上的意图 ${i.id} 关不掉：${String(r.error)}`;
  }
  return null;
}

/**
 * Notices delivered whose settle has not landed yet, by intent id only, per ledger: such a card skips the retirement steps and only
 * retries its settle with what PM was told. Keyed on the id, not the text, so a notice whose text keeps changing goes out once.
 */
type Pending = Pick<Owed, "outcome" | "to" | "receipt">;
const delivered = new WeakMap<Database, Map<string, Pending>>();
const deliveredFor = (db: Database): Map<string, Pending> => delivered.get(db) ?? delivered.set(db, new Map()).get(db)!;

/**
 * Settle a card whose notice went out. A settle that answers not-ok or throws (the manager child failing to start) stays
 * remembered, so the next pass retries the settle and nothing else; it never stops the other cards of the notice from settling.
 */
async function settleNotified(db: Database, deps: RetireDeps, intentId: string, p: Pending): Promise<RetireOutcome> {
  const why = await settle(deps, intentId, p.to, p.receipt).then((ok) => (ok ? null : "台账没收"), (e: unknown) => {
    if (e instanceof SchedulerStopped) throw e;
    return oneLine((e as Error).message);
  });
  if (why !== null) return { ...p.outcome, step: "held", detail: oneLine(`已通知 PM，意图没结上（下轮再结，不重发）：${why}`) };
  deliveredFor(db).delete(intentId);
  return p.outcome;
}

/**
 * One combined PM notice per project, then the settles it covers. A notice that did not go out leaves its cards submitted, so the
 * next pass rebuilds and resends it. One that went out is remembered until its settle lands, so a failed settle write is retried
 * without telling PM again; only the service dying between the send and the settle can repeat it (the bridge keeps no send ids).
 */
async function notifyAndSettle(db: Database, deps: RetireDeps, owed: Owed[], out: RetireOutcome[]): Promise<void> {
  const sent = deliveredFor(db);
  const byProject = new Map<string, Owed[]>();
  for (const o of owed) byProject.set(o.task.project, [...(byProject.get(o.task.project) ?? []), o]);
  for (const group of byProject.values()) {
    const lines = group.map((o) => `- ${o.notice}`);
    const text = `[调度引擎] 卡收尾有 ${lines.length} 处要 PM 看（没删的 worktree 不加 --force、不 rm，原样留着）：\n${lines.join("\n")}`;
    const failed = await deps.notifyPm(group[0].task, text).then(() => null, (e: unknown) => {
      if (e instanceof SchedulerStopped) throw e;
      console.error(`⚠️ [scheduler] 收尾通知没发出去，下轮重发：${(e as Error).message}`);
      return oneLine((e as Error).message);
    });
    if (failed !== null) {
      for (const o of group) out.push({ ...o.outcome, step: "held", detail: oneLine(`PM 通知没发出去，下轮重发：${failed}`) });
      continue;
    }
    // the whole group is remembered before the first settle is awaited: a settle that throws must not leave a later card unrecorded
    for (const o of group) sent.set(o.intentId, { outcome: o.outcome, to: o.to, receipt: o.receipt });
    for (const o of group) out.push(await settleNotified(db, deps, o.intentId, o));
  }
}

/**
 * One retirement step per pass for up to RETIRE_CARDS_PER_PASS finished cards, in rotation after where the last pass stopped
 * (pace.cursor.retire), so cards held every pass never keep the rest from their turn. A card that fails does not stop the others.
 */
export async function schedulerRetireTick(db: Database, projects: readonly string[], deps: RetireDeps, pace?: TickPace): Promise<RetireTickResult> {
  const out: RetireTickResult = { cards: [], failed: [] }, owed: Owed[] = [];
  const ids = retireCandidates(db, projects);
  for (const taskId of (pace ? rotateAfter(ids, (id) => id, pace.cursor.retire) : ids).slice(0, RETIRE_CARDS_PER_PASS)) {
    if (pace?.yieldNow()) break;
    if (pace) pace.cursor.retire = taskId;
    const task = getTask(db, taskId);
    if (!task) continue;
    try {
      const stray = await closeStray(db, deps, task);
      if (stray) { out.cards.push({ taskId, step: "held", detail: oneLine(stray) }); continue; }
      const r = await deps.ledger("ledger", "scheduler-retire", taskId);
      const intent = r.intent as SchedulerIntent | undefined;
      if (r.ok !== true || !intent) { out.cards.push({ taskId, step: "held", detail: oneLine(`退役意图没开成：${String(r.error)}`) }); continue; }
      if (intent.status !== "submitted") continue;
      const told = deliveredFor(db).get(intent.id);
      if (told) { out.cards.push(await settleNotified(db, deps, intent.id, told)); continue; }
      const done = await new RetireCard(db, task, intent, deps).run();
      if ("notice" in done) owed.push(done); else out.cards.push(done);
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      out.failed.push({ taskId, error: oneLine((e as Error).message) });
    }
  }
  await notifyAndSettle(db, deps, owed, out.cards);
  return out;
}
