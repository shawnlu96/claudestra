/**
 * 合并待 PM 处置提醒（dispatch-recovery-MQWAKE1）的纯候选：调度 tick 的只读预筛与台账 writer 的事务重核用的是同一个 mergePmCandidate。
 * 只认 merge 阶段的 code 卡，两支：① workflow manual 且卡上最新一条人工合并请求（MQ1 正式事实）曾被台账受理、没被 PM 撤回、现在 void，
 * 失效来自绑定（head / specRev / 轮次 / 审查）或 UI 截图门；② 卡上没有人工请求（manual 未提交或 auto 卡），当前 head 截图门不过而
 * 代码审查仍正规成立（PM 定第 2 点前半）。卡上有未结调度意图（pending / submitted / unknown：外部合并效果未定）、合并已实际结清只差部署
 * （mergedPendingDeploy）、请求仍 queued / waiting、请求被 PM 撤回、项目是仓库方交接，都不算。判定全读结构化事实（requestRefusal / reviewRefusal / uiMergeRefusal），
 * 不解析 why 文本。阻塞实例键 = 卡 + 请求 + 当前 head / specRev / 轮次 / 审查 / 截图摘要 + 原因：绑定任一项再变就是新的阻塞。
 * 记录与节流见 scheduler-merge-pm-ledger.ts；设计见 docs/architecture/scheduler-autostart.md「合并待 PM 处置提醒」。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { getWorkflow, type SchedulerIntent } from "./ledger-scheduler.js";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import { getMeta, getTask, listEvents } from "./ledger-store.js";
import {
  configHandoff, intentOf, listRequests, requestRefusal, reviewRefusal, revokeOf, SHA, type HandoffPort, type ManualRequest,
} from "./manual-merge-queue-facts.js";
import { featurePm, projectPm } from "./scheduler-autostart.js";
import { getMergeRun } from "./scheduler-merge.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { uiMergeRefusal } from "./scheduler-ui-merge-refusal.js";

/** ui = 当前 head 的截图门不过；unreviewed = 当前没有成立的正规审查；其余 = 请求绑定的那一项变了（重新提交请求即可） */
type MergePmReason = "ui" | "unreviewed" | "head" | "spec" | "round" | "review" | "digest";

export interface MergePmCandidate {
  taskId: string; project: string; request: number | null; head: string; specRev: number; round: number;
  reviewSeq: number | null; digest: string | null; reasons: MergePmReason[]; key: string; text: string;
}

const REASON_TEXT: Record<MergePmReason, string> = {
  ui: "截图门未过", unreviewed: "当前 head 没有成立的跨族审查", head: "head 已变", spec: "规格版本已变", round: "轮次已变", review: "审查结论已换",
  digest: "截图摘要已变",
};

/** 卡的当前审查若正规成立（跨族、通过、写入人合规），返回它可被新请求绑定的 seq；否则 null */
function standingReview(db: Database, task: NonNullable<ReturnType<typeof getTask>>, requestedBy: string | null): number | null {
  const events = listEvents(db, { project: task.project, target: task.id });
  const read = currentReviewFacts(task, events, (a) => actorMayConfigure(db, a, task.project));
  if (read.kind !== "facts") return null;
  const f = read.facts, ev = events.find((e) => e.seq === f.eventSeq);
  if (!ev) return null;
  const review = { seq: f.eventSeq, actor: ev.actor, reviewer: f.reviewer, sessionId: f.reviewerSessionId, family: f.reviewerFamily,
    reportPath: f.reportPath, verdict: f.verdict };
  return reviewRefusal(db, task, events, { review, requestedBy: requestedBy ?? "" }) ? null : f.eventSeq;
}

function nextSteps(c: Pick<MergePmCandidate, "head" | "specRev" | "round" | "reviewSeq" | "reasons"> & { manual: boolean }): string {
  const at = `head ${c.head.slice(0, 12)} / specRev ${c.specRev} / 第 ${c.round} 轮`;
  const steps: string[] = [];
  if (c.reasons.includes("unreviewed")) steps.push(`在当前 ${at} 完成正规跨族审查并登记`);
  if (c.reasons.includes("ui")) steps.push("在当前 head 重拍截图 → PM 核图 / 登记 ui-approve（符合原沿用门时才沿用）");
  const review = c.reviewSeq === null ? "新审查" : `审查 #${c.reviewSeq}`;
  if (c.manual) steps.push(`再提交绑定当前 ${at} / ${review} 的 manual-merge-request`);
  return steps.map((s, i) => `${i + 1}. ${s}`).join("；");
}

type Task = NonNullable<ReturnType<typeof getTask>>;

/**
 * 合并已实际结清、只差 PM 部署收口（MQWAKE2）：这时请求的 head 被正规 carry 换掉不是阻塞，叫 PM 重提请求是误报。只认结构化事实：
 * 本卡当前那条合并意图（manual = 最新请求自己的 mmq 意图，否则最新的合并意图）done，它的运行 merged 且带完整合并提交、合并的 head 就是
 * 卡当前 head，并且来自意图绑定的 head 或本运行由调度身份写的 review_carry 链；规格 / 轮次仍是请求绑定的，merged 发生在卡最后一次换阶段之后。
 * 别的请求 / 旧轮的 merged、裸 done、failed / cancelled / resolved、回执文字都不算；缺或矛盾 → false，照原判定走（预筛、窄 CLI 重核与 MQWATCH1 都经 mergePmCandidate 同源读它）。
 */
function mergedPendingDeploy(db: Database, task: Task, wf: NonNullable<ReturnType<typeof getWorkflow>>, req: ManualRequest | undefined): boolean {
  const intent = req ? intentOf(db, req) : db.query("SELECT * FROM scheduler_intents WHERE taskId = ? AND action = 'merge' ORDER BY createdAt DESC, rowid DESC LIMIT 1")
    .get(task.id) as SchedulerIntent | null;
  const run = intent && getMergeRun(db, intent.id);
  if (!intent || !run || intent.status !== "done" || intent.action !== "merge" || intent.taskId !== task.id || run.taskId !== task.id
    || run.project !== task.project || run.phase !== "merged" || !SHA.test(run.mergeSha ?? "") || run.reviewedHead !== task.headSHA) return false;
  const bound = req ?? { head: intent.head, specRev: intent.specRev, round: task.round };
  if (intent.head !== bound.head || bound.specRev !== task.specRev || wf.specRev !== task.specRev || bound.round !== task.round) return false;
  const events = listEvents(db, { project: task.project, target: task.id });
  const mine = (e: (typeof events)[number], op: string) => e.kind === "scheduler" && e.data.op === op && e.data.intentId === intent.id;
  const merged = events.findLast((e) => mine(e, "merge_phase") && e.data.to === "merged" && e.data.mergeSha === run.mergeSha);
  const staged = events.findLast((e) => e.kind === "stage");
  if (!merged || (staged && staged.seq > merged.seq)) return false;
  // carry 链：从意图绑定的 head 起，每一跳 from = 上一跳 to，最后一跳到合并的 head（carryReview 同时改写 run.reviewedHead）
  let head = bound.head;
  for (const c of events.filter((e) => mine(e, "review_carry") && e.actor === "scheduler" && e.seq < merged.seq)) {
    if (c.data.from !== head) return false;
    head = String(c.data.to);
  }
  return head === run.reviewedHead;
}

/** 收件人：仍合法的 feature PM，否则项目当班 PM；调度助理 / 不在 PM 名单的一律不收 */
export function mergePmTarget(db: Database, taskId: string): string | null {
  const t = getTask(db, taskId), meta = t && getMeta(db, t.project);
  const pm = t && (t.featureId ? featurePm(db, t.featureId) : projectPm(db, t.project));
  return t && meta && pm && meta.pms.includes(pm) && pm !== meta.team?.dispatcher ? pm : null;
}

export function mergePmCandidate(db: Database, taskId: string, now: number, handoff: HandoffPort = configHandoff): MergePmCandidate | null {
  const task = getTask(db, taskId), wf = task && getWorkflow(db, task.id);
  if (!task || !wf || task.kind !== "code" || task.stage !== "merge" || !task.headSHA || handoff(task.project)) return null;
  const open = db.query("SELECT 1 FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown') LIMIT 1").get(task.id);
  const manual = wf.mode === "manual", req = manual ? listRequests(db, task.project, task.id).at(-1) : undefined;
  if (open || mergedPendingDeploy(db, task, wf, req)) return null;
  if (req && (revokeOf(db, req) || requestRefusal(db, req, now, false, handoff)?.kind !== "void")) return null;
  const reviewSeq = standingReview(db, task, req?.requestedBy ?? null);
  const digest = typeof task.extra.screenshotsDigest === "string" ? task.extra.screenshotsDigest : null;
  const ui = wf.template === "ui", uiFails = ui && uiMergeRefusal(db, task, now) !== null;
  // 没有人工请求（或 auto 卡）：只认「截图门不过、代码审查仍正规成立」这一支——审查不成立是作者 / 审查员的事，不叫 PM
  if (!req && !(uiFails && reviewSeq !== null)) return null;
  const reasons = (req ? [
    [uiFails, "ui"], [reviewSeq === null, "unreviewed"], [task.headSHA !== req.head, "head"],
    [task.specRev !== req.specRev || wf.specRev !== task.specRev, "spec"], [task.round !== req.round, "round"],
    [reviewSeq !== null && reviewSeq !== req.review.seq, "review"], [ui && !uiFails && digest !== req.uiDigest, "digest"],
  ] as [boolean, MergePmReason][] : [[true, "ui"]] as [boolean, MergePmReason][]).filter(([on]) => on).map(([, r]) => r);
  if (!reasons.length) return null;
  const base = { taskId: task.id, project: task.project, request: req?.seq ?? null, head: task.headSHA, specRev: task.specRev, round: task.round,
    reviewSeq, digest, reasons };
  const key = createHash("sha256").update(JSON.stringify(base)).digest("hex").slice(0, 16);
  const what = req ? `人工合并请求 #${req.seq} 已失效` : `当前 head 截图门未过、审查 #${reviewSeq} 仍成立`;
  const text = `[合并待处置] ${task.id} ${what}（${reasons.map((r) => REASON_TEXT[r]).join("、")}），` +
    `合并不会自动继续，${ui ? "旧截图 / " : ""}${req ? "旧请求" : "旧验收"}不会自动沿用。下一步：${nextSteps({ ...base, manual })}。阻塞键 ${key}`;
  return { ...base, key, text };
}
