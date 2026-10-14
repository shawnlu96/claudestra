/**
 * AUDTRAIN4：PM 在仓库外 / 私仓手动合入、卡仍留 merge 等部署时的结构化合入事实（`ledger manual-merge-record`）。
 * 这是对已经发生的外部合并的登记：不执行合并、不查网络、不推阶段，不碰 head / 工作流 / 意图 / 资源 / 文件锁，只写一条
 * kind=scheduler、data.op=manual_merge_record（v1）的事件。project / specRev / round / mergeEntrySeq 都在同一个 immediate 事务里从库里读，
 * 不收调用者自报；按「任务 + 本次进入 merge 的 seq + head」去重（dedupKey），同证据重放返回原事件，身份字段不同 = 冲突拒绝。
 * 巡检（ledger-audit-train-facts.ts）用 validManualMerge 认它，两边同一份口径。tests/ledger-audit-train-manual-merged*.test.ts。
 */
import type { Database } from "bun:sqlite";
import { prCoordinates } from "./card-repo.js";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { actorMayConfigure, textOneLine } from "./ledger-scheduler-settle.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { SHA } from "./manual-merge-queue-facts.js";

export const MANUAL_MERGE_RECORD_OP = "manual_merge_record";
const BASE = "main";

export interface ManualMergeInput { taskId: string; head: string; mergeSha: string; pr: string; base: string; mainHead: string; receipt: string }
export interface ManualMergeFact {
  op: typeof MANUAL_MERGE_RECORD_OP; v: 1; phase: "merged"; head: string; mergeSha: string; pr: string; base: typeof BASE; mainHead: string;
  specRev: number; round: number; mergeEntrySeq: number; receipt: string;
}
/** 判定要对上的卡当前身份（巡检与登记各自从库里读） */
export interface MergeIdentity { headSHA: string | null; pr: string | null; specRev: number; round: number; entrySeq: number }

/** 本卡最近一次进入 merge 的 stage 事件 seq（同 scheduler-merge-handoff.ts mergeEntry 的口径）；没进过 = 0 */
export const mergeEntrySeq = (db: Database, taskId: string): number =>
  (db.query(`SELECT MAX(seq) AS seq FROM events WHERE target = ? AND kind = 'stage' AND json_extract(data, '$.to') = 'merge'`).get(taskId) as { seq: number | null } | null)?.seq ?? 0;

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const int = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * 一条事件数据是不是卡当前这次 merge 的有效 v1 合入事实：字段齐全、格式合法、head / PR / specRev / round / mergeEntrySeq 全对上，
 * 且事件写在本次进入 merge 之后。旧 head、上一次 merge、resolved / 别的 phase、缺字段、未知版本都不算。
 */
export function validManualMerge(data: Record<string, unknown>, seq: number, id: MergeIdentity): boolean {
  const d = data as Partial<ManualMergeFact>;
  if (d.op !== MANUAL_MERGE_RECORD_OP || d.v !== 1 || d.phase !== "merged" || d.base !== BASE || !str(d.receipt)) return false;
  if (![d.head, d.mergeSha, d.mainHead].every((s) => str(s) && SHA.test(s)) || !str(d.pr) || !prCoordinates(d.pr)) return false;
  if (!int(d.specRev) || !int(d.round) || !int(d.mergeEntrySeq)) return false;
  return !!id.headSHA && d.head!.toLowerCase() === id.headSHA.toLowerCase() && d.pr === id.pr && d.specRev === id.specRev && d.round === id.round
    && id.entrySeq > 0 && d.mergeEntrySeq === id.entrySeq && seq > id.entrySeq;
}

const SAME_EVIDENCE: readonly (keyof ManualMergeFact)[] = ["head", "mergeSha", "pr", "base", "mainHead", "receipt"];

/** 登记：同一事务核权限 / 阶段 / head / PR / base / SHA / 证据，从库里取身份，写一条事件（或返回同证据的原事件） */
export function recordManualMerge(db: Database, ctx: WriteCtx, input: ManualMergeInput): { event: LedgerEvent; duplicate: boolean } {
  const receipt = textOneLine(input.receipt, "--receipt（可复核的证据路径或链接）", 600);
  for (const [flag, v] of [["head", input.head], ["merge-sha", input.mergeSha], ["main-head", input.mainHead]] as const) {
    if (!SHA.test(v)) throw new LedgerError("invalid", `--${flag} 要是完整 40 位 SHA`);
  }
  if (!prCoordinates(input.pr)) throw new LedgerError("invalid", "--pr 要是完整 GitHub PR 链接（https://github.com/<owner>/<repo>/pull/<n>）");
  if (input.base !== BASE) throw new LedgerError("invalid", `--base 只能是 ${BASE}`);
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    if (ctx.actor === "scheduler" || !actorMayConfigure(db, ctx.actor, task.project)) {
      throw new LedgerError("forbidden", `登记人工合入要项目 ${task.project} 的 PM（调度助理除外）/ master / owner（你是 ${ctx.actor}）`);
    }
    if (task.stage !== "merge") throw new LedgerError("conflict", `任务 ${task.id} 当前阶段是 ${task.stage}，只有留在 merge 的卡能登记人工合入`, { stage: task.stage });
    if (!task.headSHA || task.headSHA.toLowerCase() !== input.head.toLowerCase()) {
      throw new LedgerError("conflict", `--head 与卡当前 head 不一致（卡是 ${task.headSHA ?? "空"}）`);
    }
    if (!task.pr || task.pr !== input.pr) throw new LedgerError("conflict", `--pr 与卡登记的 PR 不一致（卡是 ${task.pr ?? "空"}）`);
    const entry = mergeEntrySeq(db, task.id);
    if (!entry) throw new LedgerError("conflict", `任务 ${task.id} 没有进入 merge 的阶段事件，登记不了`);
    const data: ManualMergeFact = { op: MANUAL_MERGE_RECORD_OP, v: 1, phase: "merged", head: task.headSHA, mergeSha: input.mergeSha.toLowerCase(), pr: task.pr,
      base: BASE, mainHead: input.mainHead.toLowerCase(), specRev: task.specRev, round: task.round, mergeEntrySeq: entry, receipt };
    const key = `${MANUAL_MERGE_RECORD_OP}:${task.id}:${entry}:${task.headSHA.toLowerCase()}`;
    const prev = getEventByDedup(db, key);
    if (prev) {
      const differs = prev.target === task.id && prev.kind === "scheduler" ? SAME_EVIDENCE.filter((k) => prev.data[k] !== data[k]) : ["事件"];
      if (differs.length) throw new LedgerError("conflict", `本次 merge 已登记过人工合入 #${prev.seq}，${differs.join(" / ")} 不同，不能覆盖原事实`);
      return { event: prev, duplicate: true };
    }
    const text = `人工合入登记：${task.headSHA.slice(0, 12)} → main ${data.mergeSha.slice(0, 12)}（${receipt}）`;
    return { event: insertEvent(db, { ...ctx, dedupKey: key }, { project: task.project, target: task.id, kind: "scheduler", text, data: { ...data } }, true),
      duplicate: false };
  });
}
