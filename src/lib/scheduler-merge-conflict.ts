/**
 * Settled merge bounces (i28-M12): a PR that conflicts with main, a PR head whose required CI failed, a refused update-branch
 * (i28-M12b), or a run the PM switched to manual before any merge was sent is a known state, not an unobservable one, so it never
 * freezes the project queue. Bounces send the card back to fix (re-reviewed before it can merge again); the 4th goes to the PM.
 * The receipt is the single place the evidence is spelled out; the ledger re-parses it. tests/scheduler-merge-conflict*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow } from "./ledger-scheduler.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import { canTransition, nextTaskState, type LedgerEvent } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import { insertEvent } from "./ledger-tx.js";
import type { MergeExternal, PrSnapshot } from "./scheduler-merge-driver.js";
import type { MergePhase, MergeRun } from "./scheduler-merge.js";

export type BounceCause = "conflict" | "ci_fail" | "update_fail";
interface FailedCheck { name: string; link: string }
/** `error` (update_fail only): GitHub's refusal, one line, so the fixer sees why main could not be merged in. */
export interface MergeBounce { cause: BounceCause; prHead: string; mainHead: string | null; checks: FailedCheck[]; error?: string }
/** Bounces (conflict + CI failure together) a card gets back to fix automatically; the next one goes to the PM. */
export const MAX_MERGE_BOUNCES = 3;
export const BOUNCE_LIMIT_REASON = "反复冲突，可能和别的卡长期改同一处，需要 PM 排期";
/** No merge has been sent from these phases, so ending the run cannot hide an external merge. */
const BOUNCE_PHASES: readonly MergePhase[] = ["ready", "updating", "await_ci"];

const SHA = /^[a-f0-9]{40}$/i;
const sameSha = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const required = (run: MergeRun): string[] => run.requiredChecks.split(",");

/** The run's own PR, unchanged since review: only then is DIRTY / red CI a fact about the reviewed code. */
function untouched(run: MergeRun, pr: PrSnapshot): boolean {
  return BOUNCE_PHASES.includes(run.phase) && pr.state === "OPEN" && pr.base === "main" && pr.branch === run.expectedBranch &&
    !pr.crossRepository && !pr.draft && sameSha(pr.head, run.reviewedHead);
}

/** Required checks that failed or were cancelled on the reviewed head; other checks keep their old (unknown) handling. */
function failedRequired(run: MergeRun, checks: PrSnapshot["checks"]): FailedCheck[] {
  const names = required(run);
  return checks.filter((c) => names.includes(c.name) && (c.bucket === "fail" || c.bucket === "cancel"))
    .map((c) => ({ name: c.name, link: typeof c.link === "string" && /^https:\/\/\S+$/.test(c.link) ? c.link : "" }));
}

/** Null whenever any condition fails: the caller then keeps its previous answer (unknown / back to review / wait). */
function bounceOf(run: MergeRun, pr: PrSnapshot, only?: BounceCause): BounceCause | null {
  if (!untouched(run, pr)) return null;
  if (pr.mergeState === "DIRTY") return "conflict";
  return only !== "conflict" && failedRequired(run, pr.checks).length ? "ci_fail" : null;
}

const PREFIX = "退回 fix";
/** The ledger's single-line receipt gate; the receipt is fitted under it, the gate is never widened. */
const RECEIPT_MAX = 600;
/** A job link narrowed to its workflow run (`…/actions/runs/<id>`), the part the fixer needs to open the logs. */
const runLink = (link: string): string => link.replace(/^(https:\/\/\S+?\/actions\/runs\/\d+)\/\S*$/, "$1");
const UPDATE_FAIL_TAIL = "；请合入 main 后重新交付";
/** Control / format characters are refused by the ledger's receipt gate, so the error is flattened before it is fitted. */
const oneLine = (text: string): string => text.replace(/[\s\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").trim() || "（无错误信息）";
/** Whole code points up to `max` UTF-16 units (the unit the ledger's length gate counts), so no surrogate pair is split. */
const fitUnits = (text: string, max: number): string => {
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
};
export function bounceReceipt(b: MergeBounce): string {
  const head = `${PREFIX}（${b.cause}）：PR head ${b.prHead}`;
  if (b.cause === "conflict") return `${head}，main head ${b.mainHead}`;
  if (b.cause === "update_fail") {
    const lead = `${head}，更新分支失败：`;
    return `${lead}${fitUnits(oneLine(b.error ?? ""), RECEIPT_MAX - lead.length - UPDATE_FAIL_TAIL.length)}${UPDATE_FAIL_TAIL}`;
  }
  // Required check names are ≤ 80 chars (scheduler-config), so the first one always fits; later ones lose their link
  // before they are dropped, and a name is never cut (the ledger matches it against the required list).
  const fits = (list: FailedCheck[]) => `${head}，失败检查 ${JSON.stringify(list)}`.length <= RECEIPT_MAX;
  const kept: FailedCheck[] = [];
  for (const c of b.checks) {
    const link = runLink(c.link);
    const next = [{ name: c.name, link }, { name: c.name, link: "" }].find((x) => fits([...kept, x]));
    if (!next) break;
    kept.push(next);
  }
  return `${head}，失败检查 ${JSON.stringify(kept)}`;
}
const RECEIPT = /^退回 fix（(conflict|ci_fail)）：PR head ([a-f0-9]{40})，(?:main head ([a-f0-9]{40})|失败检查 (\[.*\]))$/;
const UPDATE_FAIL_RECEIPT = /^退回 fix（update_fail）：PR head ([a-f0-9]{40})，更新分支失败：(.+)；请合入 main 后重新交付$/;
export function parseBounceReceipt(receipt: string): MergeBounce | null {
  const u = UPDATE_FAIL_RECEIPT.exec(receipt);
  if (u) return { cause: "update_fail", prHead: u[1]!, mainHead: null, checks: [], error: u[2]! };
  const m = RECEIPT.exec(receipt);
  if (!m || (m[1] === "conflict") !== !!m[3]) return null;
  if (m[1] === "conflict") return { cause: "conflict", prHead: m[2]!, mainHead: m[3]!, checks: [] };
  try {
    const list = JSON.parse(m[4]!) as unknown;
    if (!Array.isArray(list) || !list.length || list.some((c) => typeof c?.name !== "string" || !c.name || typeof c?.link !== "string")) return null;
    return { cause: "ci_fail", prHead: m[2]!, mainHead: null, checks: list.map((c) => ({ name: c.name, link: c.link })) };
  } catch {
    return null; // Malformed JSON is a refused receipt: closeMergeRun reports it as missing evidence.
  }
}

type Step = (to: MergePhase, receipt?: string) => Promise<MergeRun>;

/** Driver side: journal the bounce when `pr` qualifies; null = not a bounce, the caller continues as before. */
export async function bounceStep(run: MergeRun, pr: PrSnapshot, external: MergeExternal, step: Step, only?: BounceCause): Promise<MergeRun | null> {
  const cause = bounceOf(run, pr, only);
  if (!cause) return null;
  if (cause === "ci_fail") return step("resolved", bounceReceipt({ cause, prHead: pr.head, mainHead: null, checks: failedRequired(run, pr.checks) }));
  const { mainHead } = await external.freshness(run.prRef, pr.head);
  return step("resolved", bounceReceipt({ cause, prHead: pr.head, mainHead, checks: [] }));
}

/**
 * update-branch refused: one re-read, never a wait (i28-M12b, PM 10-02 02:4x). A conflict on the untouched reviewed head bounces as
 * a conflict; anything else (UNKNOWN, BEHIND, CLEAN, a moved head, a failed read) bounces as update_fail on the reviewed head with
 * GitHub's error, so nothing is left in `updating` waiting for an update that is not running. tests/scheduler-merge-mergestate.test.ts.
 */
export async function updateOrBounce(run: MergeRun, external: MergeExternal, step: Step, isStop: (e: unknown) => boolean): Promise<MergeRun> {
  try {
    await external.updateBranch(run.prRef);
    return run;
  } catch (e) {
    if (isStop(e)) throw e;
    let pr: PrSnapshot | null = null;
    try {
      pr = await external.inspect(run.prRef);
    } catch (reread) {
      if (isStop(reread)) throw reread;
      console.error(`⚠️ [merge] ${run.taskId} 更新分支失败后重读出错，按更新失败退回：${(reread as Error).message}`);
    }
    const bounced = pr && await bounceStep(run, pr, external, step, "conflict");
    if (bounced) return bounced;
    return step("resolved", bounceReceipt({ cause: "update_fail", prHead: run.reviewedHead, mainHead: null, checks: [], error: (e as Error).message }));
  }
}

/** PM switched the card to manual while no merge was in flight: advanceMergeRun ends such a run as cancelled whatever was asked. */
export const manualCancel = (db: Database, run: MergeRun): boolean =>
  BOUNCE_PHASES.includes(run.phase) && getWorkflow(db, run.taskId)?.mode === "manual";

const bounceCount = (db: Database, taskId: string): number => (db.query(`SELECT COUNT(*) AS n FROM events WHERE target=? AND kind='scheduler'
  AND json_extract(data,'$.op')='merge_conflict'`).get(taskId) as { n: number }).n;

function endRun(db: Database, ctx: WriteCtx, row: MergeRun, reason: string, intentReceipt: string, now: number): void {
  db.prepare("UPDATE scheduler_merges SET phase='resolved', rev=rev+1, reason=?, updatedAt=? WHERE intentId=?").run(reason, now, row.intentId);
  const intent = getIntent(db, row.intentId);
  if (intent?.status === "submitted") settleIntent(db, { ...ctx, now }, { id: row.intentId, from: "submitted", to: "cancelled", receipt: intentReceipt });
  db.prepare("DELETE FROM scheduler_resources WHERE intentId=?").run(row.intentId);
}

/** The PM's switch to manual ends a run no merge was sent for: intent cancelled, slot freed, task untouched, no freeze (spec 9). */
export function cancelMergeRun(db: Database, ctx: WriteCtx, row: MergeRun, receipt: string): void {
  const now = ctx.now ?? Date.now();
  endRun(db, ctx, row, `cancelled: PM 切手动，未发出 merge（${receipt}）`, `merge cancelled（PM 切手动，未发出 merge）：${receipt.slice(0, 500)}`, now);
  insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:merge:cancelled` }, {
    project: row.project, target: row.taskId, kind: "scheduler", text: `合并队列：PM 切手动，撤销未发出的合并（${receipt}）`,
    data: { op: "merge_phase", intentId: row.intentId, from: row.phase, to: "resolved", outcome: "cancelled", receipt },
  }, true);
}

/**
 * Ledger side of `ready|updating|await_ci → resolved`, inside advanceMergeRun's transaction (phase, rev and edge already checked).
 * A bounce receipt sends the card back to fix; any other receipt is accepted only for a PM's switch to manual.
 * Never writes queueFrozen and never switches the card to manual itself.
 */
export function closeMergeRun(db: Database, ctx: WriteCtx, row: MergeRun, rawReceipt: string | undefined, drift: string | null): void {
  const now = ctx.now ?? Date.now();
  const receipt = rawReceipt?.trim() ?? "";
  if (!receipt || receipt.length > 600 || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(receipt)) throw new LedgerError("invalid", "回执要是单行且不超过 600 字");
  const b = parseBounceReceipt(receipt);
  if (!b) {
    if (!manualCancel(db, row)) throw new LedgerError("conflict", "只有 PM 切手动、且还没发出合并的运行能直接结束；退回 fix 要带冲突 / CI 失败回执");
    return cancelMergeRun(db, ctx, row, receipt);
  }
  if (drift) throw new LedgerError("conflict", `合并运行已失效：${drift}`);
  if (!sameSha(b.prHead, row.reviewedHead) || (b.cause === "conflict" && !SHA.test(b.mainHead ?? "")) ||
    (b.cause === "ci_fail" && b.checks.some((c) => !required(row).includes(c.name)))) {
    throw new LedgerError("invalid", "退回 fix 的回执缺证据，或 head / 检查名与本次合并不符");
  }
  const count = bounceCount(db, row.taskId) + 1;
  const escalated = count > MAX_MERGE_BOUNCES;
  endRun(db, ctx, row, `${b.cause}: ${receipt}`, `merge ${b.cause}：PR head ${b.prHead}${b.mainHead ? `，main head ${b.mainHead}` : ""}`, now);
  const task = mustTask(db, row.taskId);
  if (!escalated) {
    if (task.stage !== "merge" || task.headSHA !== row.reviewedHead || !canTransition(task, "fix", "pm").ok) {
      throw new LedgerError("conflict", "退回 fix 时任务阶段或 head 已变");
    }
    const next = nextTaskState(task, "fix");
    db.prepare("UPDATE tasks SET stage=?, stageBefore=?, round=?, specRev=?, rev=rev+1, updatedAt=? WHERE id=?")
      .run(next.stage, next.stageBefore, next.round, next.specRev, now, task.id);
    insertEvent(db, { actor: ctx.actor, now }, { project: task.project, target: task.id, kind: "stage",
      text: b.cause === "update_fail" ? "更新分支失败，退回 fix 合入 main" : b.cause === "conflict" ? "PR 和 main 冲突，退回 fix 解冲突" : "PR 头 CI 失败，退回 fix",
      data: { from: "merge", to: "fix", round: next.round, specRev: next.specRev, head: task.headSHA, mergeBounce: b } }, false);
  }
  insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:merge:conflict` }, {
    project: row.project, target: row.taskId, kind: "scheduler",
    text: escalated ? `合并队列：第 ${count} 次退回，${BOUNCE_LIMIT_REASON}` : `合并队列：退回 fix（${b.cause}，第 ${count} 次）`,
    data: { op: "merge_conflict", intentId: row.intentId, from: row.phase, cause: b.cause, prHead: b.prHead, mainHead: b.mainHead,
      checks: b.checks, count, escalated },
  }, true);
}

const asBounce = (v: unknown): MergeBounce | null => {
  const b = v as MergeBounce | null;
  return b && (b.cause === "conflict" || b.cause === "ci_fail" || b.cause === "update_fail") && typeof b.prHead === "string" && Array.isArray(b.checks) ? b : null;
};

/** Planner: the bounce that put the card into its current fix stage (that stage event carries it), else null. */
export function fixBounce(events: readonly LedgerEvent[], stage: string): MergeBounce | null {
  const entered = events.findLast((e) => e.kind === "stage" && e.data.to === stage);
  return stage === "fix" && entered?.data.from === "merge" ? asBounce(entered.data.mergeBounce) : null;
}

/** Planner: the current review round re-checks a bounce fix (the stage before the fix→review move was a bounce). */
export function reviewAfterBounce(events: readonly LedgerEvent[]): MergeBounce | null {
  const stages = events.filter((e) => e.kind === "stage");
  const [prev, last] = stages.slice(-2);
  return last?.data.to === "review" && last.data.from === "fix" && prev?.data.to === "fix" && prev.data.from === "merge"
    ? asBounce(prev.data.mergeBounce) : null;
}

/** Planner: the cancelled merge intent ended in the bounce limit (the PM schedules it, not a plain "check external result"). */
export const bounceLimitHit = (events: readonly LedgerEvent[], intentId: string): boolean =>
  events.some((e) => e.kind === "scheduler" && e.data.op === "merge_conflict" && e.data.intentId === intentId && e.data.escalated === true);

/** The work package text for a bounce fix (dispatch message and take_order share it); never reads a review report. */
export function bounceWork(b: MergeBounce): { inputs: string[]; acceptance: string[] } {
  if (b.cause === "update_fail") {
    return {
      inputs: [`更新分支失败：PR head ${b.prHead} 没能自动合入 main（${b.error ?? "无错误信息"}），合并队列已退回`],
      acceptance: ["git fetch 后合入最新 origin/main，有冲突只 git add 冲突文件、两边的改动都保留", "本机 tsc、guard、相关测试通过",
        "推送后报新 head；不读审查报告，这一轮不算 P1 修复"],
    };
  }
  if (b.cause === "conflict") {
    return {
      inputs: [`解冲突：PR head ${b.prHead} 和 main（${b.mainHead ?? "最新"}）冲突，合并队列已退回`],
      acceptance: ["git fetch 后合入最新 origin/main", "只 git add 冲突文件，两边的改动都保留", "本机 tsc、guard、相关测试通过",
        "推送后报新 head；不读审查报告，这一轮不算 P1 修复"],
    };
  }
  const checks = b.checks.map((c) => `${c.name}${c.link ? `（${c.link}）` : ""}`).join("、");
  return {
    inputs: [`PR 头 CI 失败：${checks}，看日志修好后推送`],
    acceptance: ["看 CI 日志定位原因并修好", "本机 tsc、guard、相关测试通过", "推送后报新 head；这一轮不算 P1 修复"],
  };
}

/** The targeted re-review line for the reviewer after a bounce fix. */
export const bounceReviewLine = (b: MergeBounce): string => b.cause === "update_fail"
  ? `定向复验：本轮只因更新分支失败退回过（原 head ${b.prHead.slice(0, 12)}），只看合入 main 的合并提交，不沿用旧审查`
  : b.cause === "conflict"
  ? `定向复验：本轮只因和 main 冲突退回过（原 head ${b.prHead.slice(0, 12)}），只看解冲突的合并提交，不沿用旧审查`
  : `定向复验：本轮只因 PR 头 CI 失败退回过（原 head ${b.prHead.slice(0, 12)}），只看修 CI 的改动，不沿用旧审查`;
