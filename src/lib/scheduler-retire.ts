/**
 * Card retirement (docs/architecture/scheduler-retire.md): once a card is verified / done / cancelled, archive and kill the
 * sessions the scheduler bound to it, then remove its clean worktrees; a dirty one, or one git refuses to remove, stays and
 * goes to PM. Every effect is recorded on the ledger before the next one runs, so a restart resumes where it stopped and
 * never kills or notifies twice: the session row's receipts skip finished effects, and the PM notice follows only the one
 * settle that closes the intent. Removal is only ever `git worktree remove` without --force, which itself refuses dirty trees.
 */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import { getTask } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { RETIRE_STAGES, type SchedulerSession } from "./scheduler-sessions.js";
import type { Git } from "./scheduler-review-worktree.js";
import type { TickPace } from "./scheduler-yield.js";

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
}

export interface RetireOutcome {
  taskId: string; step: "retired" | "handoff" | "held" | "unknown"; detail: string;
  /** For PM, set only by the settle that closed the intent; the pass sends one combined notice per project. */
  notice?: string;
}
export interface RetireTickResult { cards: RetireOutcome[]; failed: { taskId: string; error: string }[] }

/** Cards per pass: the first pass after rollout backfills dozens, and each kill is a manager child plus a channel delete. */
export const RETIRE_CARDS_PER_PASS = 5;
const RS = RETIRE_STAGES.map((s) => `'${s}'`).join(",");
const oneLine = (s: string, max = 560): string => s.replace(/\s+/g, " ").trim().slice(0, max) || "（空）";

/**
 * Finished cards with a session still to retire or a claimed retire intent to finish. A card with any other open intent waits
 * (beginRetire would refuse it, and it must not take a slot every pass); an unknown retire intent is PM's to reconcile.
 */
export function retireCandidates(db: Database, projects: readonly string[]): string[] {
  if (!projects.length || !db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_sessions'").get()) return [];
  const rows = db.query(`SELECT t.id FROM tasks t WHERE t.stage IN (${RS}) AND t.project IN (${projects.map(() => "?").join(",")})
    AND NOT EXISTS (SELECT 1 FROM scheduler_intents i WHERE i.taskId = t.id AND i.action = 'retire' AND i.status IN ('done','unknown','cancelled'))
    AND NOT EXISTS (SELECT 1 FROM scheduler_intents i WHERE i.taskId = t.id AND i.action != 'retire' AND i.status IN ('pending','submitted','unknown'))
    AND (EXISTS (SELECT 1 FROM scheduler_sessions s WHERE s.taskId = t.id AND s.state != 'retired')
      OR EXISTS (SELECT 1 FROM scheduler_intents i WHERE i.taskId = t.id AND i.action = 'retire' AND i.status = 'submitted'))
    ORDER BY t.updatedAt, t.id`).all(...projects) as { id: string }[];
  return rows.map((r) => r.id);
}

/** An unfinished card still using this agent (bound session or named executor): killing it would kill that card's work. */
export function agentStillInUse(db: Database, agent: string, taskId: string): string | null {
  const row = db.query(`SELECT t.id FROM tasks t WHERE t.id != ? AND t.stage NOT IN (${RS}) AND (t.agent = ?
    OR EXISTS (SELECT 1 FROM scheduler_sessions s WHERE s.taskId = t.id AND s.agent = ? AND s.state != 'retired')) LIMIT 1`)
    .get(taskId, agent, agent) as { id: string } | null;
  return row?.id ?? null;
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

  async kill(row: SchedulerSession): Promise<Effect> {
    if (row.transport === "peer") return { effect: "kill", receipt: "peer 会话：不在本机，不发命令，只标退役" };
    const user = agentStillInUse(this.db, row.agent, this.task.id);
    if (user) return { effect: "kill", receipt: `agent 仍被未收尾的 ${user} 使用：不 kill，只标退役` };
    const k = killOutcome(await this.deps.agent("kill", row.agent));
    return "receipt" in k ? { effect: "kill", receipt: k.receipt } : k;
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
  async worktree(dir: string): Promise<string | null> {
    if (!this.deps.exists(dir)) return null;
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

  async settle(to: "done" | "unknown", receipt: string): Promise<boolean> {
    const r = await this.deps.ledger("ledger", "scheduler-settle", this.intent.id, "--from", "submitted", "--to", to, "--receipt", oneLine(receipt));
    return r.ok === true;
  }

  async run(): Promise<RetireOutcome> {
    const rows = this.db.query("SELECT * FROM scheduler_sessions WHERE taskId = ? AND state != 'retired' ORDER BY role").all(this.task.id) as SchedulerSession[];
    for (const row of rows) {
      const stop = await this.session(row);
      if (!stop) continue;
      if ("busy" in stop) return this.out("held", stop.busy);
      const why = `${row.role} session ${row.agent} 收不掉：${stop.failed}`;
      const told = await this.settle("unknown", why);
      return { ...this.out("unknown", why), ...(told ? { notice: `${this.task.id} 收尾卡住，意图转 unknown 待核对：${oneLine(why)}` } : {}) };
    }
    const kept: string[] = [];
    for (const dir of worktreeDirs(this.deps.worktreeRoot, this.task.id)) {
      const why = await this.worktree(dir);
      if (why) kept.push(`${dir}：${why}`);
    }
    const sessions = rows.length ? `${rows.length} 个 session 已退役` : "session 早已退役";
    if (!kept.length) return this.out((await this.settle("done", `${sessions}；worktree 已清`)) ? "retired" : "held", sessions);
    const text = `${sessions}；worktree 没删，交 PM：${kept.join(" | ")}`;
    const told = await this.settle("done", text);
    return { ...this.out("handoff", text), ...(told ? { notice: `${this.task.id} worktree 没删，请看一眼：${oneLine(kept.join(" | "))}` } : {}) };
  }
}

/** One combined PM notice per project for this pass; a lost one is logged (each card's settle event is the durable record). */
async function notifyBatch(db: Database, deps: RetireDeps, cards: RetireOutcome[]): Promise<void> {
  const byProject = new Map<string, { task: LedgerTask; lines: string[] }>();
  for (const c of cards) {
    const task = c.notice ? getTask(db, c.taskId) : null;
    if (!task || !c.notice) continue;
    const group = byProject.get(task.project) ?? byProject.set(task.project, { task, lines: [] }).get(task.project)!;
    group.lines.push(`- ${c.notice}`);
  }
  for (const { task, lines } of byProject.values()) {
    const text = `[调度引擎] 卡收尾有 ${lines.length} 处要 PM 看（没删的 worktree 不加 --force、不 rm，原样留着）：\n${lines.join("\n")}`;
    await deps.notifyPm(task, text).catch((e: unknown) => {
      if (e instanceof SchedulerStopped) throw e;
      console.error(`⚠️ [scheduler] 收尾通知没发出去（台账已记）：${(e as Error).message}`);
    });
  }
}

/** One retirement step per pass for up to RETIRE_CARDS_PER_PASS finished cards; a card that fails does not stop the others. */
export async function schedulerRetireTick(db: Database, projects: readonly string[], deps: RetireDeps, pace?: TickPace): Promise<RetireTickResult> {
  const out: RetireTickResult = { cards: [], failed: [] };
  for (const taskId of retireCandidates(db, projects).slice(0, RETIRE_CARDS_PER_PASS)) {
    if (pace?.yieldNow()) break;
    const task = getTask(db, taskId);
    if (!task) continue;
    try {
      const r = await deps.ledger("ledger", "scheduler-retire", taskId);
      const intent = r.intent as SchedulerIntent | undefined;
      if (r.ok !== true || !intent) { out.cards.push({ taskId, step: "held", detail: oneLine(`退役意图没开成：${String(r.error)}`) }); continue; }
      if (intent.status !== "submitted") continue;
      out.cards.push(await new RetireCard(db, task, intent, deps).run());
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      out.failed.push({ taskId, error: oneLine((e as Error).message) });
    }
  }
  await notifyBatch(db, deps, out.cards);
  return out;
}
