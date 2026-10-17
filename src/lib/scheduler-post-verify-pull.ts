/**
 * Reminders remain ledger facts; pull mode only changes their delivery. A completed local calendar day is the aggregation
 * boundary, so cards becoming due later that day fit the same message. The next day's first tick sends it; no timers needed.
 * Claim the daily slot before sending so a restart cannot wake PM twice that day. Only delivery acknowledgements cover
 * cards: failed or interrupted batches remain eligible the next day. Overdue keeps its existing 30-minute retry policy.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { busyAsLedgerError, getEventByDedup, LedgerError, listTasks } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { asInfo } from "./pm-notice-level.js";
import { recoveryPolicy } from "./recovery-policy.js";
import { projectPm, type ServiceFacts } from "./scheduler-autostart.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { deferPlan, postVerifyDeferMode } from "./scheduler-post-verify-defer.js";
import {
  postVerifyDoneKey, postVerifyKind, postVerifySection, postVerifyTarget, readPostVerifySpec, verifiedAt, type PostVerifyKind,
} from "./scheduler-post-verify-ledger.js";
import { sendToPm, specWaitMode, type SpecWaitEnv } from "./scheduler-spec-wait.js";
import { schedulerV2SkipTask } from "./scheduler-v2-skip-card.js";
import { localDate } from "./sentinel-pilot.js";

const postVerifyPullMode = (project: string) => recoveryPolicy(project, "postVerifyPull").mode;
type Failed = { taskId: string; error: string }[];
type Card = { taskId: string; verifiedTs: number };
type Summary = { to: string; text: string; cards: Card[] };
const dayOf = (ts: number) => localDate(new Date(ts));
const dayStart = (ts: number) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const summaryKey = (project: string, day: string) => `post-verify-pull:${JSON.stringify([project, day])}`;
const cardKey = (c: Card) => JSON.stringify([c.taskId, c.verifiedTs]);

/** The legacy path keeps its exact payload and level; overdue in pull mode must bypass the info-only inbox. */
export async function sendPostVerify(env: SpecWaitEnv, project: string, taskId: string, kind: PostVerifyKind, to: string, text: string): Promise<string | undefined> {
  const mode = postVerifyPullMode(project);
  if (mode === "on") {
    if (kind === "overdue") await sendToPm(env, project, to, text, "action");
    return;
  }
  let warning: string | undefined;
  if (mode === "observe" && kind === "remind") {
    try {
      const r = await env.ledger("ledger", "scheduler-recovery-observe", taskId, "--mechanism", "postVerifyPull", "--action-key", "pull-reminder",
        "--action", "上线后提醒本会只记台账，由 pm-todo 拉取，不逐卡推 PM");
      if (r.code === "lease-lost") throw new SchedulerStopped(`ledger post-verify-pull: ${String(r.error)}`);
      if (r.ok !== true) throw new Error(String(r.error ?? r.code));
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      warning = `上线后拉取观察记账失败（旧提醒仍发送）：${(e as Error).message}`;
    }
  }
  await asInfo(() => sendToPm(env, project, to, text, "info"));
  return warning;
}

function unsummarized(db: Database, project: string, now: number): Summary | null {
  const sent = db.query("SELECT data FROM events WHERE project = ? AND actor = 'scheduler' AND kind = 'note'"
    + " AND json_extract(data, '$.op') = 'post_verify_pull' AND json_extract(data, '$.kind') = 'sent'")
    .all(project) as { data: string }[];
  const seen = new Set(sent.flatMap((r) => (JSON.parse(r.data).cards as Card[]).map(cardKey)));
  const cards: Card[] = [], targets = new Set<string>();
  for (const t of listTasks(db, project)) {
    if (schedulerV2SkipTask(db, t.id)) continue;
    if (t.stage !== "verified" || getEventByDedup(db, postVerifyDoneKey(t.id))) continue;
    const at = verifiedAt(db, t), ref = { taskId: t.id, verifiedTs: at };
    if (seen.has(cardKey(ref))) continue;
    const closed = getEventByDedup(db, `post-verify-overdue:${t.id}:on`);
    if (closed && closed.ts >= at) continue;
    const section = postVerifySection(readPostVerifySpec(t.id)?.text);
    if (!section) continue;
    const plan = deferPlan(postVerifyDeferMode(db, project), section, at, now);
    if (plan.hold || postVerifyKind(db, t, now, plan.hours) !== "remind") continue;
    const first = db.query("SELECT ts FROM events WHERE target = ? AND actor = 'scheduler' AND kind = 'note' AND ts >= ?"
      + " AND json_extract(data, '$.op') = 'post_verify' AND json_extract(data, '$.kind') = 'remind'"
      + " AND json_extract(data, '$.mode') = 'on' ORDER BY seq LIMIT 1").get(t.id, at) as { ts: number } | null;
    if (!first || first.ts >= dayStart(now)) continue;
    const to = postVerifyTarget(db, t, "remind");
    if (!to) continue;
    cards.push(ref); targets.add(to);
  }
  cards.sort((a, b) => a.taskId.localeCompare(b.taskId));
  const to = targets.size === 1 ? [...targets][0] : projectPm(db, project);
  if (!cards.length || !to) return null;
  return { to, cards, text: `${cards.length} 条上线后待办到期，\`ledger pm-todo\` 查看\n${cards.map((c) => c.taskId).join("、")}` };
}

/** The writer recomputes the batch in one transaction; callers cannot supply recipients, bodies or dedup keys. */
export function postVerifyPullCli(db: Database, ctx: WriteCtx, pos: string[], flags: Record<string, string | undefined>, svc: Pick<ServiceFacts, "projects">) {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "上线后汇总只给调度服务写");
  const [project, op, claimKey] = pos, now = ctx.now ?? Date.now(), day = dayOf(now);
  if ((op !== "claim" && op !== "sent") || pos.length !== (op === "sent" ? 3 : 2)
    || ctx.dedupKey !== undefined || Object.values(flags).some((v) => v !== undefined)) {
    throw new LedgerError("invalid", "post-verify-pull <项目> claim|sent [认领键]（不收旗标 / 自定义正文）");
  }
  if (!svc.projects.includes(project)) throw new LedgerError("forbidden", "项目不归调度服务管");
  return busyAsLedgerError("记上线后汇总", () => db.transaction(() => {
    if (op === "sent") return acknowledgeSummary(db, ctx, project, claimKey);
    if (specWaitMode(db, project) !== "on" || postVerifyPullMode(project) !== "on") throw new LedgerError("conflict", "上线后拉取开关已变");
    const key = summaryKey(project, day);
    if (getEventByDedup(db, key)) return { ok: true, due: false };
    const batch = unsummarized(db, project, now);
    if (!batch) return { ok: true, due: false };
    appendEvent(db, { ...ctx, dedupKey: key }, { project, target: "", kind: "note", text: batch.text,
      data: { op: "post_verify_pull", kind: "claimed", day, ...batch } });
    return { ok: true, due: true, claimKey: key, to: batch.to, text: batch.text };
  }).immediate());
}

/** Acknowledge the exact claimed batch, even if its PM, day or switches changed while the send was in flight. */
function acknowledgeSummary(db: Database, ctx: WriteCtx, project: string, claimKey: string) {
  const claim = getEventByDedup(db, claimKey);
  if (!claim || claim.project !== project || claim.actor !== "scheduler" || claim.kind !== "note"
    || claim.data.op !== "post_verify_pull" || claim.data.kind !== "claimed") throw new LedgerError("conflict", "没有该项目的汇总发送认领");
  appendEvent(db, { ...ctx, dedupKey: `${claimKey}:sent` }, { project, target: "", kind: "note", text: claim.text,
    data: { ...claim.data, kind: "sent" } });
  return { ok: true, due: false };
}

/** Runs even when no card passes the per-card 30-minute throttle, including after a scheduler restart. */
export async function postVerifyPullTick(env: SpecWaitEnv, project: string, failed: Failed): Promise<void> {
  if (specWaitMode(env.db, project) !== "on" || postVerifyPullMode(project) !== "on") return;
  if (getEventByDedup(env.db, summaryKey(project, dayOf(env.now())))) return;
  try {
    if (!unsummarized(env.db, project, env.now())) return;
    const r = await env.ledger("ledger", "scheduler-autostart", "post-verify-pull", project, "claim");
    if (r.code === "lease-lost") throw new SchedulerStopped(String(r.error));
    if (r.code === "conflict") return;
    if (r.ok !== true) throw new Error(`汇总记账失败：${String(r.error ?? r.code)}`);
    if (r.due !== true) return;
    await sendToPm(env, project, String(r.to), String(r.text), "action");
    const ack = await env.ledger("ledger", "scheduler-autostart", "post-verify-pull", project, "sent", String(r.claimKey));
    if (ack.code === "lease-lost") throw new SchedulerStopped(String(ack.error));
    if (ack.ok !== true) throw new Error(`汇总已发、确认失败：${String(ack.error ?? ack.code)}`);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    failed.push({ taskId: "post-verify-pull", error: (e as Error).message });
  }
}
