/**
 * 自动升档（TIER3c）的失败事实适配：只把能归属到「项目 + 卡号 + 具体那一次」的事实交给升档存储，别的一律不收。
 * - 台账里卡自己的 stage 事件（既有事实入口，按 origin+originSeq / seq 认身份，重放同一条就是同一个事实）：
 *   review / live → fix、合并队列 remote_review 退回 = 真实退回 fix；合并队列 ci_fail 退回 = 那次 Actions 运行终态失败（没有运行链接 = 无归属，不收）；
 *   conflict / update_fail 退回不是作者写坏了，不算；merge → live = 这次头上的必需 CI 过了，算一次成功（清连红）；导入的旧事件不算。
 * - 外部给的 CI 运行（ciRunFact）：只认 completed 的终态；success 清连红，failure / timed_out / startup_failure 算失败；
 *   cancelled / skipped / neutral / 排队 / 进行中等都不算（取消、等待不计入）。
 * 任何事实带 provider 安全拒绝的标记都丢掉：安全拒绝不是升档重试的理由。轮询多少次都只是同一批事实（身份去重在存储里）。
 * tests/task-tier-escalation.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { LedgerEvent } from "./ledger-stages.js";
import { getTask, listEvents } from "./ledger-store.js";

/** fix = 一次真实退回 fix；ci = 一次 CI 运行终态（failure 计连红、success 清连红） */
export interface EscalationFact {
  project: string;
  card: string;
  /** 卡内唯一：同一个事实无论从哪条路、重放几次都是同一个 id */
  id: string;
  kind: "fix" | "ci";
  outcome: "failure" | "success";
  ts: number;
}

const CI_FAILED = ["failure", "timed_out", "startup_failure"];
const REFUSAL_CAUSES = ["provider_refusal", "safety_refusal"];
const RUN_ID = /\/actions\/runs\/(\d+)(?:\/|$)/;
const ok = (s: unknown): s is string => typeof s === "string" && s.trim() !== "" && s.length <= 200;

/** provider 安全拒绝：显式标记才算，不从自由文字里猜 */
export function isSafetyRefusal(data: Record<string, unknown>): boolean {
  return data.providerRefusal === true || REFUSAL_CAUSES.includes(String(data.cause ?? ""));
}

const eventId = (e: LedgerEvent) => e.origin && Number.isSafeInteger(e.originSeq) ? `${e.origin}:${e.originSeq}` : `seq:${e.seq}`;

/** 一条 stage 事件 → 事实；不归属 / 不算的回 null */
function fromStage(e: LedgerEvent): EscalationFact | null {
  const d = e.data;
  if (e.kind !== "stage" || d.imported === true || isSafetyRefusal(d)) return null;
  const base = { project: e.project, card: e.target, ts: e.ts };
  if (d.from === "merge" && d.to === "live") return { ...base, id: `ci-pass:${eventId(e)}`, kind: "ci", outcome: "success" };
  if (d.to !== "fix") return null;
  const bounce = d.mergeBounce as { cause?: unknown; checks?: { link?: unknown }[] } | undefined;
  if (!bounce) return d.from === "review" || d.from === "live" ? { ...base, id: `fix:${eventId(e)}`, kind: "fix", outcome: "failure" } : null;
  if (bounce.cause === "remote_review") return { ...base, id: `fix:${eventId(e)}`, kind: "fix", outcome: "failure" };
  if (bounce.cause !== "ci_fail") return null;
  // 一次退回里几个运行同时红也只是一次 CI 终态失败：按最小的运行 id 认（与 ciRunFact 同一身份）
  const runs = (bounce.checks ?? []).map((c) => RUN_ID.exec(String(c?.link ?? ""))?.[1]).filter(ok).sort((a, b) => Number(a) - Number(b));
  return runs.length ? { ...base, id: `ci:${runs[0]}`, kind: "ci", outcome: "failure" } : null;
}

/** 卡在这本台账里的全部升档事实，按台账顺序；卡不在本台账或项目对不上 = 空 */
export function ledgerEscalationFacts(db: Database, project: string, card: string): EscalationFact[] {
  if (getTask(db, card)?.project !== project) return [];
  return listEvents(db, { project, target: card }).map(fromStage).filter((f): f is EscalationFact => f !== null);
}

export interface CiRunInput {
  project?: unknown; card?: unknown; runId?: unknown; attempt?: unknown; status?: unknown; conclusion?: unknown; ts?: unknown;
  cause?: unknown; providerRefusal?: unknown;
}

/** 一次 Actions 运行（GitHub run 的 status / conclusion 原样）→ 事实；无归属、没到终态、取消等不计入的回 { skip: 原因 } */
export function ciRunFact(r: CiRunInput, now = Date.now()): EscalationFact | { skip: string } {
  if (!ok(r.project) || !ok(r.card)) return { skip: "没有项目 / 卡号归属" };
  const runId = typeof r.runId === "number" ? String(r.runId) : r.runId;
  if (!ok(runId) || !/^\d+$/.test(runId)) return { skip: "没有具体的运行 id" };
  if (isSafetyRefusal(r as Record<string, unknown>)) return { skip: "provider 安全拒绝不作升档理由" };
  if (r.status !== "completed") return { skip: `运行还没到终态（${String(r.status ?? "未知")}）` };
  const attempt = Number.isSafeInteger(r.attempt) && (r.attempt as number) > 0 ? r.attempt as number : 1;
  const base = { project: r.project, card: r.card, kind: "ci" as const, ts: typeof r.ts === "number" ? r.ts : now };
  // 同一运行重跑再红仍是同一次失败（与台账退回同一身份）；重跑转绿是这一 attempt 的成功
  if (r.conclusion === "success") return { ...base, id: `ci-pass:${runId}#${attempt}`, outcome: "success" };
  if (CI_FAILED.includes(String(r.conclusion))) return { ...base, id: `ci:${runId}`, outcome: "failure" };
  return { skip: `结论 ${String(r.conclusion ?? "空")} 不计入` };
}
