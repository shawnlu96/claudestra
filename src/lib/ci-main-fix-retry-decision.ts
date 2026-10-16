/**
 * merge-arch-CIUNREL1 items 2–3 (ledger record of a red CI's recovery layers, and the "wait for main to fix it" registration).
 * Driver side: the serial gate's layers (CIF1 → CIF8 → CIF2, scheduler-merge-ci-rerun.ts / scheduler-merge-ci-behind.ts) note their
 * verdicts on a DecisionTrail; right before the outcome is sent (a rerun / update-branch claim, or the bounce) the trail goes to the
 * ledger once as a receipt that changes nothing in the run. Ledger side (ciDecisionClaim, inside closeMergeRun's transaction through
 * ciBehindClaim): one note op=merge_ci_recovery_decision per task + run + attempt, and, when CIF2 refused only because main never
 * changed the failing test files, one note op=ci_wait_main_fix (ciMainFixRetry not off). The log lines stay as they were.
 * Only the failing test files are checked against the PR's files (no dependency analysis); a timeout only earns a rerun and a
 * main change only an update — neither waives CI: a merge still needs the bound head's CI all green.
 * docs/architecture/ci-main-fix-retry.md; tests/ci-main-fix-retry*.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import type { EventKind } from "./ledger-stages.js";
import { getEventByDedup, getTask } from "./ledger-store.js";
import { recoveryPolicy, type RecoveryKey, type RecoveryMode } from "./recovery-policy.js";
import type { MergePhase, MergeRun } from "./scheduler-merge.js";
import { CI_MAIN_FIX_RETRY_KEY, isPeerPrCard, retriedFiles, retryMode, sameFiles, WAIT_OP } from "./ci-main-fix-retry.js";

export const DECISION_OP = "merge_ci_recovery_decision";
export type Layer = "cif1" | "cif8" | "cif2";
export interface LayerVerdict { layer: Layer; ok: boolean; code: string; why: string }

/** Reason codes, read from the layers' own refusal text (which stays exactly as the log prints it). */
const CODES: readonly (readonly [RegExp, string])[] = [
  [/解析不出/, "log_unparsed"], [/有非超时失败/, "non_timeout"], [/在本 PR 改动里/, "touched_by_pr"], [/没有 Actions run 链接/, "no_run_link"],
  [/分属多个 run/, "multi_run"], [/已重跑过|已经重跑过|重跑没有开始/, "rerun_spent"], [/^读 CI/, "read_failed"], [/回执长度/, "receipt_too_long"],
  [/超过 \d+ 个/, "too_many_files"], [/不落后 main/, "not_behind"], [/main 在 merge-base 之后没改过/, "main_not_changed"],
  [/PR URL 不合法/, "bad_pr_url"], [/不在同一仓库/, "cross_repo"], [/update-branch 失败/, "update_failed"], [/rerun 失败/, "rerun_failed"],
  [/已知偶发/, "not_known_flaky"], [/已合入过 main|合并运行已/, "behind_spent"],
];
const reasonCode = (why: string): string => CODES.find(([re]) => re.test(why))?.[1] ?? "other";

/** One red CI's walk through the layers, for one driver call. `sent`: the ledger already has it from this call. */
export class DecisionTrail {
  run: string | null = null;
  attempt: number | null = null;
  files: string[] | null = null;
  /** main as CIF2 read it when it refused for "main never changed the failing files" */
  mainHead: string | null = null;
  readonly layers: LayerVerdict[] = [];
  sent = false;
  note(layer: Layer, ok: boolean, why: string, code = ok ? "accepted" : reasonCode(why)): void {
    const i = this.layers.findIndex((l) => l.layer === layer);
    const v = { layer, ok, code, why };
    if (i >= 0) this.layers[i] = v;
    else this.layers.push(v);
  }
}

const LEAD = "CI 恢复判定：";
const RECEIPT_MAX = 600;
const RUN_LINK = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/(\d+)$/;
const SHA = /^[a-f0-9]{40}$/i;
const LAYERS: readonly Layer[] = ["cif1", "cif8", "cif2"];
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/u, CONTROL_ALL = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** `n`: how many failing files there were (`f` may be cut to fit; a cut list never registers a wait). */
interface Wire { h: string; r: string; a: number; f: string[]; n: number; m: string | null; l: [Layer, 0 | 1, string, string][] }

/** The trail as one receipt line under the gate, or null (no run read, nothing judged). Whys shrink first, then files are cut. */
export function decisionReceipt(prHead: string, t: DecisionTrail): string | null {
  const files = t.files ?? [];
  // the ledger's receipt gate refuses control / format characters: whys lose them, a file name holding one sends nothing
  if (!t.run || !RUN_LINK.test(t.run) || !t.layers.length || files.some((f) => CONTROL.test(f))) return null;
  const why = (s: string, max: number) => [...s.replace(CONTROL_ALL, " ")].slice(0, max).join("");
  const render = (whyMax: number, kept: string[]): string => LEAD + JSON.stringify({ h: prHead, r: t.run!, a: t.attempt ?? 0, f: kept, n: files.length,
    m: t.mainHead, l: t.layers.map((l) => [l.layer, l.ok ? 1 : 0, l.code, why(l.why, whyMax)]) } satisfies Wire);
  for (const max of [120, 60, 20, 0]) {
    const r = render(max, files);
    if (r.length <= RECEIPT_MAX) return r;
  }
  for (let n = files.length - 1; n >= 0; n--) {
    const r = render(0, files.slice(0, n));
    if (r.length <= RECEIPT_MAX) return r;
  }
  return null;
}

function parseDecisionReceipt(receipt: string): Wire | null {
  if (!receipt.startsWith(LEAD)) return null;
  try {
    const w = JSON.parse(receipt.slice(LEAD.length)) as Wire;
    const str = (v: unknown) => typeof v === "string";
    if (!w || !str(w.h) || !SHA.test(w.h) || !str(w.r) || !RUN_LINK.test(w.r) || !Number.isSafeInteger(w.a) || w.a < 0 || !Number.isSafeInteger(w.n)) return null;
    if (!Array.isArray(w.f) || !w.f.every((f) => str(f) && f) || (w.m !== null && (!str(w.m) || !SHA.test(w.m)))) return null;
    if (!Array.isArray(w.l) || !w.l.length || !w.l.every((x) => Array.isArray(x) && LAYERS.includes(x[0]) && (x[1] === 0 || x[1] === 1) && str(x[2]) && str(x[3]))) return null;
    return w;
  } catch {
    return null;
  }
}

type Step = (to: MergePhase, receipt?: string) => Promise<MergeRun>;

/**
 * Sends the trail once per driver call, before the outcome step, like CIF1's claim query: the ledger side answers null for every
 * such receipt (malformed, drifted, another head, already recorded), so the step never moves the run and never refuses it.
 */
export async function sendDecision(prHead: string, t: DecisionTrail | undefined, step: Step): Promise<void> {
  if (!t || t.sent) return;
  const receipt = decisionReceipt(prHead, t);
  if (!receipt) return;
  t.sent = true;
  await step("resolved", receipt);
}

type WriteEvent = (db: Database, ctx: WriteCtx, e: { project: string; target: string; kind: EventKind; text?: string; data?: Record<string, unknown> },
  primary: boolean) => unknown;
const modeOf = (project: string, key: RecoveryKey): RecoveryMode | "unreadable" => {
  try { return recoveryPolicy(project, key).mode; } catch { return "unreadable"; }
};
const SWITCHES: readonly RecoveryKey[] = ["ciKnownFlaky", "ciLogPerJob"];
const CODE_TEXT: Record<string, string> = { accepted: "接受", main_not_changed: "main 没改过失败文件" };
const verdictText = (l: { layer: string; verdict: string; code: string }): string =>
  `${l.layer} ${l.verdict === "accept" ? "接受" : l.verdict === "reject" ? `拒（${CODE_TEXT[l.code] ?? l.code}）` : "未走到"}`;

/**
 * Ledger side, first thing in ciBehindClaim. undefined = not this receipt. null = recorded (or already there, or the run drifted):
 * the run is never changed. `spent` = the head's rerun / update budgets as the ledger counts them right now.
 */
export function ciDecisionClaim(db: Database, ctx: WriteCtx, row: MergeRun, receipt: string, drift: string | null,
  spentOf: () => { rerun: boolean; behind: boolean }, writeEvent: WriteEvent): null | undefined {
  if (!receipt.startsWith(LEAD)) return undefined;
  const w = parseDecisionReceipt(receipt);
  if (!w || drift || w.h.toLowerCase() !== row.reviewedHead.toLowerCase()) return null;
  const runId = RUN_LINK.exec(w.r)![1]!;
  const dedupKey = `ci-recovery-decision:${row.taskId}:${runId}:${w.a}`;
  if (getEventByDedup(db, dedupKey)) return null;
  const now = ctx.now ?? Date.now();
  const layers = LAYERS.map((layer) => {
    const v = w.l.find((x) => x[0] === layer);
    return v ? { layer, verdict: v[1] ? "accept" : "reject", code: v[2], why: v[3] } : { layer, verdict: "not_reached", code: "not_reached", why: "" };
  });
  const spent = spentOf();
  const switches: Record<string, string> = { ...Object.fromEntries(SWITCHES.map((k) => [k, modeOf(row.project, k)])), [CI_MAIN_FIX_RETRY_KEY]: retryMode(row.project) };
  const cif2 = layers.find((l) => l.layer === "cif2")!;
  writeEvent(db, { actor: ctx.actor, now, dedupKey }, { project: row.project, target: row.taskId, kind: "note",
    text: `合并队列 CI 红的恢复判定（run ${runId} 第 ${w.a} 次）：${layers.map(verdictText).join("，")}`,
    data: { op: DECISION_OP, intentId: row.intentId, task: row.taskId, pr: row.prRef, prHead: row.reviewedHead, run: w.r, attempt: w.a, files: w.f, layers,
      budget: { rerun: spent.rerun ? 0 : 1, behind: spent.behind ? 0 : 1 }, switches,
      scope: "只核对了失败测试文件是否在本 PR 改动里，没做依赖分析；超时只给重跑资格、main 改过只给更新后重试，都不豁免 CI" } }, true);
  if (cif2.verdict === "reject" && cif2.code === "main_not_changed" && w.m && w.f.length && w.f.length === w.n) registerWait(db, ctx, row, w, runId, switches[CI_MAIN_FIX_RETRY_KEY]!, now, writeEvent);
  return null;
}

/** Item 3's registration: off writes nothing (the path as it was); a card + file set already retried once is not registered again. */
function registerWait(db: Database, ctx: WriteCtx, row: MergeRun, w: Wire, runId: string, mode: string, now: number, writeEvent: WriteEvent): void {
  if (mode !== "on" && mode !== "observe") return;
  const files = [...w.f].sort();
  if (retriedFiles(db, row.taskId).some((f) => sameFiles(f, files))) return;
  const dedupKey = `ci-wait-main-fix:${row.taskId}:${row.reviewedHead.toLowerCase()}:${runId}`;
  if (getEventByDedup(db, dedupKey)) return;
  const task = getTask(db, row.taskId);
  writeEvent(db, { actor: ctx.actor, now, dedupKey }, { project: row.project, target: row.taskId, kind: "note",
    text: `等 main 修：失败测试 ${files.join("、")} 不在本 PR 改动里，main（${w.m!.slice(0, 12)}）还没改过它们；main 改过之后调度器重试一次`,
    data: { op: WAIT_OP, task: row.taskId, pr: row.prRef, prHead: row.reviewedHead.toLowerCase(), run: w.r, files, mainHead: w.m!.toLowerCase(),
      peer: !!task && isPeerPrCard(task), mode } }, true);
}
