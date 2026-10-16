/** Only the ledger's resource-overlap refusal, or another card holding the unified merge-queue slot, is normal queueing; other conflicts still need the refusal alarm. */
export function isResourceWait(code: string, error: string, taskId?: string): boolean {
  if (code !== "conflict") return false;
  if (/^资源 \S+ 与 \S+ 重叠（[\s\S]+ 占用）$/.test(error)) return true;
  const holder = /^统一合并队列：既有意图持槽，先结清（([\s\S]+) 先）$/.exec(error)?.[1];
  return holder !== undefined && taskId !== undefined && holder !== taskId;
}
