/**
 * MAINP2 auto 沿用的完整证据与权限（审查 r1 policy-drift / missing-chain）：driver 把 canonical 链拼在回执末尾（withCarryChain），
 * `ledger scheduler-merge-step` 写事务里 autoCarryEvidence 剥链、核连续 / 上限 / 末跳，并在事务内现读 mainCarry：多跳只在该 repoDir
 * 全部项目 on 时成立，否则 conflict 零写；同时记下来源 PASS seq 与完整链写进 review_carry。热点里只留薄调用。tests/review-main-carry-manual-auto*.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { LedgerError, listEvents } from "./ledger-store.js";
import { mainCarryMode } from "./recovery-main-carry-policy.js";
import { readSchedulerConfig, type SchedulerConfig } from "./scheduler-config.js";
import { currentReviewFacts } from "./scheduler-review.js";

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

/** The driver's receipt with the full chain appended as one JSON line (the base receipt is unchanged and parsed as before). */
export const withCarryChain = (receipt: string, chain: readonly CarryHop[] | undefined): string =>
  chain?.length ? `${receipt}${MARK}${JSON.stringify(chain.map((h) => [h.previousHead, h.head, h.mainParent]))}` : receipt;

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

export interface AutoCarryEvidence { chain: CarryHop[]; hops: number; sourceReviewSeq: number; mainCarry: "on" | "single" }

/**
 * Inside the merge step's write transaction: the chain the proof produced, the policy read now (multi-hop only when every
 * project on the repo is on), and the PASS it carries. Any mismatch throws a conflict, so nothing is written.
 */
export function autoCarryEvidence(db: Database, task: LedgerTask, ev: { oldHead: string; newHead: string; mainParent: string },
  raw: string | undefined, hops: (project: string) => number = configuredHops): AutoCarryEvidence {
  const chain = parseChain(raw, ev.oldHead, ev.newHead, ev.mainParent);
  const allowed = hops(task.project);
  if (chain.length > allowed) {
    throw new LedgerError("conflict", `新 head 经 ${chain.length} 次纯 main 合并，写入时 mainCarry 策略不是 on（只认单跳），不沿用`);
  }
  const read = currentReviewFacts(task, listEvents(db, { project: task.project, target: task.id }));
  if (read.kind !== "facts") throw new LedgerError("conflict", "沿用时找不到本轮审查结论");
  return { chain, hops: chain.length, sourceReviewSeq: read.facts.eventSeq, mainCarry: allowed > 1 ? "on" : "single" };
}

function configuredHops(project: string): number {
  try {
    const p = readSchedulerConfig().projects[project];
    return p ? policyHops(p) : 1;
  } catch { return 1; }
}
