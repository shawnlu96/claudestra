/**
 * An order addressed to one session of an agent (the scheduler's `route_to_agent` with `expectSession`): if the registry
 * now runs a different session on that channel, the order is not for whoever holds the channel and is not delivered.
 * Checked when the bridge routes it and again right before a held copy is flushed, so a queued order never flows into a
 * replacement session. The refusal is typed (`rejected`) because nothing was sent: only then may the caller replan.
 */
import { readRegistryAgents, type RegistryAgent } from "./registry.js";

export type RouteRejection = { error: string; rejected: "session_mismatch" };

export async function sessionGone(expect: unknown, channelId: string,
  read: () => Promise<RegistryAgent[]> = readRegistryAgents): Promise<RouteRejection | null> {
  if (typeof expect !== "string" || !expect) return null;
  const row = (await read()).find((a) => a.channelId === channelId);
  if (row?.sessionId === expect) return null;
  return { error: `目标频道现在的 session（${row?.sessionId ?? "无"}）不是派单指定的 ${expect}，没有投递`, rejected: "session_mismatch" };
}
