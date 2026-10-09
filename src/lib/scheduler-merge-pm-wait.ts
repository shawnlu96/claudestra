/**
 * 合并待 PM 处置提醒（dispatch-recovery-MQWAKE1）的纯候选：调度 tick 的只读预筛与台账 writer 的事务重核用的是同一个 mergePmCandidate。
 * 只认 merge 阶段、workflow manual 的 code 卡，且卡上最新一条人工合并请求（MQ1 正式事实）曾被台账受理、没被 PM 撤回、现在 void，
 * 并且失效来自绑定（head / specRev / 轮次 / 审查）或 UI 截图门；卡上有未结调度意图（pending / submitted / unknown：外部合并效果
 * 未定）、请求仍 queued / waiting、项目是仓库方交接，都不算。判定全读结构化事实（requestRefusal / reviewRefusal / uiMergeRefusal），
 * 不解析 why 文本。阻塞实例键 = 卡 + 请求 + 当前 head / specRev / 轮次 / 审查 / 截图摘要 + 原因：绑定任一项再变就是新的阻塞。
 * 记录与节流见 scheduler-merge-pm-ledger.ts；设计见 docs/architecture/scheduler-autostart.md「合并待 PM 处置提醒」。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { getWorkflow } from "./ledger-scheduler.js";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import { getMeta, getTask, listEvents } from "./ledger-store.js";
import {
  configHandoff, listRequests, requestRefusal, reviewRefusal, revokeOf, type HandoffPort, type ManualRequest,
} from "./manual-merge-queue-facts.js";
import { featurePm, projectPm } from "./scheduler-autostart.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { uiMergeRefusal } from "./scheduler-ui-merge-refusal.js";

/** ui = 当前 head 的截图门不过；unreviewed = 当前没有成立的正规审查；其余 = 请求绑定的那一项变了（重新提交请求即可） */
type MergePmReason = "ui" | "unreviewed" | "head" | "spec" | "round" | "review" | "digest";

export interface MergePmCandidate {
  taskId: string; project: string; request: number; head: string; specRev: number; round: number;
  reviewSeq: number | null; digest: string | null; reasons: MergePmReason[]; key: string; text: string;
}

const REASON_TEXT: Record<MergePmReason, string> = {
  ui: "截图门未过", unreviewed: "当前 head 没有成立的跨族审查", head: "head 已变", spec: "规格版本已变", round: "轮次已变", review: "审查结论已换",
  digest: "截图摘要已变",
};

/** 卡的当前审查若正规成立（跨族、通过、写入人合规），返回它可被新请求绑定的 seq；否则 null */
function standingReview(db: Database, task: NonNullable<ReturnType<typeof getTask>>, req: ManualRequest): number | null {
  const events = listEvents(db, { project: task.project, target: task.id });
  const read = currentReviewFacts(task, events, (a) => actorMayConfigure(db, a, task.project));
  if (read.kind !== "facts") return null;
  const f = read.facts, ev = events.find((e) => e.seq === f.eventSeq);
  if (!ev) return null;
  const review = { seq: f.eventSeq, actor: ev.actor, reviewer: f.reviewer, sessionId: f.reviewerSessionId, family: f.reviewerFamily,
    reportPath: f.reportPath, verdict: f.verdict };
  return reviewRefusal(db, task, events, { review, requestedBy: req.requestedBy }) ? null : f.eventSeq;
}

function nextSteps(c: Pick<MergePmCandidate, "head" | "specRev" | "round" | "reviewSeq" | "reasons">): string {
  const at = `head ${c.head.slice(0, 12)} / specRev ${c.specRev} / 第 ${c.round} 轮`;
  const steps: string[] = [];
  if (c.reasons.includes("unreviewed")) steps.push(`在当前 ${at} 完成正规跨族审查并登记`);
  if (c.reasons.includes("ui")) steps.push("在当前 head 重拍截图 → PM 核图 / 登记 ui-approve（符合原沿用门时才沿用）");
  const review = c.reviewSeq === null ? "新审查" : `审查 #${c.reviewSeq}`;
  steps.push(`再提交绑定当前 ${at} / ${review} 的 manual-merge-request`);
  return steps.map((s, i) => `${i + 1}. ${s}`).join("；");
}

/** 收件人：仍合法的 feature PM，否则项目当班 PM；调度助理 / 不在 PM 名单的一律不收 */
export function mergePmTarget(db: Database, taskId: string): string | null {
  const t = getTask(db, taskId), meta = t && getMeta(db, t.project);
  const pm = t && (t.featureId ? featurePm(db, t.featureId) : projectPm(db, t.project));
  return t && meta && pm && meta.pms.includes(pm) && pm !== meta.team?.dispatcher ? pm : null;
}

export function mergePmCandidate(db: Database, taskId: string, now: number, handoff: HandoffPort = configHandoff): MergePmCandidate | null {
  const task = getTask(db, taskId), wf = task && getWorkflow(db, task.id);
  if (!task || !wf || task.kind !== "code" || task.stage !== "merge" || wf.mode !== "manual" || !task.headSHA) return null;
  const open = db.query("SELECT 1 FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown') LIMIT 1").get(task.id);
  const req = listRequests(db, task.project, task.id).at(-1);
  if (open || !req || revokeOf(db, req) || handoff(task.project) || requestRefusal(db, req, now, false, handoff)?.kind !== "void") return null;
  const reviewSeq = standingReview(db, task, req);
  const digest = typeof task.extra.screenshotsDigest === "string" ? task.extra.screenshotsDigest : null;
  const ui = wf.template === "ui", uiFails = ui && uiMergeRefusal(db, task, now) !== null;
  const reasons = ([
    [uiFails, "ui"], [reviewSeq === null, "unreviewed"], [task.headSHA !== req.head, "head"],
    [task.specRev !== req.specRev || wf.specRev !== task.specRev, "spec"], [task.round !== req.round, "round"],
    [reviewSeq !== null && reviewSeq !== req.review.seq, "review"], [ui && !uiFails && digest !== req.uiDigest, "digest"],
  ] as [boolean, MergePmReason][]).filter(([on]) => on).map(([, r]) => r);
  if (!reasons.length) return null;
  const base = { taskId: task.id, project: task.project, request: req.seq, head: task.headSHA, specRev: task.specRev, round: task.round, reviewSeq, digest, reasons };
  const key = createHash("sha256").update(JSON.stringify(base)).digest("hex").slice(0, 16);
  const text = `[合并待处置] ${task.id} 人工合并请求 #${req.seq} 已失效（${reasons.map((r) => REASON_TEXT[r]).join("、")}），` +
    `合并不会自动继续，${ui ? "旧截图 / " : ""}旧请求不会自动沿用。下一步：${nextSteps(base)}。阻塞键 ${key}`;
  return { ...base, key, text };
}
