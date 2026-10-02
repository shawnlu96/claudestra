/**
 * i28-SR1: a security card is reviewed on this machine only (scheduler-placement-plan.ts), so when the reviewing family's local
 * cap is 0 (not busy: configured 0) it can never be placed. The planner says so with a fixed wait reason instead of queueing
 * silently; the tick then writes one alarm event per card + reason and opens one PM ask (a: grant 1 slot for this card, the
 * default, only after PM confirms; b: another local reviewer family, with a reason and owner approval; c: back to the author).
 * A cap above 0 that is merely busy keeps the old queueing. The family is the current head's (remoteHeadFamily, as autoSnapshot
 * plans with), so the alarm, ask and dedup reason name the family the planner actually waits for. The ask is the scheduler's own
 * (bridge never forwards its answer), so the tick reads it back: once answered or closed, the choice is recorded and handed to the
 * card's PM to carry out (a still needs PM's confirmation, b still needs owner approval); the scheduler never widens a cap itself.
 * tests/scheduler-sec-review.test.ts.
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getAsk, openAskFull, ownerAnswered, type Ask } from "./ledger-asks.js";
import { getWorkflow, type AuthorFamily } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { PlannerDecision } from "./scheduler-plan.js";

export const SEC_REVIEW_NO_ROOM = "安全卡审查放不下";
const CODE = "sec_review_no_room";

type Remote = { agents?: Partial<Record<AuthorFamily, number>>; localFamilies?: readonly AuthorFamily[] } | null | undefined;
interface SecFacts {
  workflow: { template: string; authorFamily: AuthorFamily } | null;
  pool?: { remote: Remote } | null;
}

const reviewFamily = (author: AuthorFamily): AuthorFamily => author === "claude" ? "codex" : "claude";
const reasonFor = (family: AuthorFamily): string =>
  `${SEC_REVIEW_NO_ROOM}：安全卡只在本机审，审查要 ${family}，本机 ${family} 名额上限是 0；已报 PM 选 a 临时开名额 / b 改派 / c 退回重写`;

/** The local cap of a family: agents mode's limit, 0 when localFamilies leaves it out; null = no cap configured here. */
function localCap(remote: Remote, family: AuthorFamily): number | null {
  if (remote?.agents) return remote.agents[family] ?? 0;
  if (remote?.localFamilies) return remote.localFamilies.includes(family) ? null : 0;
  return null;
}

/**
 * Planner hook: a security card whose review family has local cap 0 waits with the fixed reason; anything else = null (unchanged).
 * A bound reviewer is no exemption: agentPoolReview / localReviewFallback still refuse its family at cap 0.
 */
export function secReviewNoRoom(s: SecFacts): { wait: string; code: string } | null {
  if (s.workflow?.template !== "security") return null;
  const family = reviewFamily(s.workflow.authorFamily);
  return localCap(s.pool?.remote, family) === 0 ? { wait: reasonFor(family), code: CODE } : null;
}

/** Card + reason, hashed because the reason is free text. */
const alarmKey = (taskId: string, reason: string): string =>
  `sec-review-no-room:${taskId}:${createHash("sha256").update(reason).digest("hex").slice(0, 24)}`;

function askBody(task: LedgerTask, family: AuthorFamily): string {
  return [`${task.id} 是安全卡，只在本机审；作者家族的对面是 ${family}，本机 ${family} 名额上限是 0，调度器放不下这次审查。`,
    "选一个：",
    `a. 本机临时给这张卡开 1 个 ${family} 名额（default；PM 确认后才执行）`,
    `b. 改派本机非 ${family} 的审查员：写明理由，仍需 owner 批`,
    "c. 退回作者重写"].join("\n");
}


const CHOICES = [
  ["sec_review_grant", (f: AuthorFamily) => `a（临时开名额）：请 PM 确认后执行——本机临时给这张卡开 1 个 ${f} 审查名额（或起本机 ${f} 审查员），调度器不会自己放宽上限`],
  ["sec_review_other", (f: AuthorFamily) => `b（改派）：改派本机非 ${f} 的审查员，PM 写明理由，仍要 owner 批准后才执行`],
  ["sec_review_rewrite", () => "c（退回）：请 PM 把卡退回作者重写"],
] as const;

/** What PM is told once the ask closed: the picked option (with its confirm / owner-approval condition), or that none was picked. */
function handoffText(task: LedgerTask, family: AuthorFamily, ask: Ask): { text: string; choice: string | null } {
  const picked = CHOICES.find(([id]) => ask.answer?.choices.some((w) => w.includes(`:${id}]`)));
  const who = ask.answer ? (ownerAnswered(ask.answer) ? "owner" : ask.answer.principal) : "";
  const note = ask.answer?.text && ask.answer.external !== true ? `；附言：${ask.answer.text.slice(0, 300)}` : "";
  const text = picked
    ? `[调度引擎] ${task.id} 安全卡审查放不下，提问卡 ${ask.id} 由 ${who} 选了 ${picked[1](family)}${note}。PM 执行前卡照旧等待`
    : `[调度引擎] ${task.id} 安全卡审查放不下，提问卡 ${ask.id} 已结案（${ask.state}）但没选 a/b/c${note}：卡仍在等本机 ${family} 名额，请 PM 决定`;
  return { text, choice: picked?.[0] ?? null };
}

/** Structural CLI port (same shape as scheduler-family-pick-notice.ts) keeps lib independent of manager. */
interface AlarmCommand {
  db: Database; p: { pos: string[]; flags: Record<string, string | undefined> }; ctx(): WriteCtx; need(flag: string): string;
  task(id: string | undefined): LedgerTask;
}

/**
 * `ledger scheduler-sec-review-alarm`: phase alarm (default) = one alarm event + one PM ask per card and reason, in one transaction;
 * alarm-sent = the alarm's PM notice reached PM; phase handoff = the closed ask's choice recorded once for PM; handoff-sent = that
 * hand-off reached PM. A repeat writes nothing.
 * The review family comes from the current head's author (remoteHeadFamily ?? workflow), the same one autoSnapshot plans with.
 */
export const secReviewAlarmCommand = {
  valued: ["rev", "phase", "ask"], bools: [], usage: "scheduler-sec-review-alarm <task> --rev N [--phase alarm|alarm-sent|handoff|handoff-sent --ask <id>]",
  run(c: AlarmCommand): Record<string, unknown> {
    return c.db.transaction(() => {
      const ctx = c.ctx(), task = c.task(c.p.pos[1]), wf = getWorkflow(c.db, task.id), phase = c.p.flags.phase ?? "alarm";
      if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "安全卡审查放不下的报警只由调度服务记账");
      if (task.stage !== "review" || task.rev !== Number(c.need("rev")) || wf?.mode !== "auto" || wf.template !== "security") {
        throw new LedgerError("conflict", "卡已不在安全卡自动审查等待状态");
      }
      const family = reviewFamily(remoteHeadFamily(c.db, task) ?? wf.authorFamily), reason = reasonFor(family), key = alarmKey(task.id, reason);
      if (phase === "handoff" || phase === "handoff-sent") return handoff(c, ctx, task, family, key, phase);
      const prior = getEventByDedup(c.db, key);
      if (phase === "alarm-sent") {
        if (!prior) throw new LedgerError("conflict", "报警尚未记账");
        return { ok: true, ...appendEvent(c.db, { ...ctx, dedupKey: `${key}:sent` }, {
          project: task.project, target: task.id, kind: "note", text: prior.text, data: { op: `${CODE}_sent` } }) };
      }
      if (phase !== "alarm") throw new LedgerError("invalid", "phase must be alarm|alarm-sent|handoff|handoff-sent");
      if (prior) return { ok: true, duplicate: true, event: prior };
      const { event } = appendEvent(c.db, { ...ctx, dedupKey: key }, {
        project: task.project, target: task.id, kind: "note", text: reason, data: { op: CODE, kind: "alarm", family },
      });
      const { ask } = openAskFull(c.db, {
        project: task.project, taskId: task.id, source: "system", kind: "decide", fromAgent: "scheduler", createdBy: "system:scheduler",
        blocking: true, title: `${task.id} 安全卡审查本机没有 ${family} 名额`, body: askBody(task, family), context: reason, dedupKey: `${key}:ask`,
        options: [{ type: "buttons", buttons: [
          { id: "sec_review_grant", label: `a. 临时开 1 个 ${family} 名额（default）`, style: "success" },
          { id: "sec_review_other", label: "b. 改派其他家族（要 owner 批）", style: "secondary" },
          { id: "sec_review_rewrite", label: "c. 退回作者重写", style: "danger" },
        ] }],
      }, ctx.now ?? Date.now());
      return { ok: true, duplicate: false, event, askId: ask.id };
    }).immediate();
  },
};

function handoff(c: AlarmCommand, ctx: WriteCtx, task: LedgerTask, family: AuthorFamily, key: string, phase: string): Record<string, unknown> {
  const ask = getAsk(c.db, c.need("ask"));
  if (!ask || ask.taskId !== task.id || ask.dedupKey !== `${key}:ask`) throw new LedgerError("conflict", "不是这张卡当前原因的安全卡审查提问卡");
  if (ask.state === "open") throw new LedgerError("conflict", "提问卡还没答");
  const hk = `${key}:handoff:${ask.id}`, pending = getEventByDedup(c.db, hk);
  if (phase === "handoff-sent") {
    if (!pending) throw new LedgerError("conflict", "交接尚未记账");
    return { ok: true, ...appendEvent(c.db, { ...ctx, dedupKey: `${hk}:sent` }, {
      project: task.project, target: task.id, kind: "note", text: pending.text, data: { op: `${CODE}_handoff_sent`, askId: ask.id } }) };
  }
  if (pending) return { ok: true, duplicate: true, event: pending, text: pending.text };
  const { text, choice } = handoffText(task, family, ask);
  const { event } = appendEvent(c.db, { ...ctx, dedupKey: hk }, { project: task.project, target: task.id, kind: "note", text,
    data: { op: `${CODE}_handoff`, kind: "handoff", askId: ask.id, askState: ask.state, choice, family, owner: ownerAnswered(ask.answer) } });
  return { ok: true, duplicate: false, event, text };
}

interface NoticeDeps { notifyPm(task: LedgerTask, text: string): Promise<void>; manager(...args: string[]): Promise<Record<string, unknown>> }
const lost = (what: string) => (e: unknown): void => {
  if (e instanceof SchedulerStopped) throw e;
  console.error(`⚠️ [scheduler] ${what}：${(e as Error).message}`);
};

/**
 * Tick hook (watch): on the planner's fixed reason, record the alarm + ask once and tell PM (retried each tick until delivered, as
 * long as the ask is open); once that ask is answered or closed, record the choice and hand it to PM (retried the same way).
 */
export async function raiseSecReviewNoRoom(db: Database, task: LedgerTask, wait: Extract<PlannerDecision, { kind: "wait" }>, deps: NoticeDeps): Promise<void> {
  if (task.stage !== "review" || !wait.reason.startsWith(SEC_REVIEW_NO_ROOM)) return;
  const key = alarmKey(task.id, wait.reason);
  if (!getEventByDedup(db, key)) {
    const r = await step(deps, task);
    if (r.ok !== true) { console.error(`⚠️ [scheduler] 安全卡审查报警未记账，下轮重试：${String(r.error)}`); return; }
  }
  const row = db.query("SELECT id FROM asks WHERE taskId = ? AND dedupKey = ?").get(task.id, `${key}:ask`) as { id: string } | null;
  const ask = row && getAsk(db, row.id);
  if (!ask) return;
  return ask.state === "open" ? alarmNotice(task, key, ask, wait, deps, db) : handOffAnswer(task, key, ask, deps, db);
}

const step = (deps: NoticeDeps, task: LedgerTask, ...extra: string[]) =>
  deps.manager("ledger", "scheduler-sec-review-alarm", task.id, "--rev", String(task.rev), ...extra);

/** The alarm's first PM notice: pending until a send succeeds and is marked (alarm-sent), so a bridge failure or crash retries. */
async function alarmNotice(task: LedgerTask, key: string, ask: Ask, wait: { reason: string }, deps: NoticeDeps, db: Database): Promise<void> {
  if (getEventByDedup(db, `${key}:sent`)) return;
  try {
    await deps.notifyPm(task, `[调度引擎] ${task.id} ${wait.reason}。提问卡 ${ask.id} 已开，default a 要 PM 确认才执行`);
  } catch (e) { lost("安全卡审查报警通知失败（台账已记、提问卡已开，下轮重发）")(e); return; }
  const sent = await step(deps, task, "--phase", "alarm-sent");
  if (sent.ok !== true) console.error(`⚠️ [scheduler] 安全卡审查报警已通知 PM 但标记未记账，下轮可能重发：${String(sent.error)}`);
}

async function handOffAnswer(task: LedgerTask, key: string, ask: Ask, deps: NoticeDeps, db: Database): Promise<void> {
  if (getEventByDedup(db, `${key}:handoff:${ask.id}:sent`)) return;
  const phase = (p: string) => step(deps, task, "--phase", p, "--ask", ask.id);
  const r = await phase("handoff");
  if (r.ok !== true) { console.error(`⚠️ [scheduler] 安全卡审查提问卡答复未记账，下轮重试：${String(r.error)}`); return; }
  try { await deps.notifyPm(task, String(r.text)); } catch (e) { lost("安全卡审查答复交给 PM 失败（台账已记，下轮重发）")(e); return; }
  const sent = await phase("handoff-sent");
  if (sent.ok !== true) console.error(`⚠️ [scheduler] 安全卡审查答复已交 PM 但标记未记账，下轮可能重发：${String(sent.error)}`);
}
