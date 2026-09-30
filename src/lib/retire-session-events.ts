/** 会话轮换只退役旧流事件，保留未绑 sid 的排队消息；与事件总线存储无关。 */
export function retireSessionEvents<T extends { data: Record<string, unknown> }>(rings: Map<string, T[]>, agent: string, sid: string): void {
  const old = sid.replace(/^acp:/, "");
  const ring = rings.get(agent);
  if (ring) rings.set(agent, ring.filter((e) => !e.data.sid || String(e.data.sid).replace(/^acp:/, "") !== old));
}

/** kill 后清掉同一 agent 的回放与状态，防止已删除 agent 永久占内存。 */
export function forgetEventAgent(agent: string, maps: { delete(key: string): boolean }[]): void {
  for (const map of maps) map.delete(agent);
}
