/**
 * 看板判「卡住」要的两条卡级事实（team-parity-STUCKVIEW1），总览（ledger-read.ts projectViewSnapshot）与详情（taskDetail）同一函数算：
 * - frozen：卡号在本项目 project-map.json 的 frozenTasks 里（owner 定的远期冻结，project-map-config.ts）。名单每个快照只读一次；
 *   读不到 / 坏文件 = 空名单（projectMapConfig 永不抛），不会把所有卡当冻结。
 * - observationUntil：只给 stage=live 的卡。规格 `## 上线后 PM` 首行「观察期：N 小时」，从**当前这次进 live** 的时刻起算；
 *   规格读不到、没有该节、首行是散文或格式不合法、起点不知道（没有进 live 的事件 / 导入推断的近似时间）都不给，不猜。
 * 两样都没有 = undefined，总览里不发这个字段。tests/ledger-attention-facts.test.ts。
 */
import { currentStageMark } from "./ledger-metrics.js";
import type { LedgerEvent, LedgerTask, Stage } from "./ledger-stages.js";
import { parseObservation, postVerifySection, readPostVerifySpec } from "./post-verify-spec.js";
import { projectMapConfig } from "./project-map-config.js";

const HOUR_MS = 3600_000;

export interface AttentionFacts { frozen?: true; observationUntil?: number }

/** 一个快照里各卡共用的输入：冻结名单只读一次；spec 返回规格卡全文（读不到为 null） */
export interface AttentionCtx {
  frozen: ReadonlySet<string>;
  spec: (taskId: string) => string | null;
}

export function attentionCtx(project: string): AttentionCtx {
  return { frozen: projectMapConfig(project).frozen, spec: (id) => readPostVerifySpec(id)?.text ?? null };
}

/** 当前这次进 live 的时刻：时间线最后一段由哪条事件开出（与 stageTimeline 同一取点）且那段就是 live；近似时间不算 */
function liveSince(own: readonly LedgerEvent[]): number | null {
  const mark = currentStageMark(own);
  if (!mark || mark.data.approxTime === true) return null;
  const stage = mark.kind === "stage" ? mark.data.to : ((mark.data.patch ?? {}) as { stage?: Stage }).stage ?? "spec";
  return stage === "live" ? mark.ts : null;
}

function observationUntil(task: Pick<LedgerTask, "id" | "stage">, own: readonly LedgerEvent[], ctx: AttentionCtx): number | null {
  if (task.stage !== "live") return null;
  const since = liveSince(own);
  if (since === null) return null;
  const o = parseObservation(postVerifySection(ctx.spec(task.id)));
  return o === null || o === "bad" ? null : since + o.hours * HOUR_MS;
}

export function attentionFacts(task: Pick<LedgerTask, "id" | "stage">, own: readonly LedgerEvent[], ctx: AttentionCtx): AttentionFacts | undefined {
  const out: AttentionFacts = {};
  if (ctx.frozen.has(task.id)) out.frozen = true;
  const until = observationUntil(task, own, ctx);
  if (until !== null) out.observationUntil = until;
  return out.frozen || out.observationUntil !== undefined ? out : undefined;
}

/** 有事实才挂 attentionFacts 字段（总览按字段量体积，tests/ledger-read-compact.test.ts） */
export function withAttentionFacts<T extends Pick<LedgerTask, "id" | "stage">>(v: T, own: readonly LedgerEvent[], ctx: AttentionCtx): T & { attentionFacts?: AttentionFacts } {
  const f = attentionFacts(v, own, ctx);
  return f ? { ...v, attentionFacts: f } : v;
}
