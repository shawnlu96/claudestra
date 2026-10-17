/**
 * 按去重后的失败事实给下一轮作者自动升档（TIER3c）。只由代码判断：同卡真实退回 fix 满两次，或 CI 连续两次终态失败（事实见
 * task-tier-escalation-events.ts，计数 / 去重 / 授予见 task-tier-escalation-store.ts），下一轮作者在同家族里升一级：
 * Claude 按 Haiku → Sonnet → Opus，Codex 按 CODEX_EFFORT_LEVELS 的既有顺序，不换家族。基础档（task-tier-models.ts 类型解析出的作者档）
 * 不在梯子上 / 是 Codex 自己的配置 = 不可核实：记原因、不覆盖、不猜。超过最高档只记触顶；每家族用过的最高档持久化，配置变了也不回降。
 * 不碰当前会话：值经 TIER3 的作者启动覆盖扩展点（registerAuthorTierOverride）在下一次建作者会话时生效；那次启动绑上会话后
 * 核对启动事实（task-tier-launch-events.ts），实际值证实了才算「已升档」，旧档会话（升档前建的 / 没带新档的）不算。
 * 门控与 TIER3 共用 taskTierModels：off 什么都不做（不读不写，不消费新增证据，已有历史原样留着，重新 on 接着算）；
 * observe 只按本会授予的级记 would-use（库不变）；on 才进库授予并应用。接线（installTaskTierEscalation）由调用方装，本模块不改调度热点。
 * tests/task-tier-escalation.test.ts。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { CODEX_EFFORT_LEVELS } from "./codex-launch.js";
import { getTask, openLedger } from "./ledger-store.js";
import { recordObserved } from "./recovery-policy.js";
import { readRoleModels, type RoleModelRead } from "./role-model-settings.js";
import { ledgerWriter, taskTierLaunchHistory } from "./task-tier-launch-events.js";
import { registerAuthorTierOverride, resolveTierModel, taskTierMode, type AuthorTierOverride } from "./task-tier-models.js";
import { ledgerEscalationFacts, type EscalationFact } from "./task-tier-escalation-events.js";
import { cardState, ingestFacts, latestPlan, listPeaks, openEscalationStore, recordAdoption, recordNote, settlePlan, type Grant } from "./task-tier-escalation-store.js";

type Family = "claude" | "codex";
const CLAUDE_LADDER = ["haiku", "sonnet", "opus"] as const;
const CLAUDE_IDS: Record<(typeof CLAUDE_LADDER)[number], string> = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };
/** 两个本机作者入口（scheduler-local-author.ts、scheduler-local-runtime-start.ts）argv 自带的原档，与 TIER3 的 baseEffort 同一口径 */
const AUTHOR_BASE_EFFORT = "high" as const;

export interface EscalationPort { store: () => Database; ledger: () => Database; read: () => RoleModelRead; now: () => number }
const PRODUCTION: EscalationPort = { store: () => openEscalationStore(), ledger: () => openLedger(), read: () => readRoleModels(), now: Date.now };
let port = PRODUCTION;
/** Tests only: swap the production port (undefined = back to the file backed one). */
export function useEscalationPort(p?: Partial<EscalationPort>): void { port = p ? { ...PRODUCTION, ...p } : PRODUCTION; }

/** 梯子上的位置；-1 = 不可核实 */
function rankOf(family: Family, value: string | null): number {
  if (family === "codex") return CODEX_EFFORT_LEVELS.indexOf(value as (typeof CODEX_EFFORT_LEVELS)[number]);
  const m = /^claude-(haiku|sonnet|opus)-[a-z0-9.-]+$/.exec(value ?? "");
  return m ? CLAUDE_LADDER.indexOf(m[1] as (typeof CLAUDE_LADDER)[number]) : -1;
}
const topOf = (family: Family) => (family === "codex" ? CODEX_EFFORT_LEVELS.length : CLAUDE_LADDER.length) - 1;
const valueAt = (family: Family, rank: number) => family === "codex" ? CODEX_EFFORT_LEVELS[rank] : CLAUDE_IDS[CLAUDE_LADDER[rank]];

export type TickResult = { mode: "off" } | { mode: "observe" | "on"; added: number; grants: Grant[] };

/**
 * 收一张卡的事实：台账里卡自己的 stage 事件 + 调用方给的（ciRunFact 适配过的运行），只收这一卡的。重复 tick / 重放只认新事实。
 * on 下顺带核对实际采用值。off 直接返回（不开库、不记事件）。
 */
export function escalationTick(project: string, card: string, extra: readonly EscalationFact[] = [], p: EscalationPort = port): TickResult {
  const mode = taskTierMode(project).mode;
  if (mode === "off") return { mode };
  const ledger = p.ledger();
  const facts = [...ledgerEscalationFacts(ledger, project, card), ...extra.filter((f) => f.project === project && f.card === card)];
  const r = ingestFacts(p.store(), facts, { now: p.now(), dryRun: mode === "observe" });
  if (mode === "observe") for (const g of r.grants) observe(ledger, g, p.now());
  else reconcileAdoption(project, card, p);
  return { mode, ...r };
}

/** observe：本会授予的这一级记一条 would-use（同一批证据一条）；卡不在台账 / 记不上不挡 */
function observe(ledger: Database, g: Grant, now: number): void {
  if (getTask(ledger, g.card)?.project !== g.project) return;
  const digest = createHash("sha256").update(JSON.stringify(g.evidence)).digest("hex").slice(0, 16);
  try {
    recordObserved(ledgerWriter(ledger), { project: g.project, mechanism: "taskTierModels", target: g.card, actionKey: `task-tier-escalate:${g.n}:${digest}`,
      action: `给 ${g.card} 下一轮作者${g.kind === "up" ? "升一级" : "升档（已在最高档，只记触顶）"}（${g.cause === "fix" ? "退回 fix" : "CI 连红"} 满 2 次）`,
      data: { n: g.n, kind: g.kind, cause: g.cause, evidence: g.evidence } }, now);
  } catch (e) { console.error(`[task-tier] 记 ${g.card} 的升档 would-use 失败：${(e as Error).message}`); }
}

/**
 * 启动覆盖（TIER3 扩展点 1，只在 taskTierModels on 下被调）：先收事实，再按已授予级数算这一家族的作者档。
 * 没升过级、基础档不可核实、算出来不高于基础档 = null（不覆盖，核心照常用基础档）。
 */
export const authorEscalationOverride: AuthorTierOverride = (q) => {
  if (taskTierMode(q.project).mode !== "on") return null;
  escalationTick(q.project, q.card);
  const store = port.store(), now = port.now();
  const steps = cardState(store, q.project, q.card)?.steps ?? 0;
  const peak = listPeaks(store, q.project, q.card).find((x) => x.family === q.family);
  if (!steps && !peak) return null;
  const base = resolveTierModel(port.read(), q.tier, "author", q.family, q.family === "codex" ? AUTHOR_BASE_EFFORT : undefined).value;
  const baseRank = rankOf(q.family, base);
  if (baseRank < 0) {
    recordNote(store, q.project, q.card, `unknown:${q.family}:${base ?? "null"}`, `基础档 ${base ?? "（家族自己的配置）"} 排序不可核实，不推测档位、不覆盖`, now);
    return null;
  }
  const want = baseRank + steps, top = topOf(q.family);
  if (want > top) recordNote(store, q.project, q.card, `topped:${q.family}:${steps}`, `已到最高档 ${valueAt(q.family, top)}，第 ${steps} 级只记触顶`, now);
  const rank = Math.min(want, top);
  const settled = settlePlan(store, { project: q.project, card: q.card, family: q.family, step: steps, value: rank === baseRank ? base! : valueAt(q.family, rank), rank,
    top: rank === top, baseRank, now });
  return settled.rank > baseRank ? settled.value : null;
};

/** 装上 / 撤下启动覆盖；返回撤销函数 */
export function installTaskTierEscalation(): () => void {
  registerAuthorTierOverride(authorEscalationOverride);
  return () => registerAuthorTierOverride(null);
}

/** 最近一级发出的值有没有被一次绑上会话的作者启动用上：来源 override、值相同、在发出之后启动 */
function adoptedLaunch(ledger: Database, project: string, card: string, plan: { family: string; value: string; ts: number }) {
  return taskTierLaunchHistory(ledger, project, card).findLast((f) => f.status === "bound" && f.plan.role === "author" && f.plan.family === plan.family &&
    f.plan.source === "override" && f.createdAt >= plan.ts && (f.plan.family === "claude" ? f.plan.final.model : f.plan.final.effort) === plan.value);
}

function reconcileAdoption(project: string, card: string, p: EscalationPort): void {
  const store = p.store(), plan = latestPlan(store, project, card);
  if (!plan || plan.launchId) return;
  const hit = adoptedLaunch(p.ledger(), project, card, plan);
  if (!hit) return;
  const actual = hit.actual.source === "unknown" ? "unknown" : String((plan.family === "claude" ? hit.actual.model : hit.actual.effort) ?? "unknown");
  recordAdoption(store, { project, card, family: plan.family, step: plan.step, launchId: hit.plan.launchId, sessionId: hit.sessionId ?? "", actual });
}

/**
 * 卡的升档状态（读，不看开关）：applied 只在实际值证实等于发出值时为真；只是带新档 argv 启动、运行时没证实的是 launched，
 * 不宣称已升档；没有启动是 pending。
 */
export function escalationStatus(project: string, card: string, p: EscalationPort = port): {
  steps: number; plan: { family: string; step: number; value: string } | null; state: "none" | "pending" | "launched" | "applied" | "mismatch"; sessionId: string | null;
} {
  const store = p.store(), steps = cardState(store, project, card)?.steps ?? 0, plan = latestPlan(store, project, card);
  if (!plan) return { steps, plan: null, state: "none", sessionId: null };
  const brief = { family: plan.family, step: plan.step, value: plan.value };
  if (!plan.launchId) return { steps, plan: brief, state: "pending", sessionId: null };
  const state = plan.actual === "unknown" ? "launched" : plan.actual === plan.value ? "applied" : "mismatch";
  return { steps, plan: brief, state, sessionId: plan.sessionId };
}

/** 这个作者会话能不能当作已升档的会话：卡升过级时，只有核实采用了最近一级值的那次启动建的会话才算；否则是旧档会话 */
export function isStaleAuthorSession(project: string, card: string, sessionId: string, p: EscalationPort = port): boolean {
  const store = p.store(), plan = latestPlan(store, project, card);
  if (!plan) return false;
  return adoptedLaunch(p.ledger(), project, card, plan)?.sessionId !== sessionId;
}
