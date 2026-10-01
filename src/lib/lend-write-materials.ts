/**
 * Write-order materials (i28-R6; shared with the scheduler's pool step since i28-W9), fetched outside any ledger
 * transaction: the lender's fingerprint (pinned public key → lend/ branch name), the base branch's remote head for a build
 * order, the last review report's text for a P1 fix (the lender cannot read this machine's files). A merge bounce uses its
 * ledger evidence instead; other fixes require their report. tests/ledger-lend-write.test.ts, tests/scheduler-write-remote.test.ts.
 */
import type { Database } from "bun:sqlite";
import { lastReviewOf, type WriteOffer } from "./ledger-lend-lease.js";
import type { LedgerTask } from "./ledger-stages.js";
import { uiRejectLend } from "./ledger-ui-approve-verdict.js";
import { LedgerError, listEvents } from "./ledger-store.js";
import { isBaseBranch, stepOfStage } from "./lend-git.js";
import type { RemoteHead } from "./order-deliver.js";
import { readTextSoft } from "./task-spec.js";
import { fixBounce } from "./scheduler-merge-conflict.js";

export interface WriteProbe {
  /** Fingerprint of the peer's pinned instance key; null = not paired end to end. */
  peerFp(peer: string): Promise<string | null>;
  remoteHead(repo: string, branch: string): Promise<RemoteHead>;
}

/** null = the card's stage lends no write order (review, or not lendable at all). */
export async function writeMaterials(db: Database, task: LedgerTask, q: { peer: string; repo: string; base: string }, probe: WriteProbe): Promise<WriteOffer | null> {
  const step = stepOfStage(task.stage);
  if (step !== "write" && step !== "fix") return null;
  const fp = await probe.peerFp(q.peer);
  if (!fp) throw new LedgerError("invalid", `${q.peer} 没有钉住的实例公钥，出借分支没法定名（先让对方完成 E2E 配对）`);
  if (!isBaseBranch(q.base)) throw new LedgerError("invalid", `--base ${q.base} 不是能用的基线分支名`);
  if (step === "write") {
    const r = await probe.remoteHead(q.repo, q.base);
    if (!r.ok) throw new LedgerError("invalid", `查不到 ${q.repo} 的 ${q.base}：${r.error}`);
    return { fp, base: q.base, baseSha: r.head, report: null };
  }
  if (fixBounce(listEvents(db, { project: task.project, target: task.id }), task.stage)) return { fp, base: q.base, baseSha: null, report: null };
  const ui = uiRejectLend(db, task); // PM 退回截图：内联 PM 的意见，不是那份已通过的审查报告（ledger-ui-approve-verdict.ts）
  if (ui) return { fp, base: q.base, baseSha: null, report: ui.report };
  const path = lastReviewOf(db, task).path;
  const report = readTextSoft(path);
  if (!report) throw new LedgerError("invalid", `找不到上一轮审查报告原文（${path ?? "卡上最近的审查没记报告路径"}），修复单要把它内联给对方`);
  return { fp, base: q.base, baseSha: null, report };
}
