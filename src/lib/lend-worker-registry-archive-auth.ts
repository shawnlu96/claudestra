/** Historical cleanup uses the existing local owner-answer and ask-check rules, bound to an exact preview. */
import { bindHash, checkAsk } from "./ask-bind.js";
import { ownerAnswered, type Ask } from "./ledger-asks.js";

export interface WorkerArchiveApproval {
  listHash: string; registryHash: string; backupTarget: string;
}
export const workerArchiveBind = (params: WorkerArchiveApproval) => ({ action: "lend-worker-registry-archive", params });

export function checkWorkerArchiveApproval(ask: Ask | null, actor: string, params: WorkerArchiveApproval, now = Date.now()): void {
  if (!ask || ask.kind !== "authorize" || !ownerAnswered(ask.answer)) throw new Error("历史归档须 B owner 本人授权，PM / peer 不能代批");
  const check = checkAsk(ask, bindHash(workerArchiveBind(params), actor), actor, now);
  if (!check.ok) throw new Error(`历史归档授权未通过 ask-check：${check.reason}`);
}
