/**
 * merge-arch-UI1 · PM's screenshot approval bound to the full rendered content (PROOF1 merge-content-proof.ts UiContentEvidence, strength
 * full), read back for the merge gate when the older carry layers (UICAR2 uiCarry → UIR1 uiReviewCarry → UICAR3 uiCarryOwnGlobs,
 * scheduler-ui-carry-read.ts) left a gap: e.g. hops carried while uiReviewCarry was observe / off. It only fills the missing content
 * mapping, never writes an approval, a screenshot file or screenshotsDigest, and never revokes what an older layer still carries.
 * The mapping: PM's last verdict approved (same round / specRev / screenshots digest) → the scheduler's own update-branch carries
 * after it (review_carry, each with its paired merge_phase, one net diff, from PM's head to the card's head) → a still-valid passing
 * code review → render inputs (scheduler-ui-review-carry.ts renderInputs) byte-equal at PM's head and the card's head. The render digest
 * comes from an existing UIR1 record bound to this approval (ui_review_carry, or its observe note), else is read on demand with
 * read-only git in the project's repoDir — nothing is backfilled. UICAR3's ui_carry (scope only, uiCarryOwnGlobs) is never content.
 * ownerVisual cards stay the callers' (uiMergeRefusal, uiCarryPlan, manual-recovery-ui check it first): owner asks keep their own head
 * and expiry. Switch `mergeContentUi` (explicit key, unset = observe, unreadable = off): on = the adapter may carry, observe = one
 * recovery_observe note per (approval, head) with the would-carry / refusal and its digests, off = the old chain only.
 * tests/merge-content-ui*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import type { PmUiGate } from "./ledger-ui-approve-verdict.js";
import {
  contentIdOf, isFullContentProof, judgeContentEvidence, renderIdOf, uiContentEvidence, type ContentScope, type ReviewContentEvidence,
  type UiContentEvidence,
} from "./merge-content-proof.js";
import { reviewUnderSpec } from "./merge-content-review-read.js";
import { RECOVERY_POLICY_PATH, readRecoveryFile, recordObserved, type RecoveryMode } from "./recovery-policy.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { currentReviewFacts, type ReviewFacts } from "./scheduler-review.js";
import { gitIn, type GitRead } from "./scheduler-ui-carry-proof.js";

const MERGE_CONTENT_UI = "mergeContentUi";
const SHA = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const MAX_HOPS = 16; // review-main-carry-proof.ts MAX_HOPS

/** The explicit mergeContentUi key only: unset = observe (a project `mode: on` does not act for it); unreadable file = off. */
export function mergeContentUiMode(project: string, path = RECOVERY_POLICY_PATH): RecoveryMode {
  const r = readRecoveryFile(path);
  if (r.status === "corrupt") return "off";
  const cfg = r.status === "ok" && Object.hasOwn(r.data.projects, project) ? r.data.projects[project] : undefined;
  return cfg?.keys?.mergeContentUi ?? "observe";
}

/** Injected reads (tests swap them); absent = the file-backed switch, scheduler.json's repoDir and read-only git there. */
export interface ContentUiPort { mode?: (project: string) => RecoveryMode; repoDir?: (project: string) => string | undefined; git?: (repoDir: string) => GitRead }
let port: ContentUiPort = {};
export function setContentUiPort(next: ContentUiPort | null): void { port = next ?? {}; }
const modeNow = (project: string): RecoveryMode => {
  try { return (port.mode ?? mergeContentUiMode)(project); } catch { return "off"; } // a switch that cannot be read never carries
};
const repoDirOf = (project: string): string | undefined => (port.repoDir ? port.repoDir(project) : readSchedulerConfig().projects[project]?.repoDir);

/** Tree listings of a full SHA never change: one bounded cache per process keeps the gate's repeated reads to one git call each. */
const CACHE_MAX = 64;
const cache = new Map<string, Buffer>();
function cachedGit(repoDir: string): GitRead {
  const read = (port.git ?? gitIn)(repoDir);
  return (...args) => {
    const key = `${repoDir}\0${args.join("\0")}`, hit = cache.get(key);
    if (hit) return hit;
    const out = read(...args); // a throw is never cached
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, out);
    return out;
  };
}

export type ContentUiVerdict =
  | { carry: true; evidence: UiContentEvidence; source: "ui_review_carry" | "git" }
  | { carry: false; reason: string };
const no = (reason: string): ContentUiVerdict => ({ carry: false, reason: reason.slice(0, 300) });
const own = (e: LedgerEvent | undefined, op: string): e is LedgerEvent => e?.kind === "scheduler" && e.actor === "scheduler" && e.data.op === op;

/** owner/repo and number of a GitHub PR URL; null for anything else (merge-content-review.ts reads it the same way). */
function prScope(pr: string | null): { repository: string; pr: number } | null {
  const m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(pr ?? "");
  return m ? { repository: m[1]!, pr: Number(m[2]) } : null;
}

type Hop = { head: string; previousHead: string; mainParent: string };
type Chain = { hops: Hop[]; diffHash: string; mainHead: string };
/**
 * The scheduler's own update-branch carries after PM's approval, linking PM's head to the card's head hop by hop: each a
 * review_carry with its merge_phase right after (carryReview's transaction), this round / specRev, one net diff throughout.
 * A delivery, a PM manual carry or any other head move breaks the link.
 */
function trustedChain(events: readonly LedgerEvent[], task: LedgerTask, pm: PmUiGate & { seq: number; head: string }): Chain | string {
  if (events.some((e) => e.seq > pm.seq && e.kind === "deliver")) return "批准之后有交付（人工 push / 改动）";
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const hops: Hop[] = [];
  let at = pm.head, diffHash: string | null = null, mainHead = "";
  for (const c of events) {
    if (c.seq <= pm.seq || !own(c, "review_carry")) continue;
    const d = c.data, phase = bySeq.get(c.seq + 1);
    if (!own(phase, "merge_phase") || phase.data.carrySeq !== c.seq || phase.data.intentId !== d.intentId) return `沿用 #${c.seq} 缺调度器配对的 merge_phase`;
    if (d.from !== at) return `沿用链在 ${at.slice(0, 12)} 断开`;
    if (d.round !== task.round || d.specRev !== task.specRev) return `沿用 #${c.seq} 的轮次 / 规格与卡不符`;
    if (![d.to, d.mainParent, d.mainHead].every((h) => typeof h === "string" && SHA.test(h)) || typeof d.diffHash !== "string" || !HEX64.test(d.diffHash)) {
      return `沿用 #${c.seq} 证据不完整`;
    }
    if (diffHash !== null && d.diffHash !== diffHash) return "净 diff 在沿用跳之间变了";
    diffHash = d.diffHash; mainHead = String(d.mainHead);
    hops.push({ previousHead: at, head: String(d.to), mainParent: String(d.mainParent) });
    at = String(d.to);
    if (hops.length > MAX_HOPS) return "沿用链超过有限链长";
  }
  if (!hops.length || diffHash === null) return "批准之后没有调度器的更新分支沿用";
  return at === task.headSHA ? { hops, diffHash, mainHead } : "沿用链终点不是卡的当前 head";
}

/** The current code review, passing, written under this spec revision and round: the review half of the content identity. */
function passingReview(db: Database, task: LedgerTask, events: readonly LedgerEvent[]): ReviewFacts | string {
  const read = currentReviewFacts(task, events, (a) => actorMayConfigure(db, a, task.project));
  if (read.kind !== "facts") return `当前 head 没有有效代码审查：${read.kind === "invalid" ? read.reason : "无"}`;
  const f = read.facts, review = events.find((e) => e.seq === f.eventSeq);
  if (f.round !== task.round || !review || !reviewUnderSpec(events, review, task.specRev)) return "代码审查不是本轮 / 本规格下的";
  if (f.verdict === "block" || f.findings.some((x) => x.severity === "P0" || x.severity === "P1")) return "代码审查还有未关的 P0 / P1";
  if (f.verdict === "changes" && !f.findings.some((x) => x.severity === "P2")) return "代码审查结论未通过";
  return f;
}

/**
 * The render-input digest an existing UIR1 record already holds for this very approval and the card's head: the scheduler's
 * ui_review_carry, or UIR1's observe note that would have carried. Each was written only after both trees compared byte-equal.
 */
function recordedRender(events: readonly LedgerEvent[], task: LedgerTask, pm: PmUiGate): { digest: string; count: number | null } | null {
  const hit = events.findLast((e) => {
    const d = e.data, trusted = (e.kind === "scheduler" && e.actor === "scheduler" && d.op === "ui_review_carry") ||
      (e.kind === "note" && e.actor === "scheduler" && d.op === "recovery_observe" && d.mechanism === "uiReviewCarry" && d.carried === true);
    return trusted && e.seq > pm.seq! && d.approvalSeq === pm.seq && d.approvedHead === pm.head && d.to === task.headSHA &&
      d.digest === pm.screenshotsDigest && d.round === task.round && d.specRev === task.specRev &&
      typeof d.renderInputs === "string" && HEX64.test(d.renderInputs);
  });
  if (!hit) return null;
  const count = hit.data.renderCount;
  return { digest: String(hit.data.renderInputs), count: Number.isSafeInteger(count) ? count as number : null };
}

/**
 * Does PM's approval (on an older head) cover the card's head by full rendered content? Pure apart from read-only git when no
 * record holds the render digest. Never throws: any doubt is a refusal with its reason.
 */
export function contentUiVerdict(db: Database, task: LedgerTask, events: readonly LedgerEvent[], pm: PmUiGate): ContentUiVerdict {
  const digest = task.extra.screenshotsDigest, globs = task.extra.fileGlobs ?? [];
  if (pm.state !== "approved" || pm.seq === undefined || !pm.head || !SHA.test(pm.head)) return no("本卡最后一条 PM 截图结论不是 approved");
  if (pm.round !== task.round || pm.specRev !== task.specRev || typeof digest !== "string" || !HEX64.test(digest) || pm.screenshotsDigest !== digest) {
    return no("PM 截图批准没绑在本轮 / 本规格 / 卡上截图摘要");
  }
  if (!task.headSHA || !SHA.test(task.headSHA) || task.headSHA === pm.head) return no("卡的 head 无效或就是批准 head（不需要内容映射）");
  if (!Array.isArray(globs) || globs.some((g) => typeof g !== "string")) return no("卡上 fileGlobs 不是字符串列表");
  const at = prScope(task.pr);
  if (!at) return no("卡的 PR 不是 GitHub PR 链接");
  const approved = { ...pm, seq: pm.seq, head: pm.head };
  const chain = trustedChain(events, task, approved);
  if (typeof chain === "string") return no(chain);
  const facts = passingReview(db, task, events);
  if (typeof facts === "string") return no(facts);
  const scope: ContentScope = { ...at, taskId: task.id, specRev: task.specRev, round: task.round };
  const review: ReviewContentEvidence = Object.freeze({ v: 1, kind: "review", scope, diffHash: chain.diffHash, contentId: contentIdOf(scope, chain.diffHash),
    sourceReviewSeq: facts.eventSeq, approvedHead: pm.head, currentHead: task.headSHA, mainHead: chain.mainHead, chain: chain.hops });
  const recorded = recordedRender(events, task, pm);
  let ui: UiContentEvidence, source: "ui_review_carry" | "git";
  if (recorded) {
    source = "ui_review_carry";
    ui = Object.freeze({ v: 1, kind: "ui", review, strength: "full", renderInputs: recorded.digest, renderCount: recorded.count,
      screenshotsDigest: digest, approvalSeq: pm.seq, renderId: renderIdOf(review.contentId, recorded.digest, digest) });
  } else {
    source = "git";
    let read: GitRead;
    try {
      const dir = repoDirOf(task.project);
      if (!dir) return no("调度配置里没有本项目的 repoDir，渲染输入取不了证");
      read = cachedGit(dir);
    } catch (e) { return no(`调度配置读不了（${(e as Error).message.split("\n")[0]}）`); }
    const built = uiContentEvidence({ review, read, fileGlobs: globs as string[], screenshotsDigest: digest, approvalSeq: pm.seq });
    if ("ok" in built) return no(built.reason);
    ui = built;
  }
  const v = judgeContentEvidence(ui, { scope, currentHead: task.headSHA, reviewLive: (seq) => seq === facts.eventSeq,
    approvalLive: (seq, head) => seq === pm.seq && head === pm.head && pm.state === "approved" });
  if (!v.ok) return no(v.reason);
  return isFullContentProof(v) ? { carry: true, evidence: ui, source } : no("内容证据不是完整渲染证明");
}

/**
 * Only a read inside a writer's transaction while the card has a live scheduler merge run (the run's own steps: carry, inspect,
 * pre-send recheck) takes the note. Every other read of the gate (planner, PM-wait / audit ticks, a query_only connection) stays a
 * read with zero ledger change.
 */
function liveRunWrite(db: Database, taskId: string): boolean {
  try {
    return db.inTransaction && !!db.query("SELECT 1 FROM scheduler_merges WHERE taskId = ? AND phase IN ('ready','updating','await_ci','merging') LIMIT 1").get(taskId);
  } catch { return false; } // no merge table on this connection: nothing to note
}

/** observe: one note per (approval, head) from the gate's writer-side reads (liveRunWrite), naming the approval seq, the digests and why (not) — never an approval, never a state change. */
function observeNote(db: Database, task: LedgerTask, pm: PmUiGate, v: ContentUiVerdict): void {
  const head = String(task.headSHA), ev = v.carry ? v.evidence : null;
  const data = { approvalSeq: pm.seq, approvedHead: pm.head, head, round: task.round, specRev: task.specRev, digest: pm.screenshotsDigest,
    carried: v.carry, ...(ev ? { renderInputs: ev.renderInputs, renderId: ev.renderId, contentId: ev.review.contentId, sourceReviewSeq: ev.review.sourceReviewSeq,
      hops: ev.review.chain.length, source: v.carry ? v.source : null } : { reason: v.carry ? null : v.reason }) };
  const action = v.carry ? `按完整渲染内容沿用截图批准 #${pm.seq} 到 ${head.slice(0, 12)}（渲染输入 ${ev!.renderInputs!.slice(0, 12)} 未变）`
    : `不沿用截图批准 #${pm.seq} 到 ${head.slice(0, 12)}（${v.reason}）`;
  try {
    recordObserved(db, { project: task.project, mechanism: MERGE_CONTENT_UI, target: task.id, actionKey: `merge-content-ui:${pm.seq}:${head}`, action, data }, Date.now());
  } catch (e) { // a read path: a ledger that cannot take the note (read-only, busy) leaves the gate's answer as it was
    console.error(`⚠️ mergeContentUi 观察记录失败（${task.id}）：${(e as Error).message.slice(0, 200)}`);
  }
}

/**
 * The read adapter scheduler-ui-carry-read.ts uiCarriedFrom hands its own answer to. `legacy` (UICAR2 / UIR1 / UICAR3) stands
 * whatever this switch says; only its gap is judged here, and only when PM's approval sits on an older head that the scheduler's
 * carries moved away from. on: the content verdict; observe: noted, still the old answer; off: the old answer, nothing read.
 */
export function contentUiCarried(db: Database, task: LedgerTask, events: readonly LedgerEvent[], pm: PmUiGate, legacy: boolean): boolean {
  if (legacy) return true;
  if (pm.state !== "approved" || pm.seq === undefined || !pm.head || pm.head === task.headSHA) return false;
  if (!events.some((e) => e.seq > pm.seq! && own(e, "review_carry"))) return false; // nothing moved after the approval: nothing to map
  const mode = modeNow(task.project);
  if (mode === "off") return false;
  if (mode === "on") return contentUiVerdict(db, task, events, pm).carry;
  if (liveRunWrite(db, task.id)) observeNote(db, task, pm, contentUiVerdict(db, task, events, pm)); // a pure read judges nothing under observe
  return false;
}

/** The planner's view of PM's approval once full rendered content carried it: the head it now covers, the original binding kept. */
type ContentUiGate = PmUiGate & { approvedHead: string; carriedBy: typeof MERGE_CONTENT_UI };

/**
 * The read adapter ledger-ui-approve-verdict.ts plannerPmUiGate hands the planner snapshot (scheduler-snapshot.ts) through, so the
 * planner (uiMergeBlock / uiPassStep pmBound) reads the same fact the driver's uiCarriedFrom does. on + a full content proof: the
 * approval's seq / round / specRev / digest as written, `head` = the card's head it now covers, `approvedHead` = PM's own head. Any
 * other mode or verdict: PM's approval exactly as written. A pure read: no note, no write. Every other reader (UICAR2 / UIR1 / UICAR3
 * carry plans, ui-approve's carry anchor, uiMergeRefusal) keeps projectPmUiGate's raw approval.
 */
export function contentUiGate(db: Database, task: LedgerTask, events: readonly LedgerEvent[], pm: PmUiGate): PmUiGate {
  if (pm.state !== "approved" || pm.seq === undefined || !pm.head || !task.headSHA || pm.head === task.headSHA) return pm;
  if (!events.some((e) => e.seq > pm.seq! && own(e, "review_carry"))) return pm;
  if (modeNow(task.project) !== "on" || !contentUiVerdict(db, task, events, pm).carry) return pm;
  const view: ContentUiGate = { ...pm, head: task.headSHA, approvedHead: pm.head, carriedBy: MERGE_CONTENT_UI };
  return view;
}
