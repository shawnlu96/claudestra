/** Manual family selection never infers an author from the CLI's Codex default. */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { LEND_FAMILIES, type LendFamily, type BorrowEntry } from "./lend-config.js";
import { isWriteStep, stepOfStage } from "./lend-git.js";
import { HELLO_FRESH_MS } from "./lend-wire-v2.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { busyAsLedgerError, getTask, LedgerError } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getLendPeer, peerCapacity } from "./ledger-lend-peers.js";
import { cooldownPeerSlots } from "./lend-peer-cooldown.js";
import { heldLease } from "./ledger-lend-lease.js";
import { offerLend, reofferLend, type OfferInput, type LendOrder } from "./ledger-lend.js";
import { securityPoolMode, securityReviewLocalOnly } from "./security-pool.js";

export function cliOfferFamily(db: Database, task: LedgerTask, family = "codex"): LendFamily {
  if (!(LEND_FAMILIES as readonly string[]).includes(family)) {
    throw new LedgerError("invalid", `--family 只能是 ${LEND_FAMILIES.join(" / ")}（不是 ${family}）`);
  }
  const step = stepOfStage(task.stage);
  const wf = getWorkflow(db, task.id);
  if (step === "review") {
    if (securityReviewLocalOnly(wf, securityPoolMode(task.project))) throw new LedgerError("forbidden", "security 卡的审查只在本机做，不借出去");
    // Preserve the existing review policy, including legacy workflows whose revision predates this card's spec.
    const reviewedAuthor = remoteHeadFamily(db, task) ?? wf?.authorFamily ?? null;
    if (reviewedAuthor === family) throw new LedgerError("forbidden", `这张卡的代码是 ${reviewedAuthor} 写的，不能再借 ${family} 审（要跨模型独立审查）`);
    if (!reviewedAuthor && family === "claude") throw new LedgerError("forbidden", "认不出这张卡的作者家族，证明不了 Claude 审查是跨模型的");
  } else if (family === "claude") {
    const author = remoteHeadFamily(db, task) ?? (wf?.specRev === task.specRev ? wf.authorFamily : null);
    if (!step || !isWriteStep(step) || author !== family) {
      throw new LedgerError("forbidden", "写 / 修复单须有本卡当前规格的作者家族记录或真实交付记录证明作者是 Claude");
    }
  }
  return family as LendFamily;
}

/** File-backed contact / borrow revocations and key rotation must also survive the material-read window. */
export async function refreshCliOffer(input: OfferInput, project: string, deps: {
  borrow(): Promise<BorrowEntry[]>; result: { peerFp?: (peer: string) => Promise<string | null> };
}): Promise<OfferInput> {
  const checkPin = input.family === "claude" && !!input.write;
  const [entries, fp] = await Promise.all([deps.borrow(), checkPin ? deps.result.peerFp?.(input.peer) : null]);
  if (checkPin && (!fp || fp !== input.write!.fp)) throw new LedgerError("forbidden", "读取材料期间 peer 实例公钥改变或失读");
  const borrow = entries.find((b) => b.peer === input.peer && b.projects.includes(project)) ?? null;
  return { ...input, borrow };
}

/** Read the authenticated hello again after material I/O, in the same transaction that creates the order and lease. */
function assertClaudeWriter(db: Database, task: LedgerTask, input: OfferInput, now: number): void {
  const b = input.borrow;
  if (!b || b.peer !== input.peer || !b.projects.includes(task.project) || !b.roles.includes("write")) {
    throw new LedgerError("forbidden", "borrow 未授权本项目的写代码角色");
  }
  const p = getLendPeer(db, input.peer);
  if (!p || p.proto !== 3 || p.helloAt > now || now - p.helloAt > HELLO_FRESH_MS) {
    throw new LedgerError("forbidden", "Claude 写单需要当前有效的 v3 peer hello");
  }
  if (!p.fp || p.fp !== input.write?.fp || (b.fp && b.fp !== p.fp)) {
    throw new LedgerError("forbidden", "peer hello 与本次写单的实例指纹不符");
  }
  if (!p.grant?.roles.includes("write") || !p.grant.repos.includes(input.repo)) {
    throw new LedgerError("forbidden", "peer 已撤销写角色或没有授权本仓库");
  }
  const cap = peerCapacity(db, input.peer, b.maxOpen, now);
  if (cap.why || !(cooldownPeerSlots(db, input.peer, cap.slots, now).claude > 0)) {
    throw new LedgerError("forbidden", `peer 当前无法接 Claude 写单：${cap.why ?? "Claude 无可用额度"}`);
  }
  const lease = heldLease(db, task);
  if (lease && lease.repo !== input.repo) throw new LedgerError("conflict", "本卡写租约的仓库与挂单不符");
}

/** No await between the final family / capability check and the existing refusal-first offer transaction. */
export function offerWithAuthorFamily(db: Database, ctx: WriteCtx, snapshot: LedgerTask, input: OfferInput, reason?: string): LendOrder {
  return busyAsLedgerError("挂出借单", () => db.transaction(() => {
    const task = getTask(db, snapshot.id);
    if (!task || task.rev !== snapshot.rev || task.specRev !== snapshot.specRev || task.round !== snapshot.round ||
      task.stage !== snapshot.stage || task.headSHA !== snapshot.headSHA) throw new LedgerError("conflict", "读取派单材料期间卡已改变，请重读后再挂单");
    cliOfferFamily(db, task, input.family);
    if (input.family === "claude" && isWriteStep(stepOfStage(task.stage) ?? "")) assertClaudeWriter(db, task, input, ctx.now ?? Date.now());
    return reason === undefined ? offerLend(db, ctx, input) : reofferLend(db, ctx, { ...input, reason });
  }).immediate());
}
