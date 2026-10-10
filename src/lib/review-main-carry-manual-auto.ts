/**
 * MAINP2 auto 沿用的完整证据与权限（审查 r1 policy-drift / missing-chain）：driver 把 canonical 链拼在回执末尾（carryChainSuffix），
 * `ledger scheduler-merge-step` 写事务里 autoCarryEvidence 剥链、核连续 / 上限 / 末跳，并在事务内现读 mainCarry：多跳只在该 repoDir
 * 全部项目 on 时成立，否则 conflict 零写；来源 PASS 由调用方传入的正式审查门（mergeReviewProof：审查员会话 / 家族 / owner 当前豁免 / 池回执）
 * 在同一事务里现核（r2 exempt-drift），seq 与完整链写进 review_carry。来源门按本 run 的真实 intent 选（r6 manual-carry-1）：MQ1
 * manual_merge 的 run 读人工请求绑定的审查（manualRunReviewer），其余读自动池 / 会话；不看调用方声称的来源。热点里只留薄调用。
 * MCRY4：来源门在当前 head 可信链核出的原审查固定 head 上重核（carrySourceTask），多次纯 main 沿用不因新 head 丢池审查员。
 * tests/review-main-carry-manual-auto*.test.ts、tests/review-main-carry-manual-mq1.test.ts。
 */
import type { Database } from "bun:sqlite";
import { getWorkflow, type SchedulerIntent, type TaskWorkflow } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import { MANUAL_MERGE_NODE } from "./manual-merge-queue-facts.js";
import { mainCarryMode } from "./recovery-main-carry-policy.js";
import { carrySourceTask } from "./review-main-carry-auto-source.js";
import { readSchedulerConfig, type SchedulerConfig } from "./scheduler-config.js";
import type { ReviewFacts } from "./scheduler-review.js";

type ProjectSchedule = SchedulerConfig["projects"][string];
export type CarryHop = Readonly<{ head: string; previousHead: string; mainParent: string }>;
export const MAX_AUTO_HOPS = 16;
const SHA = /^[a-f0-9]{40}$/;
const MARK = "｜链 ";

/**
 * How many pure-main hops a carry may span: 16 only when every project on this repoDir has mainCarry on; observe / off /
 * unreadable / unmatched keep the old single hop, so no mode widens merge authority.
 */
export function policyHops(project: ProjectSchedule, config: () => SchedulerConfig = readSchedulerConfig): number {
  try {
    const ids = Object.entries(config().projects).filter(([, p]) => p.repoDir === project.repoDir).map(([id]) => id);
    return ids.length && ids.every((id) => mainCarryMode(id).mode === "on") ? MAX_AUTO_HOPS : 1;
  } catch { return 1; }
}

/** Appended by the driver to its carry receipt: the full chain as one JSON line (the base receipt is unchanged and parsed as before). */
export const carryChainSuffix = (chain: readonly CarryHop[] | undefined): string =>
  chain?.length ? `${MARK}${JSON.stringify(chain.map((h) => [h.previousHead, h.head, h.mainParent]))}` : "";

/** Split a step receipt into the base (checked by the merge step as before) and the raw chain, if any. */
export function carryChainOf(receipt: string | undefined): { base: string; raw: string } | null {
  const at = receipt?.lastIndexOf(MARK) ?? -1;
  return receipt && at > 0 ? { base: receipt.slice(0, at), raw: receipt.slice(at + MARK.length) } : null;
}

function parseChain(raw: string | undefined, oldHead: string, newHead: string, mainParent: string): CarryHop[] {
  const bad = (why: string): never => { throw new LedgerError("conflict", `沿用回执的链不成立：${why}`); };
  if (raw === undefined) return bad("缺完整链");
  let rows: unknown;
  try { rows = JSON.parse(raw); } catch { return bad("不是 JSON"); }
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_AUTO_HOPS) return bad(`要 1..${MAX_AUTO_HOPS} 跳`);
  const chain = rows.map((r) => (Array.isArray(r) && r.length === 3 && r.every((x) => typeof x === "string" && SHA.test(x))
    ? { previousHead: r[0] as string, head: r[1] as string, mainParent: r[2] as string } : bad("每跳要三个完整小写 SHA")));
  let at = oldHead;
  for (const hop of chain) {
    if (hop.previousHead !== at) bad("不连续");
    at = hop.head;
  }
  if (at !== newHead) bad("没走到新 head");
  if (chain.at(-1)!.mainParent !== mainParent) bad("末跳的 main 父提交与回执不一致");
  return chain;
}

/** scheduler-merge.ts mergeReviewProof, passed in (this module may not import it back: no cycle) */
export type ReviewProof = (db: Database, task: LedgerTask, workflow: TaskWorkflow, manual?: { intent: SchedulerIntent; now: number }) => ReviewFacts;
/** The merge run's own intent row (re-read in the step's transaction) and the step's now: which source gate the carried PASS must pass. */
export interface CarrySource { intent: SchedulerIntent | null; now: number }
export interface AutoCarryEvidence { chain: CarryHop[]; hops: number; sourceReviewSeq: number; mainCarry: "on" | "single" }

/**
 * Inside the merge step's write transaction: the chain the proof produced, the policy read now (multi-hop only when every
 * project on the repo is on), and the PASS it carries, re-proved by the formal review gate now (a withdrawn exemption, a
 * swapped reviewer session or a pool receipt gone stale refuses). Any mismatch throws a conflict, so nothing is written.
 * `source`: a manual_merge run proves the PASS its PM request bound (request live, not revoked, same reviewer / family), never the
 * engine pool or a reviewer session it does not have; an auto run keeps the pool / session gate. A missing or foreign intent refuses.
 */
export function autoCarryEvidence(db: Database, task: LedgerTask, ev: { oldHead: string; newHead: string; mainParent: string },
  raw: string | undefined, reviewProof: ReviewProof, hops: (project: string) => number = configuredHops, source?: CarrySource): AutoCarryEvidence {
  const chain = parseChain(raw, ev.oldHead, ev.newHead, ev.mainParent);
  const allowed = hops(task.project);
  if (chain.length > allowed) {
    throw new LedgerError("conflict", `新 head 经 ${chain.length} 次纯 main 合并，写入时 mainCarry 策略不是 on（只认单跳），不沿用`);
  }
  const workflow = getWorkflow(db, task.id);
  if (!workflow) throw new LedgerError("conflict", "沿用时卡没有流程记录，找不到正式来源审查");
  if (source && source.intent?.taskId !== task.id) throw new LedgerError("conflict", "沿用时找不到本 run 的合并意图，无法确定正式来源");
  const manual = source?.intent?.node === MANUAL_MERGE_NODE ? { intent: source.intent, now: source.now } : undefined;
  let facts: ReviewFacts;
  try { facts = reviewProof(db, carrySourceTask(db, task), workflow, manual); } catch (e) {
    throw new LedgerError("conflict", `沿用时正式来源审查门不成立（来源 / 家族 / 豁免已变）：${(e as Error).message}`);
  }
  return { chain, hops: chain.length, sourceReviewSeq: facts.eventSeq, mainCarry: allowed > 1 ? "on" : "single" };
}

function configuredHops(project: string): number {
  try {
    const p = readSchedulerConfig().projects[project];
    return p ? policyHops(p) : 1;
  } catch { return 1; }
}
