/**
 * 观察期核对的证据适配器（agents-PMAUTO1）：代码白名单，只读台账里的结构化事件，不执行规格里的任何命令，也不搜文本日志。
 * 专用适配器优先；其它恢复键用 recovery_observe / recovery_error。错误有则核，不要求预先存在错误来源。
 * 判定四条全满足才算过：窗口内观察记录 > 0、结构化错误 = 0、未清的人工误判 = 0、数据源可读且覆盖整个窗口。
 */
import type { Database } from "bun:sqlite";
import { RECOVERY_KEYS } from "./recovery-policy.js";
import { targetLabel, type ObservationPlan, type ObservationTarget, type PlanEvidence } from "./observation-plan.js";

/** 一类事件的 SQL 条件（只作用于 events 表的 data JSON 与 kind），由代码写死，不接受外部输入。 */
interface EventMatch { where: string; params?: string[] }
export interface EvidenceAdapter {
  /** 观察记录：observe 档「本会怎样」落成的事件 */
  observed: EventMatch;
  /** 结构化错误：该机制自己记下的失败 */
  errors: EventMatch;
  basis: string;
}

/**
 * 首批：只有 dagWriteScrub 两样都齐。observe 时它把「这一版推不出去」写在 DAG 写入事件的 data.dagWriteScrub 上（dag-write-scrub.ts），
 * 调度器代记后续节点两次被拦时记 op=converge_dag_scrub 的 note（review-converge-followup.ts）。
 */
const ADAPTERS: Readonly<Record<string, EvidenceAdapter>> = {
  "recovery:dagWriteScrub": {
    observed: { where: "json_type(data, '$.dagWriteScrub') = 'text'" },
    errors: { where: "kind = 'note' AND json_extract(data, '$.op') = 'converge_dag_scrub'" },
    basis: "观察 = DAG 写入事件的 data.dagWriteScrub；错误 = op converge_dag_scrub",
  },
};

export type AdapterPort = (target: ObservationTarget) => EvidenceAdapter | undefined;
export const evidenceAdapter: AdapterPort = (target) => {
  const dedicated = ADAPTERS[targetLabel(target)];
  if (dedicated) return dedicated;
  if (target.kind !== "recovery" || !(RECOVERY_KEYS as readonly string[]).includes(target.key)) return undefined;
  return {
    observed: { where: "kind = 'note' AND json_extract(data, '$.op') = 'recovery_observe' AND json_extract(data, '$.mechanism') = ?", params: [target.key] },
    errors: { where: "json_extract(data, '$.op') = 'recovery_error' AND json_extract(data, '$.mechanism') = ?", params: [target.key] },
    basis: "通用结构化样本；错误有则核，不要求预先存在错误来源",
  };
};
export const adaptedTargets = (): string[] => [...new Set([...Object.keys(ADAPTERS), ...RECOVERY_KEYS.map((k) => `recovery:${k}`)])].sort();

const seqs = (db: Database, project: string, m: EventMatch, from: number, to: number): number[] =>
  (db.prepare(`SELECT seq FROM events WHERE project = ? AND ts >= ? AND ts <= ? AND (${m.where}) ORDER BY seq`).all(project, from, to, ...(m.params ?? [])) as { seq: number }[]).map((r) => r.seq);

/**
 * 读一条登记窗口 [startAt, dueAt] 的证据。complete = 适配器存在、台账读得出、窗口已走完。台账事件只追加不删改，登记又要求起点不早于
 * 该卡在本台账里的 verified 事件，所以读得出的窗口就是完整的窗口；读不出（库坏、查询失败）一律算不完整。
 */
export function readEvidence(db: Database, plan: ObservationPlan, now: number, adapters: AdapterPort = evidenceAdapter): PlanEvidence {
  const base = { from: plan.startAt, to: plan.dueAt, source: plan.source, misjudged: plan.misjudged.filter((m) => !m.cleared).map((m) => m.record) };
  const a = adapters(plan.target);
  if (!a) return { ...base, records: [], errors: [], complete: false, why: `${targetLabel(plan.target)} 没有证据适配器（没有结构化观察记录或结构化错误来源），不可核` };
  try {
    const records = seqs(db, plan.project, a.observed, plan.startAt, plan.dueAt), errors = seqs(db, plan.project, a.errors, plan.startAt, plan.dueAt);
    if (now < plan.dueAt) return { ...base, records, errors, complete: false, why: "窗口还没走完" };
    return { ...base, records, errors, complete: true };
  } catch (e) {
    return { ...base, records: [], errors: [], complete: false, why: `证据读不出：${(e as Error).message}` };
  }
}

/** 四条口径；返回 null = 全过。 */
export function evidenceVerdict(e: PlanEvidence): { code: string; reason: string } | null {
  if (!e.complete) return { code: "evidence_incomplete", reason: e.why ?? "证据不完整" };
  if (e.errors.length) return { code: "errors", reason: `窗口内有 ${e.errors.length} 条结构化错误（#${e.errors.slice(0, 10).join("、#")}）` };
  if (e.misjudged.length) return { code: "misjudged", reason: `有 ${e.misjudged.length} 条未清的人工误判标记（记录 #${e.misjudged.slice(0, 10).join("、#")}）` };
  if (!e.records.length) return { code: "no_samples", reason: "窗口内一条观察记录都没有" };
  return null;
}

export function evidenceLine(e: PlanEvidence | null): string {
  if (!e) return "未取证";
  const iso = (t: number) => new Date(t).toISOString();
  const head = e.records.slice(0, 10).map((s) => `#${s}`).join("、");
  return `窗口 ${iso(e.from)} – ${iso(e.to)}，来源 ${e.source}，观察记录 ${e.records.length} 条${head ? `（${head}${e.records.length > 10 ? " 等" : ""}）` : ""}，`
    + `结构化错误 ${e.errors.length} 条，未清误判 ${e.misjudged.length} 条`;
}
