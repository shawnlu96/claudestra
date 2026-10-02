/**
 * 自动开卡（i28-A1）台账侧的 claim / settle 与开关：每个导出函数一个事务。
 * - claim：重核台账里的全部门（scheduler-autostart.ts ledgerGate，选候选后状态变了这里拒），全过才在 feature 上写 `autostart_claim`；
 *   dedupKey `autostart:<feature>:<节点>:<arm>` 由库的 UNIQUE 兜底，同一 arm 再来返回 duplicate。卡号、agent、分支、PM 都在这里按规则算，
 *   不收调用方给的值——它们就是之后 step 写进卡的字段。
 * - settle：done（节点已绑）/ failed / unknown，dedupKey `autostart-settle:<claim>`，结了就不再授权任何写。
 * - 开关：meta 的项目级 key `autostart`，项目 PM / master / owner 可改，每次改记一条审计事件。
 */
import { autostartPlacementGate } from "./scheduler-slot-hold-autostart.js";
import type { Database } from "bun:sqlite";
import { claimDedup, claimOwnsCard, claimSettled, getClaim, settleDedup, type AutostartClaim } from "./ledger-autostart-grant.js";
import type { WriteCtx } from "./ledger-checks.js";
import { cardNames } from "./ledger-card-names.js";
import { getFeature, type Feature } from "./ledger-feature.js";
import { actorMayConfigure, textOneLine } from "./ledger-scheduler-settle.js";
import { getEventByDedup, getItem, LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { checkCodexLine, codexLineOf } from "./quota-codex-line.js";
import {
  currentViews, ledgerGate, projectPm, readSwitch, TEMPLATE_VERSION, type AutostartSwitch, type AutostartTemplate, type ServiceFacts,
} from "./scheduler-autostart.js";

function mustFeature(db: Database, id: string): Feature {
  const f = getFeature(db, id);
  if (!f) throw new LedgerError("not_found", `没有 feature ${id}`);
  return f;
}

const requireScheduler = (ctx: WriteCtx, what: string): void => {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", `${what}只有调度服务能做`);
};

/** ownerVisual: the spec head says「owner 看截图：是」; the card is born with extra.ownerVisual (scheduler-ui-gate.ts) */
export interface ClaimInput {
  featureId: string; key: string; arm: string; template: AutostartTemplate | null; svc: ServiceFacts;
  ownerVisual?: boolean; peer?: AutostartClaim["peer"]; expectedPm?: string;
}

export function claimNode(db: Database, ctx: WriteCtx, input: ClaimInput): { claim: AutostartClaim; duplicate: boolean } {
  return tx(db, () => {
    requireScheduler(ctx, "自动开卡的 claim ");
    if (!/^[a-f0-9]{16}$/.test(input.arm)) throw new LedgerError("invalid", "arm 要是 16 位十六进制");
    const f = mustFeature(db, input.featureId);
    const prior = getEventByDedup(db, claimDedup(f.id, input.key, input.arm));
    if (prior) return { claim: getClaim(db, prior.seq) as AutostartClaim, duplicate: true };
    const pm = projectPm(db, f.project);
    // Async preflight may outlive a PM reassignment. Reject before recording the arm so the next tick can retry.
    if (input.expectedPm !== undefined && input.expectedPm !== pm) throw new LedgerError("conflict", "项目 PM 在预检后变了，下轮重新预检");
    const blocked = ledgerGate(db, f, input.key, input.svc);
    if (blocked) throw new LedgerError("conflict", `${input.key} 现在不能自动开卡（${blocked.gate}）：${blocked.why}`);
    const placementWhy = autostartPlacementGate(db, f.project, input.svc.maxWorkers(f.project), input.peer,
      input.svc.pool?.(f.project), input.svc.now?.());
    if (placementWhy) throw new LedgerError("conflict", placementWhy);
    const node = currentViews(db, f).find((n) => n.key === input.key);
    const names = cardNames(db, f, input.key);
    const version = input.template ? TEMPLATE_VERSION[input.template] : null;
    const data = {
      op: "autostart_claim", key: input.key, taskId: names.taskId, agent: names.agent, pm, branch: names.branch,
      item: getItem(db, f.project, names.slug) ? names.slug : null, title: node?.oneLine ?? input.key, template: input.template, version, arm: input.arm,
      ...(input.peer ? { peer: input.peer } : {}),
      ...(input.ownerVisual ? { ownerVisual: true } : {}),
    };
    const event = insertEvent(db, { ...ctx, dedupKey: claimDedup(f.id, input.key, input.arm) },
      { project: f.project, target: f.id, kind: "feature", text: `自动开卡：${input.key} → ${names.taskId}`, data }, true);
    return { claim: getClaim(db, event.seq) as AutostartClaim, duplicate: false };
  });
}

export const SETTLE_OUTCOMES = ["done", "failed", "unknown"] as const;
export type SettleOutcome = (typeof SETTLE_OUTCOMES)[number];

export interface SettleInput {
  claim: number;
  outcome: SettleOutcome;
  code?: string;
  failedStep?: string;
  rolledBack?: string[];
  leftovers?: string[];
  text?: string;
}

/** 节点现在绑的卡（当前版本）；没绑为 null */
const boundTo = (db: Database, c: AutostartClaim): string | null =>
  currentViews(db, mustFeature(db, c.featureId)).find((n) => n.key === c.key)?.taskId ?? null;

export function settleClaim(db: Database, ctx: WriteCtx, input: SettleInput): { claim: AutostartClaim; duplicate: boolean; boundTo: string | null } {
  return tx(db, () => {
    requireScheduler(ctx, "结清自动开卡的 claim ");
    const c = getClaim(db, input.claim);
    if (!c) throw new LedgerError("not_found", `没有 claim ${input.claim}`);
    if (!SETTLE_OUTCOMES.includes(input.outcome)) throw new LedgerError("invalid", "--outcome 只能是 done / failed / unknown");
    const bound = boundTo(db, c);
    const prior = getEventByDedup(db, settleDedup(c.seq));
    if (prior) {
      if (prior.data.outcome !== input.outcome) throw new LedgerError("conflict", `claim ${c.seq} 已结为 ${String(prior.data.outcome)}`);
      return { claim: c, duplicate: true, boundTo: bound };
    }
    // done = 节点绑上了（通常是本 claim 的卡；preflight 回 already 时是别人先开的那张）；没绑说 done 就是假的
    if (input.outcome === "done" && !bound) throw new LedgerError("conflict", `节点 ${c.key} 还没绑卡，不能结为 done`);
    if (input.outcome !== "done" && bound && claimOwnsCard(db, c, bound)) throw new LedgerError("conflict", `节点 ${c.key} 已绑本次建的 ${bound}，只能结为 done`);
    const line = (v: string | undefined, what: string) => (v === undefined ? undefined : textOneLine(v, what, 600));
    const data = {
      op: "autostart_settle", claim: c.seq, key: c.key, taskId: c.taskId, outcome: input.outcome, boundTo: bound,
      ...(input.code ? { code: line(input.code, "失败代码") } : {}), ...(input.failedStep ? { failedStep: line(input.failedStep, "失败的一步") } : {}),
      ...(input.rolledBack ? { rolledBack: input.rolledBack.slice(0, 20) } : {}), ...(input.leftovers ? { leftovers: input.leftovers.slice(0, 20).map((s) => s.slice(0, 500)) } : {}),
    };
    insertEvent(db, { ...ctx, dedupKey: settleDedup(c.seq) },
      { project: c.project, target: c.featureId, kind: "feature", text: input.text?.slice(0, 600) ?? `自动开卡 ${c.taskId}：${input.outcome}`, data }, true);
    return { claim: c, duplicate: false, boundTo: bound };
  });
}

/** claim 还活着（没结）；step 与结清都先过这一道 */
export function liveClaim(db: Database, seq: number): AutostartClaim {
  const c = getClaim(db, seq);
  if (!c) throw new LedgerError("not_found", `没有 claim ${seq}`);
  if (claimSettled(db, seq)) throw new LedgerError("forbidden", `claim ${seq} 已结清，不再授权任何写`);
  return c;
}

export interface SwitchInput { project: string; on: boolean; featureId?: string; line?: number; codexLine?: number; reason: string }

/** `ledger autostart-set`：关项目 = 不开卡也不交回；关 feature 只影响它的节点和它们绑的卡；--line 改 Claude 周额度线，--codex-line 改 Codex 周额度线 */
export function setAutostartSwitch(db: Database, ctx: WriteCtx, input: SwitchInput): AutostartSwitch {
  return tx(db, () => {
    if (!actorMayConfigure(db, ctx.actor, input.project)) throw new LedgerError("forbidden", `只有项目 ${input.project} 的 PM / master / owner 能改自动开卡开关`);
    const reason = textOneLine(input.reason, "原因", 600);
    if (input.line !== undefined && (!Number.isInteger(input.line) || input.line < 50 || input.line > 100)) throw new LedgerError("invalid", "--line 要是 50–100 的整数");
    checkCodexLine(input.codexLine);
    if (input.featureId && mustFeature(db, input.featureId).project !== input.project) throw new LedgerError("invalid", `feature ${input.featureId} 不在项目 ${input.project}`);
    const now = ctx.now ?? Date.now();
    const stamp = { reason, by: ctx.actor, at: now };
    const cur = readSwitch(db, input.project);
    const next: AutostartSwitch = { ...cur, ...(input.line !== undefined ? { weeklyLinePct: input.line } : {}),
      ...(input.codexLine !== undefined ? { codexWeeklyLinePct: input.codexLine } : {}) };
    if (input.featureId) next.features = { ...cur.features, [input.featureId]: { off: !input.on, ...stamp } };
    else if (input.on) delete next.off;
    else next.off = stamp;
    db.prepare("INSERT INTO meta (project, key, value) VALUES (?, 'autostart', ?) ON CONFLICT (project, key) DO UPDATE SET value = excluded.value")
      .run(input.project, JSON.stringify(next));
    insertEvent(db, { ...ctx, now }, {
      project: input.project, target: "", kind: "meta", text: `自动开卡${input.on ? "开" : "关"}${input.featureId ? `（feature ${input.featureId}）` : ""}：${reason}`,
      data: { op: "autostart", on: input.on, featureId: input.featureId ?? null, line: input.line ?? null,
        codexLine: input.codexLine === undefined ? null : { from: codexLineOf(cur), to: input.codexLine }, value: next },
    }, true);
    return next;
  });
}
