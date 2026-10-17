/**
 * 总览 / 已完成分页 / 产品板的收窄读法（agents-LEDGERFAST1）：不再把整个项目的事件逐条读进 JS，耗时跟着要显示的卡涨、不跟着历史涨。
 * - 已完成卡的排序与窗口外计数只要完成时刻和审查计数：来自每卡事实表（ledger-read-fast-memo.ts），只有来了新事件的卡才重读（doneFacts）。
 * - 要显示的卡再走 (project, target, seq) 索引逐卡取全部事件（eventsOf）和步骤（stepsOf）。
 * - 产品板：在跑的卡读全部事件；已结束的卡只用首次进某几个阶段的那几条，同样来自每卡事实表（productEvents）。
 * 输出与逐条读全部事件逐字节相同：tests/ledger-fast-equiv.test.ts 拿旧读法对照。
 */
import type { Database } from "bun:sqlite";
import { blockedBy, type DepView } from "./ledger-deps.js";
import type { DoneFact } from "./ledger-read-done.js";
import { endStages, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import { listSteps, type TaskStep } from "./ledger-steps.js";
import { cardFacts } from "./ledger-read-fast-memo.js";
import { listEvents } from "./ledger-store.js";

/** 已完成卡的窗口 / 分页 / 聚合只要的几样（ledger-read-done.ts doneWindow）：完成时刻和审查计数来自每卡事实表，不读窗口外卡的事件明细 */
export function doneFacts(db: Database, project: string, done: readonly LedgerTask[], deps: readonly DepView[]): DoneFact[] {
  const facts = cardFacts(db, project, done.map((t) => t.id));
  return done.map((t) => {
    const { ends, reviews: r } = facts.get(t.id)!;
    return {
      id: t.id, stage: t.stage, kind: t.kind, itemId: t.itemId, updatedAt: t.updatedAt, blockedBy: blockedBy(t.id, deps).map((d) => d.from),
      metrics: { endTs: endStages(t.kind).map((s) => ends.get(s)).find((ts) => ts !== undefined) ?? null, reviewRounds: r.n, p0: r.p0, p1: r.p1 },
    };
  });
}

/** 这几张卡各自的全部事件（seq 升序），逐卡走 (project, target, seq) 索引 */
export function eventsOf(db: Database, project: string, ids: readonly string[]): Map<string, LedgerEvent[]> {
  return new Map(ids.map((id) => [id, listEvents(db, { project, target: id })]));
}

/** 这几张卡的步骤行（与 stepsByTask 同序：step, round） */
export function stepsOf(db: Database, ids: readonly string[]): Map<string, TaskStep[]> {
  return new Map(ids.map((id) => [id, listSteps(db, id)]));
}

/**
 * 产品板（ledger-product-board*.ts）的事件：full 里的卡（还在跑的、以及卡读不到的节点）给全部事件，照旧算久未动、成员、进当前阶段的时刻；
 * rest 里的卡（已结束的）只给时间线上第一次进 build / verified / done / cancelled 的那几条（吞吐、ETA、完成时刻只 find 这几个阶段的第一段），
 * 它们在前沿里是 completed / deferred 行，久未动、成员不进输出。
 */
export function productEvents(db: Database, project: string, full: readonly string[], rest: readonly string[]): Map<string, LedgerEvent[]> {
  const out = new Map<string, LedgerEvent[]>();
  for (const [id, { marks }] of cardFacts(db, project, rest)) if (marks.length) out.set(id, [...marks]);
  for (const [id, events] of eventsOf(db, project, full)) if (events.length) out.set(id, events);
  return out;
}
