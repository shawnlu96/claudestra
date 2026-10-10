/** Provider-local recovery checks run at every pre-worker boundary; borrower cancellation proves none of these facts. */
import type { Database } from "bun:sqlite";
import { getOrder, orderOf, type LendRow } from "./lend-journal.js";
import { workerName } from "./lend-worker-name.js";
import type { WorkerLiveness } from "./worker-liveness.js";
import { readReborrowBinding, type ReborrowBinding } from "./lend-reborrow-marker.js";
import { preserveReborrowGit } from "./lend-reborrow-preserve.js";

export interface ReborrowProviderPort {
  db: Database;
  worker: { alive(name: string): Promise<WorkerLiveness> };
  failure(agent: string): unknown;
  reborrowCheckpoints?: (old: LendRow, next: LendRow) => Promise<void>;
}

class ReborrowRefusal extends Error {}

function oldJournal(row: LendRow, next: LendRow, binding: ReborrowBinding): void {
  const a = orderOf(row), b = orderOf(next), gen = binding.gen;
  // v1 keeps one family. A CONV v2 binding names both families; each journal must match its own side exactly.
  const families = binding.conv ? row.family === binding.conv.from && next.family === binding.conv.to : row.family === next.family;
  if (row.orderId === next.orderId || row.peer !== next.peer || !row.fp || row.fp !== next.fp || !families || row.leaseGen !== gen ||
    !a || !b || a.taskId !== b.taskId || a.repo !== b.repo || a.specRev !== b.specRev || !row.wire?.write ||
    row.wire.write.branch !== next.wire?.write?.branch || row.wire.write.base !== "main" || next.wire?.write?.base !== "main" ||
    !["write", "fix"].includes(String(a.step)) || !["write", "fix"].includes(String(b.step))) throw new ReborrowRefusal("旧 journal 身份、代数、仓库或分支不符");
  if (!["acked", "cancelled", "released"].includes(row.state)) throw new ReborrowRefusal("旧 journal 仍活、结果未知或因失败停单");
  if (row.settle || row.submit === "sending" || ((row.payload || row.work || row.payloadSha) && (row.state !== "acked" || !row.receipt))) {
    throw new ReborrowRefusal("旧单有待转 payload/work 或未完成收尾");
  }
  if (row.state === "acked" && !row.receipt) throw new ReborrowRefusal("旧交付回执失读");
}

/** Return a bounded reason for canonical not_started release. No exception permits ordinary-order fallback. */
export async function reborrowClaimProblem(next: LendRow, d: ReborrowProviderPort): Promise<string | null> {
  try {
    const o = orderOf(next);
    if (!o || o.acceptance === undefined) return null; // Legacy ordinary journal rows can omit acceptance; claim responses are wire-validated.
    if (!Array.isArray(o.acceptance) || !o.acceptance.every((s) => typeof s === "string")) throw new ReborrowRefusal("完整 acceptance 失读");
    let binding;
    try { binding = readReborrowBinding(o.acceptance); } catch { throw new ReborrowRefusal("续借标记错误、重复或缺字段"); }
    if (!binding) return null;
    const old = getOrder(d.db, binding.orderId);
    if (!old) throw new ReborrowRefusal("旧 orderId/gen 的真实 journal 失读");
    oldJournal(old, next, binding);
    const stopped = async () => {
      if (d.failure(old.agent ?? workerName(old.orderId))) throw new ReborrowRefusal("旧提供方失败或拒绝尚未解决，不自动重试");
      if (await d.worker.alive(old.agent ?? workerName(old.orderId)) !== "no_window") throw new ReborrowRefusal("旧 worker 仍活或未确认停止（unknown）");
    };
    await stopped();
    await (d.reborrowCheckpoints ?? preserveReborrowGit)(old, next);
    if (JSON.stringify(getOrder(d.db, old.orderId)) !== JSON.stringify(old)) throw new ReborrowRefusal("核验期间旧 journal 漂移");
    await stopped();
    return null;
  } catch (e) {
    // Journal/filesystem failures are an explicit denial. Raw local paths or command output never cross to the borrower.
    const why = e instanceof ReborrowRefusal ? e.message : "来源失读或检查点未保全对账";
    return `续借拒领：${why.slice(0, 140)}`;
  }
}
