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
import { lendFixMaterials } from "./lend-fix-env.js";
import { fixMaterials, materialsMode, sendsItems, type FixMaterials, type MaterialsPolicy } from "./fix-materials.js";

const PR_BASE = "main";

export interface WriteProbe {
  /** Fingerprint of the peer's pinned instance key; null = not paired end to end. */
  peerFp(peer: string): Promise<string | null>;
  remoteHead(repo: string, branch: string): Promise<RemoteHead>;
}

/** A fix offer may carry structured material (fix-materials.ts); `report` is then only the UI part, or null. */
export type WriteMaterial = WriteOffer & { materials?: FixMaterials };

/**
 * null = the card's stage lends no write order (review, or not lendable at all). `policy` is the materials recovery read; the
 * production callers do not pass it yet, so the report goes out whole as before (observe only records what on would send).
 */
export async function writeMaterials(db: Database, task: LedgerTask, q: { peer: string; repo: string; base: string }, probe: WriteProbe,
  policy?: MaterialsPolicy): Promise<WriteMaterial | null> {
  const step = stepOfStage(task.stage);
  if (step !== "write" && step !== "fix") return null;
  const fp = await probe.peerFp(q.peer);
  if (!fp) throw new LedgerError("invalid", `${q.peer} 没有钉住的实例公钥，出借分支没法定名（先让对方完成 E2E 配对）`);
  if (!isBaseBranch(q.base)) throw new LedgerError("invalid", `--base ${q.base} 不是能用的基线分支名`);
  if (step === "write") {
    const r = await probe.remoteHead(q.repo, q.base);
    if (!r.ok) throw new LedgerError("invalid", `查不到 ${q.repo} 的 ${q.base}：${r.error}`);
    return { fp, base: PR_BASE, baseSha: r.head, report: null }; // --base 只定起点；PR 的 base 固定是 main（i28-RA1：开在起点分支上会冻住合并队列）
  }
  if (fixBounce(listEvents(db, { project: task.project, target: task.id }), task.stage)) return lendFixMaterials(fp, q, probe, { db, task });
  const ui = uiRejectLend(db, task); // 同一合成函数决定截图意见与代码 P1 的来源；有代码问题时报告原文也必须内联
  if (ui && !ui.codeReportPath) return { fp, base: q.base, baseSha: null, report: ui.report };
  const path = ui?.codeReportPath ?? lastReviewOf(db, task).path;
  const report = readTextSoft(path);
  if (!report) throw new LedgerError("invalid", `找不到上一轮审查报告原文（${path ?? "卡上最近的审查没记报告路径"}），修复单要把它内联给对方`);
  const whole = { fp, base: q.base, baseSha: null, report: ui ? `${ui.report}\n\n# 代码审查报告\n\n${report}` : report };
  const mode = materialsMode(policy, task.project);
  const materials = mode === "off" ? null : fixMaterials(mode, listEvents(db, { project: task.project, target: task.id }), path as string, report);
  if (!materials) return whole; // off, or a review without structured findings: the original full-text path
  // An item without its description (a local review keeps it only in free text) keeps the full text; the note records the fallback.
  return sendsItems(materials) ? { ...whole, report: ui ? ui.report : null, materials } : { ...whole, materials };
}
