/**
 * 子 DAG 全完成仍 active 的 feature：只读列候选、一条命令关单（team-project-FCLOSE1）。
 * 完成判定只认 productBoard 的 complete（PDSTATE1，和网页「已收尾」同一口径），卡阶段现读，不看节点快照。
 * 关单的权限 / 共享台账 / rev CAS / 整页验收全在 setFeature 里，这里一条都不复制；复核放在读事务里，不占 IMMEDIATE 写锁。
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx, WriteResult } from "./ledger-checks.js";
import { getFeature, type Feature } from "./ledger-feature.js";
import { setFeature } from "./ledger-feature-write.js";
import { productBoard } from "./ledger-product-board.js";
import { LedgerError } from "./ledger-store.js";
import { sharedLedgerPlanningReason } from "./shared-ledger-gate.js";
import { requirePageCheck } from "./ui-acceptance.js";

type BoardFeature = ReturnType<typeof productBoard>["features"][number];

interface CloseCounts { total: number; completed: number; deferred: number }
export interface CloseCandidate { id: string; title: string; rev: number; counts: CloseCounts; refusal: string | null; close: string }

const countsOf = (f: BoardFeature): CloseCounts =>
  ({ total: f.counts.total, completed: f.counts.completed, deferred: "deferred" in f.counts ? f.counts.deferred : 0 });

const closable = (f: BoardFeature): boolean => f.status === "active" && f.complete;

/** 关单前能预见的拒绝原文：共享台账规划闸先，整页验收后；都过为 null。真关单时 setFeature 会再判一次 */
function refusalOf(db: Database, f: Feature): string | null {
  const shared = sharedLedgerPlanningReason(f.id);
  if (shared) return shared;
  try {
    requirePageCheck(db, f);
    return null;
  } catch (e) {
    if (e instanceof LedgerError) return e.message;
    throw e;
  }
}

/** status=active 且 complete 的 feature（含没 DAG、卡全完成的），按 id 排序；只读，调用方不用包事务 */
export function featureCloseCandidates(db: Database, project: string, now: number): CloseCandidate[] {
  return db.transaction(() => productBoard(db, project, now).features.filter(closable).flatMap((b) => {
    const f = getFeature(db, b.id);
    if (!f) return [];
    return [{ id: f.id, title: f.title, rev: f.rev, counts: countsOf(b), refusal: refusalOf(db, f), close: `ledger feature-close ${f.id} --rev ${f.rev}` }];
  })).deferred().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 读事务里复核 active + complete，不满足就 conflict（原文带 counts）；通过后交给 setFeature 改 done */
export function closeFeature(db: Database, ctx: WriteCtx, input: { id: string; rev: number; now: number }): WriteResult<Feature> {
  const b = db.transaction(() => {
    const cur = getFeature(db, input.id);
    if (!cur) throw new LedgerError("not_found", `没有 feature ${input.id}`);
    return productBoard(db, cur.project, input.now).features.find((x) => x.id === cur.id) ?? null;
  }).deferred();
  if (!b) throw new LedgerError("not_found", `没有 feature ${input.id}`);
  if (!closable(b)) {
    const c = countsOf(b);
    const why = b.status !== "active" ? `status 是 ${b.status}，只关 active 的` : "子 DAG 还没全完成（completed > 0 且 completed + deferred = total 才算）";
    throw new LedgerError("conflict", `feature ${b.id} 不能关单：${why}；现在 total ${c.total}、completed ${c.completed}、deferred ${c.deferred}`,
      { status: b.status, counts: c });
  }
  return setFeature(db, ctx, { id: b.id, rev: input.rev, patch: { status: "done" } });
}
