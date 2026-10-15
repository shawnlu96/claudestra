/**
 * manual 卡跨家族审查通过后调度器代排人工合并（merge-arch-MANAUTOQ1）的只读判定：调度 tick 的预筛与台账 writer 的事务重核用同一个 manualMergeReadiness。
 * 只认 manual、code 类、停在 review 的卡，且全部成立：本轮准确当前 head 的结构化审查按 RVWAKE1 的来源证明成立（scheduler-review-pm-wait.ts
 * sourceHolds，含 lend-offer 池回执）、verdict=pass、无 P0/P1、按 scheduler 作请求人过 reviewRefusal、没有新审查在跑；审查人家族严格不同于作者家族
 * （不认 MANEX1 同族豁免）；没有 standing hold / 安全留证，入 manual 事件不是 hold、不带 sticky 码；没有活的人工合并请求、同绑定没被撤销过；
 * 没有未结意图 / 未答 ask，feature 没暂停、队列没冻结、前置已完成；manualMergeQueue 是 on；ui 卡摘要取已登记的 screenshotsDigest 且 uiMergeRefusal
 * 为 null（ownerVisual 卡要有效 owner 批准，调度器不自己批）；peer PR 卡（PR<数字> 或 extra.peerPr）首版不碰，归 PEERHEAD1。
 * 指纹 = taskId、task rev、workflow rev、head、specRev、round、review seq、UI 摘要（无则空）。开关：恢复键 manualMergeAuto（缺省 observe）。
 * 写入见 scheduler-manual-merge-ledger.ts，调度侧见 scheduler-manual-merge-tick.ts；tests/scheduler-manual-merge-auto*.test.ts。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { blockedBy, depViews } from "./ledger-deps.js";
import { getFeature } from "./ledger-feature.js";
import { getWorkflow, type AuthorFamily } from "./ledger-scheduler.js";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import { getMeta, getTask, listDeps, listEvents, listTasks } from "./ledger-store.js";
import { configHandoff, intentOf, listRequests, manualQueueMode, revokeOf, reviewRefusal, type HandoffPort } from "./manual-merge-queue-facts.js";
import { manualEntry, type ManualReasonCode } from "./manual-reason.js";
import { standingHold } from "./pm-handback.js";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { reviewRunning, sourceHolds } from "./scheduler-review-pm-wait.js";
import { openSafetyHold } from "./scheduler-review-swap.js";
import { uiMergeRefusal } from "./scheduler-ui-merge-refusal.js";

export const MANUAL_MERGE_AUTO_KEY = "manualMergeAuto";
/** 只由人解除的入 manual 理由码：与 manual-recovery-facts.ts 的 STICKY_CODES 同一份清单 */
const STICKY_MANUAL_CODES: readonly ManualReasonCode[] = ["safety_refusal", "owner_hold", "pm_hold", "pm_takeover", "foreign_repo"];
const PEER_PR_ID = /^PR\d+$/;
/** observe 样本的 actionKey：每个指纹一条（writer 记、tick 预筛查同一个键） */
export const observeActionKey = (fingerprint: string): string => `request:${fingerprint}`;

/** 恢复键 manualMergeAuto 的生效模式；读不了按 off（recoveryPolicy 本身不抛，坏文件答 off） */
export function manualMergeAutoMode(project: string, policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  try {
    return policy(project, MANUAL_MERGE_AUTO_KEY).mode;
  } catch {
    return "off";
  }
}

export interface ManualMergeCandidate {
  taskId: string; project: string; taskRev: number; workflowRev: number; head: string; specRev: number; round: number; reviewSeq: number;
  uiDigest: string | null; reviewerFamily: AuthorFamily; authorFamily: AuthorFamily; fingerprint: string;
}
export type Readiness = ManualMergeCandidate | { why: string };

export interface ReadyPorts { handoff?: HandoffPort; queuePolicy?: RecoveryPolicyPort }

const fingerprintOf = (c: Omit<ManualMergeCandidate, "fingerprint" | "project" | "reviewerFamily" | "authorFamily">): string =>
  createHash("sha256").update(JSON.stringify([c.taskId, c.taskRev, c.workflowRev, c.head, c.specRev, c.round, c.reviewSeq, c.uiDigest ?? ""])).digest("hex");

/** 只读：此刻能不能由调度器代排；不能时给出第一条拒因（测试与回执用） */
export function manualMergeReadiness(db: Database, taskId: string, now: number, ports: ReadyPorts = {}): Readiness {
  const task = getTask(db, taskId), wf = task && getWorkflow(db, task.id);
  if (!task || !wf) return { why: "卡或流程不存在" };
  if (wf.mode !== "manual" || task.kind !== "code" || task.stage !== "review" || !task.headSHA) return { why: "不是停在 review 的 manual code 卡" };
  if (wf.specRev !== task.specRev) return { why: "流程与规格版本不一致" };
  if (PEER_PR_ID.test(task.id) || task.extra.peerPr) return { why: "peer PR 卡首版不代排（归 PEERHEAD1）" };
  if ((ports.handoff ?? configHandoff)(task.project)) return { why: "仓库方交接项目" };
  if (manualQueueMode(task.project, ports.queuePolicy) !== "on") return { why: "manualMergeQueue 不是 on" };
  const events = listEvents(db, { project: task.project, target: task.id });

  const read = currentReviewFacts(task, events, (a) => actorMayConfigure(db, a, task.project));
  if (read.kind !== "facts" || read.facts.head !== task.headSHA) return { why: "本轮当前 head 没有结构化审查" };
  const f = read.facts, ev = events.find((e) => e.seq === f.eventSeq);
  if (!ev || !sourceHolds(db, task, wf, ev, f)) return { why: "审查来源证明不成立" };
  if (f.verdict !== "pass" || f.findings.some((x) => x.severity === "P0" || x.severity === "P1")) return { why: "审查不是 pass 或有 P0 / P1" };
  const binding = { seq: ev.seq, actor: ev.actor, reviewer: f.reviewer, sessionId: f.reviewerSessionId, family: f.reviewerFamily,
    reportPath: f.reportPath, verdict: f.verdict };
  const refused = reviewRefusal(db, task, events, { review: binding, requestedBy: "scheduler" });
  if (refused) return { why: refused };
  if (reviewRunning(db, task.id, events, f.eventSeq)) return { why: "有新审查在跑" };
  // 自动路径不认 MANEX1 同族豁免：审查人家族要和登记的作者家族、远端 head 家族都不同
  const authorFamily = wf.authorFamily, remote = remoteHeadFamily(db, task);
  if (!authorFamily || !f.reviewerFamily || f.reviewerFamily === authorFamily || (remote && f.reviewerFamily === remote)) return { why: "同家族审查（含 MANEX1 豁免）只走提醒" };

  if (standingHold(events)) return { why: "卡被明确留在人工" };
  if (openSafetyHold(events)) return { why: "安全留证未处置" };
  const entry = manualEntry(events);
  if (!entry?.code) return { why: "找不到带理由码的入 manual 事件" };
  if (entry.event.data.hold !== undefined || STICKY_MANUAL_CODES.includes(entry.code)) return { why: `入 manual 是 hold / ${entry.code}，只由人解除` };

  const requests = listRequests(db, task.project, task.id);
  if (requests.some((r) => !intentOf(db, r) && !revokeOf(db, r))) return { why: "已有活的人工合并请求" };
  if (requests.some((r) => r.head === task.headSHA && r.specRev === task.specRev && r.round === task.round && r.review.seq === f.eventSeq && revokeOf(db, r))) {
    return { why: "同绑定的请求被撤销过（显式停止）" };
  }
  if (db.query("SELECT 1 FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown') LIMIT 1").get(task.id)) return { why: "有未结调度意图" };
  if (db.query("SELECT 1 FROM asks WHERE taskId = ? AND state = 'open' LIMIT 1").get(task.id)) return { why: "有未答的 ask" };
  if (task.featureId && getFeature(db, task.featureId)?.status === "paused") return { why: "feature 已暂停" };
  if (getMeta(db, task.project).queueFrozen.frozen) return { why: "项目合并队列冻结" };
  if (blockedBy(task.id, depViews(listDeps(db, task.project), listTasks(db, task.project))).length) return { why: "前置未完成" };

  let uiDigest: string | null = null;
  if (wf.template === "ui") {
    const d = task.extra.screenshotsDigest;
    if (typeof d !== "string") return { why: "ui 卡没有登记截图摘要" };
    const ui = uiMergeRefusal(db, task, now); // ownerVisual 卡：没有有效 owner 批准 / 合法沿用就不成立，调度器不自己批
    if (ui) return { why: `UI 验收：${ui}` };
    uiDigest = d;
  }
  const base = { taskId: task.id, taskRev: task.rev, workflowRev: wf.rev, head: task.headSHA, specRev: task.specRev, round: task.round, reviewSeq: f.eventSeq, uiDigest };
  return { ...base, project: task.project, reviewerFamily: f.reviewerFamily, authorFamily, fingerprint: fingerprintOf(base) };
}

export function manualMergeCandidate(db: Database, taskId: string, now: number, ports: ReadyPorts = {}): ManualMergeCandidate | null {
  const r = manualMergeReadiness(db, taskId, now, ports);
  return "why" in r ? null : r;
}
