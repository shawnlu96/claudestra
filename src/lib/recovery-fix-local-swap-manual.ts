/**
 * fixLocalSwap for manual fix cards (PM 定值 2): a RECBASE1 evidence mechanism (manual-recovery-release.ts) hands a manual fix card
 * back to auto only when the owner set manualStallHours and the card has stalled past it, and the same trigger the auto path reads
 * (a gate block or a slotless fixed peer past FIX_LOCAL_SWAP_WAIT_MS, lease at the head's writer, local runtime of the other family)
 * stands. The grant is this fix plus the next round's cross-model review: once that review's verdict is recorded the tick returns the
 * card to manual through the existing fallback writer, with the entry's own manual reason code. Build cards, non-fix manual cards, a
 * missing owner threshold and PM / owner holds stay manual. Mode: manualRecovery and fixLocalSwap both explicitly on (extensionMode).
 * tests/recovery-fix-local-swap-hold.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import type { ManualRecoveryMechanism } from "./manual-recovery-release.js";
import type { ManualReasonCode } from "./manual-reason.js";
import { recoveryPolicy } from "./recovery-policy.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { readLendSync } from "./lend-config.js";
import { autoSnapshot } from "./scheduler-auto-snapshot.js";
import { FIX_LOCAL_SWAP_KEY, localSwapFact, localSwapPorts, remoteHeadPeer } from "./recovery-fix-local-swap.js";

const FIX_LOCAL_SWAP_MECHANISM = "fix-local-swap";
/**
 * The one entry whose release this takeover is ("写租约重新授予或本机接回"); a wider list would also make the tick send every
 * other manual card of those codes through the leased CLI just to refuse it. Sticky codes are refused by the base anyway.
 */
const CODES: readonly ManualReasonCode[] = ["write_lease_ended"];
const MODE_OPS: readonly string[] = ["workflow", "workflow_resume", "fallback_manual"];
const no = (why: string) => ({ ok: false as const, why });

function poolOf(db: Database, project: string) {
  const injected = localSwapPorts(db).pool?.(project);
  if (injected) return injected;
  const remote = readSchedulerConfig().projects[project]?.remote;
  return remote ? { remote, borrow: readLendSync().file.borrow } : undefined;
}

function judge(db: Database, task: LedgerTask, events: readonly LedgerEvent[], entrySeq: number) {
  if (task.stage !== "fix") return no(`卡在 ${task.stage}：本键只接续 fix 阶段的 manual 卡`);
  const entry = events.find((e) => e.seq === entrySeq);
  const now = localSwapPorts(db).now?.() ?? Date.now();
  const owner = (localSwapPorts(db).policy ?? recoveryPolicy)(task.project, FIX_LOCAL_SWAP_KEY).manualAfterMs;
  if (owner === null) return no("owner 没设 manualStallHours：manual 卡不接续");
  if (!entry || now - entry.ts < owner) return no(`manual 停滞未满 owner 阈值 ${owner / 3_600_000} 小时`);
  const snap = autoSnapshot(db, task, { registry: [], maxWorkers: 0, now, pool: poolOf(db, task.project) });
  if (!snap.workflow) return no("没有调度流程");
  // the same trigger the auto path reads, judged as if the card were auto (the mode is the only difference the grant lifts)
  const f = localSwapFact({ ...snap, workflow: { ...snap.workflow, mode: "auto" } }, "on", now, remoteHeadPeer(db, task));
  if (!f.candidate || !f.ripe) return no(`本机接手触发不成立：${f.why ?? "未到阈值"}`);
  return { ok: true as const, episodeId: `e${entrySeq}`, subreason: `fix_local_swap_${f.candidate.source}`, cancelIntentId: null,
    evidenceSeq: f.candidate.sinceSeq, next: "fix-local-swap" };
}

export const fixLocalSwapManual: ManualRecoveryMechanism = {
  id: FIX_LOCAL_SWAP_MECHANISM, key: FIX_LOCAL_SWAP_KEY, codes: CODES,
  judge: (x) => judge(x.db, x.task, x.events, x.entrySeq),
};

/**
 * The grant's end: the card's current mode came from this mechanism's hand-back at round R, and the cross-model review of round R + 1
 * has its verdict. Returns the fallback reason (with the entry's manual code) or null. Any later mode write ends the grant too.
 */
export function localSwapGrantEnded(task: LedgerTask, events: readonly LedgerEvent[]): string | null {
  const last = events.findLast((e) => e.kind === "scheduler" && MODE_OPS.includes(String(e.data.op)));
  const proof = last?.data.recoveryProof as { mechanism?: string; round?: number; reason?: string } | undefined;
  if (!last || last.data.op !== "workflow_resume" || proof?.mechanism !== FIX_LOCAL_SWAP_MECHANISM || typeof proof.round !== "number") return null;
  const review = events.find((e) => e.seq > last.seq && e.kind === "review" && e.data.round === proof.round! + 1);
  if (!review) return null;
  return `${proof.reason ?? "review_unresolved"}: fixLocalSwap 授权的本次修复与第 ${proof.round + 1} 轮跨模型审查已结束（审查 #${review.seq}），照旧回 manual；` +
    `解除：PM 核对后 workflow-resume；事件：#${review.seq}`;
}
