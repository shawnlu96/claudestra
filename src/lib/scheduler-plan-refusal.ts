/** Only the ledger's resource-overlap refusal is normal queueing; other conflicts still need the refusal alarm. */
export function isResourceWait(code: string, error: string): boolean {
  return code === "conflict" && /^资源 \S+ 与 \S+ 重叠（[\s\S]+ 占用）$/.test(error);
}
