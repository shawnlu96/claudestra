/**
 * Provider-side claim gate for every reserved recovery marker, run before clone and again before start (lend-drive.ts).
 * Classification first: v2 runs only the REBOR2 checks, v1 / none keep the unchanged REBOR path, and a mixed, duplicate or damaged
 * marker is refused — never an ordinary order. A cross-peer successor never treats this machine's missing journal as proof that
 * the original worker stopped; it verifies the real remote source and the borrower-proven end kind instead. tests/lend-reborrow2-provider.test.ts.
 */
import { getOrder, orderOf, type LendRow } from "./lend-journal.js";
import { workerName } from "./lend-worker-name.js";
import { classifyModelOutcome } from "./scheduler-model-outcome.js";
import { reborrowClaimProblem, type ReborrowProviderPort } from "./lend-reborrow-provider.js";
import { classifyReserved, CROSS_PEER_ENDS, type Reborrow2Binding } from "./lend-reborrow2-marker.js";
import { remoteBranchState } from "./lend-reborrow2-source.js";
import { preserveReborrow2Git, Reborrow2Refusal } from "./lend-reborrow2-preserve.js";

export interface Reborrow2ProviderPort extends ReborrowProviderPort {
  reborrow2Checkpoints?: (old: LendRow, next: LendRow) => Promise<void>;
  /** null head = confirmed absent; throw / null result = unreadable. */
  reborrow2Remote?: (repo: string, branch: string) => Promise<{ head: string | null } | null>;
}

const refuse = (why: string): never => { throw new Reborrow2Refusal(why); };
const END_STATES: Record<Reborrow2Binding["end"], readonly string[]> = {
  never_claimed: [], not_started: ["released"], delivered: ["acked"], stopped: ["stopped", "cancelled"], cancelled: ["cancelled", "stopped", "released"],
};

function oldJournal(row: LendRow, next: LendRow, b: Reborrow2Binding): void {
  const a = orderOf(row), n = orderOf(next);
  if (row.orderId === next.orderId || row.peer !== next.peer || !row.fp || row.fp !== next.fp || row.leaseGen !== b.gen || !a || !n ||
    a.taskId !== n.taskId || a.repo !== n.repo || a.specRev !== n.specRev || row.wire?.write?.branch !== b.src || b.src !== next.wire?.write?.branch ||
    row.wire.write.base !== "main" || next.wire?.write?.base !== "main" || !["write", "fix"].includes(String(a.step))) refuse("旧 journal 身份、实例、代数、仓库或分支不符");
  if (!END_STATES[b.end].includes(row.state)) refuse(`旧 journal 终态 ${row.state} 与接续依据 ${b.end} 不符，或仍活 / 结果未知`);
  if (row.settle) refuse("旧单终态收尾（archive / settle）未完成");
  if (row.submit === "sending" || ((row.payload || row.payloadSha) && (row.state !== "acked" || !row.receipt))) refuse("旧单有已送出但未确认的结果（未知结果）");
  if (row.state === "acked" && !row.receipt) refuse("旧交付回执失读");
  if (row.reason && classifyModelOutcome({ failure: { kind: "error", message: row.reason } })?.cls === "safety") refuse("旧单是模型安全拒绝，不能续做");
}

async function sameJournal(next: LendRow, b: Reborrow2Binding, d: Reborrow2ProviderPort): Promise<void> {
  const old = getOrder(d.db, b.orderId);
  if (!old) {
    // Only an order this provider never claimed may be absent from its own journal.
    if (b.end !== "never_claimed" || b.gen !== 0) refuse("旧 orderId/gen 的真实 journal 失读");
    return crossSource(next, b, d);
  }
  oldJournal(old, next, b);
  const stopped = async () => {
    if (d.failure(old.agent ?? workerName(old.orderId))) refuse("旧提供方失败尚未解决，不自动重试");
    if (await d.worker.alive(old.agent ?? workerName(old.orderId)) !== "no_window") refuse("旧 worker 仍活或未确认停止（unknown）");
  };
  await stopped();
  await (d.reborrow2Checkpoints ?? preserveReborrow2Git)(old, next);
  if (JSON.stringify(getOrder(d.db, old.orderId)) !== JSON.stringify(old)) refuse("核验期间旧 journal 漂移");
  await stopped();
}

/** Cross peer: the original side's end was proven to the borrower; here the real remote source must match it exactly. */
async function crossSource(next: LendRow, b: Reborrow2Binding, d: Reborrow2ProviderPort): Promise<void> {
  const o = orderOf(next), head = String(o?.head), repo = String(o?.repo), branch = next.wire?.write?.branch;
  if (!branch || (b.peer === "cross" && b.src === branch) || (b.peer === "same" && b.src !== branch)) refuse("新旧分支关系不明确");
  if (!CROSS_PEER_ENDS.includes(b.end)) refuse(`原侧结束方式 ${b.end} 可能留有未推检查点，只能由原提供方凭自己的 journal / 副本接续`);
  const read = d.reborrow2Remote ?? remoteBranchState;
  const src = await read(repo, b.src), dst = b.peer === "cross" ? await read(repo, branch!) : src;
  if (!src || !dst) refuse("原分支或新分支远端失读");
  if (src!.head === null ? !["never_claimed", "not_started"].includes(b.end) : src!.head !== head) refuse("订单起点与原分支远端 head 不符");
  if (dst!.head !== null && dst!.head !== head) refuse("新出借分支已有别的来源");
}

async function checkV2(next: LendRow, b: Reborrow2Binding, d: Reborrow2ProviderPort): Promise<void> {
  const o = orderOf(next);
  if (!o || !["write", "fix"].includes(String(o.step)) || !next.wire?.write || next.wire.write.base !== "main") refuse("终态接续只用于写 / 修复单");
  if (b.peer === "same") return sameJournal(next, b, d);
  // A local journal row for the "old" order contradicts a cross-peer binding; absence proves nothing and is not used as proof.
  if (getOrder(d.db, b.orderId)) refuse("本机有原单 journal，却被标为跨 peer 接续");
  return crossSource(next, b, d);
}

/** Bounded reason for canonical not_started release, or null. */
export async function recoveryClaimProblem(next: LendRow, d: Reborrow2ProviderPort): Promise<string | null> {
  const o = orderOf(next);
  if (!o || o.acceptance === undefined) return reborrowClaimProblem(next, d);
  const c = classifyReserved(o.acceptance as unknown[]);
  if (c.kind === "none" || c.kind === "v1") return reborrowClaimProblem(next, d);
  if (c.kind === "invalid") return `续借拒领：${c.why}`;
  try {
    await checkV2(next, c.binding, d);
    return null;
  } catch (e) {
    // Local paths and command output never cross to the borrower; journal/filesystem errors are an explicit denial.
    const why = e instanceof Reborrow2Refusal ? e.message : "来源失读或检查点未保全对账";
    return `终态接续拒领：${why.slice(0, 140)}`;
  }
}
