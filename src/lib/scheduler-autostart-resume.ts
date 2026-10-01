/**
 * 自动交回（i28-A1 §4）：合并被撤销后切成 manual 的卡，执行者交付了新 head，调度服务下一轮自己做一次 workflow-resume。
 * 判定只读本卡的事件、workflow 与 scheduler_merges / intents（resumeVerdict）；台账侧 `ledger scheduler-auto-resume` 在事务里再判一遍才写。
 * 触发事件 T = 本卡最近一条「切 manual / 回 auto」的事件，只认「合并结清为 cancelled / failed」与「planner 因合并意图被取消退回人工」；
 * PM 接管、PM hold（带 hold 的 workflow 事件）、别的退回人工、已交回、开 auto 都排在后面就不交回。T 之后只改模板 / 退路的 manual→manual 不算拦。
 * 放在 auto tick 之前，交回的卡同一轮就能派审。V1 10-01 的事件序列是金样本：tests/scheduler-autostart-resume.test.ts。
 */
import type { Database } from "bun:sqlite";
import { getWorkflow, type TaskWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getTask, listEvents } from "./ledger-store.js";
import { readSwitch, switchOff, type ServiceFacts } from "./scheduler-autostart.js";
import type { TickPace } from "./scheduler-yield.js";

export const MERGE_RETRY_PREFIX = "merge_retry_requires_pm：";
const MODE_OPS = new Set(["merge_resolve", "deploy_resolve", "fallback_manual", "workflow_resume"]);

/** 会改变「卡归谁推」的事件；只改模板 / 退路的 manual→manual 不算 */
function modeEvent(e: LedgerEvent): boolean {
  if (e.kind !== "scheduler") return false;
  const op = String(e.data.op);
  if (MODE_OPS.has(op)) return true;
  return op === "workflow" && (e.data.mode !== "manual" || !!e.data.takeover || !!e.data.hold);
}

function isTrigger(e: LedgerEvent): boolean {
  if (e.data.op === "merge_resolve") return e.data.outcome === "cancelled" || e.data.outcome === "failed";
  return e.data.op === "fallback_manual" && String(e.data.reason ?? "").startsWith(MERGE_RETRY_PREFIX);
}

/** 被撤销的那次合并审过的 head：结清的合并取 scheduler_merges.reviewedHead；planner 退回的取 T 之前最近一个被取消的合并意图的 head */
function revokedHead(db: Database, task: LedgerTask, t: LedgerEvent): string | null {
  if (t.data.op === "merge_resolve") {
    const row = db.query("SELECT reviewedHead FROM scheduler_merges WHERE intentId = ? AND taskId = ?").get(String(t.data.intentId), task.id) as { reviewedHead: string } | null;
    return row?.reviewedHead ?? null;
  }
  const row = db.query(`SELECT head FROM scheduler_intents WHERE taskId = ? AND action = 'merge' AND status = 'cancelled' AND eventSeq < ?
    ORDER BY eventSeq DESC LIMIT 1`).get(task.id, t.seq) as { head: string | null } | null;
  return row?.head ?? null;
}

interface ResumeFacts { trigger: number; deliver: number; head: string; revoked: string }
export type ResumeVerdict = { ok: true; facts: ResumeFacts } | { ok: false; why: string };

const no = (why: string): ResumeVerdict => ({ ok: false, why });

/** 只看卡本身（开关、调度服务另判）：workflow manual、卡在 review、T 是合并撤销、之后执行者交付了不同的 head 且阶段停在那次交付 */
export function resumeVerdict(db: Database, task: LedgerTask, workflow: TaskWorkflow | null): ResumeVerdict {
  if (workflow?.mode !== "manual") return no("workflow 不是 manual");
  if (task.stage !== "review") return no(`卡在 ${task.stage}，不在 review`);
  const events = listEvents(db, { project: task.project, target: task.id });
  const t = events.filter(modeEvent).at(-1);
  if (!t || !isTrigger(t)) return no(t ? `最近一次切换是 ${String(t.data.op)}，不是合并撤销` : "没有切 manual 的事件");
  const revoked = revokedHead(db, task, t);
  if (!revoked) return no("找不到被撤销合并的 head");
  const d = events.filter((e) => e.kind === "deliver" && e.seq > t.seq).at(-1);
  if (!d) return no("撤销后还没有交付");
  if (!task.agent || d.actor !== task.agent) return no(`最近的交付是 ${d.actor}，不是执行者 ${task.agent ?? "（空）"}`);
  const head = typeof d.data.headSHA === "string" ? d.data.headSHA : null;
  if (!head || head === revoked) return no("交付的还是被撤销的那个 head");
  if (task.headSHA !== head) return no("卡上的 head 不是这次交付的");
  const stage = events.filter((e) => e.kind === "stage").at(-1);
  if (!stage || stage.seq !== d.seq - 1 || stage.data.to !== "review" || stage.actor !== d.actor) return no("交付之后阶段又被动过");
  return { ok: true, facts: { trigger: t.seq, deliver: d.seq, head, revoked } };
}

/** 调度服务与开关：项目列在 scheduler.json、autoDispatch 开着、项目与卡所在 feature 的开关都开 */
export function serviceBlock(db: Database, task: LedgerTask, svc: ServiceFacts): string | null {
  if (!svc.autoDispatch || !svc.projects.includes(task.project)) return `调度服务没对项目 ${task.project} 开自动派单`;
  return switchOff(readSwitch(db, task.project), task.featureId ?? null);
}

export interface ResumeTickEnv {
  db: Database;
  svc: ServiceFacts;
  /** 调度身份的 ledger CLI（已套租约守卫） */
  ledger(...args: string[]): Promise<Record<string, unknown>>;
  notifyPm(project: string, text: string): Promise<void>;
  /** 进程内去重：同一次交付被核心拒绝只通知一次 */
  memo: Set<string>;
}

const QUIET = new Set(["raced", "not_eligible", "busy"]);

export async function autoResumeTick(env: ResumeTickEnv, pace?: TickPace): Promise<{ taskId: string; error: string }[]> {
  const failed: { taskId: string; error: string }[] = [];
  for (const project of env.svc.projects) {
    const ids = env.db.query(`SELECT w.taskId FROM task_workflows AS w JOIN tasks AS t ON t.id = w.taskId
      WHERE w.project = ? AND w.mode = 'manual' AND t.stage = 'review' ORDER BY w.taskId`).all(project) as { taskId: string }[];
    for (const { taskId } of ids) {
      if (pace?.yieldNow()) return failed;
      const task = getTask(env.db, taskId);
      if (!task || serviceBlock(env.db, task, env.svc)) continue;
      const wf = getWorkflow(env.db, taskId);
      const v = resumeVerdict(env.db, task, wf);
      // 被核心拒过的这次交付不再重试（进程内记着；重启后最多再试、再通知一次）
      const key = `resume:${taskId}:${v.ok ? v.facts.deliver : 0}`;
      if (!v.ok || !wf || env.memo.has(key)) continue;
      const r = await env.ledger("ledger", "scheduler-auto-resume", taskId, "--rev", String(task.rev), "--workflow-rev", String(wf.rev),
        "--max-workers", String(env.svc.maxWorkers(project)));
      if (r.ok === true || QUIET.has(String(r.code))) continue;
      if (r.code !== "rejected") {
        failed.push({ taskId, error: `自动交回：${String(r.error ?? r.code)}` });
        continue;
      }
      env.memo.add(key);
      await env.notifyPm(project, `[自动交回 ${taskId}] 合并撤销后执行者交付了新 head ${v.facts.head.slice(0, 12)}，交回调度被拒：${String(r.error)}。` +
        "对完账后用 workflow-resume 手动交回。").catch((e) => failed.push({ taskId, error: `通知 PM 失败：${(e as Error).message}` }));
    }
  }
  return failed;
}
