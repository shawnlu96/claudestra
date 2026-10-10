import { askFromLink } from "@/lib/hash-nav";
import { fetchAsks } from "@/lib/api/asks";
import { reads } from "@/lib/api/push";
import { loadAgents, uiAgentName } from "@/lib/chat/agents";
import { machines } from "@/lib/machines";

export interface NotificationData {
  agent?: string;
  ts?: number;
  url?: string;
  ask?: string;
  fp?: string;
}
export interface CleanupContext {
  now: number;
  reads: Record<string, number>;
  native: boolean;
  machineCount: number;
  fp: string | null;
  openAsks?: Set<string>;
  agents?: Set<string>;
}
const askId = (d: NotificationData) => askFromLink(d.url) || d.ask || null;
const local = (d: NotificationData, c: CleanupContext) => c.native ? c.machineCount <= 1 : d.fp === c.fp;
const watermarked = (d: NotificationData, c: CleanupContext) => !!d.agent && !!c.reads[d.agent] && Number(d.ts || 0) <= c.reads[d.agent];

/** Watermark first, then exactly one rule per remaining notification. Unknown data always retains it. */
export function shouldRemoveNotification(d: NotificationData, c: CleanupContext): boolean {
  if (watermarked(d, c)) return true;
  const ask = askId(d);
  if (ask) return local(d, c) && c.openAsks !== undefined && !c.openAsks.has(ask);
  if (!d.agent) return Number(d.ts || 0) < c.now - 24 * 3600_000;
  return local(d, c) && c.agents !== undefined && !c.agents.has(uiAgentName(d.agent));
}

/** Each unavailable endpoint disables only its own rule. Empty notification centers do no network work. */
export async function notificationCleanupContext(data: NotificationData[], native: boolean, marks?: Record<string, number>): Promise<CleanupContext> {
  const c: CleanupContext = { now: Date.now(), reads: marks ?? {}, native, fp: machines.currentFp(), machineCount: machines.all().length };
  if (!data.length) return c;
  if (!marks) {
    try { c.reads = await reads(); }
    catch { /* Offline / forbidden read marks must not block age, ask or missing-agent cleanup. */ }
  }
  const remaining = data.filter((d) => !watermarked(d, c) && local(d, c));
  await Promise.all([
    remaining.some((d) => askId(d)) ? fetchAsks().then((r) => {
      if (r.full === true) c.openAsks = new Set(r.asks.filter((a) => a.state === "open").map((a) => a.id));
    }).catch(() => { /* Without a complete ask list, completed and invisible asks cannot be distinguished. */ }) : undefined,
    remaining.some((d) => !askId(d) && d.agent) ? loadAgents().then((agents) => {
      c.agents = new Set(agents.map((a) => a.name));
    }).catch(() => { /* A failed agent list is no evidence that an agent was deleted. */ }) : undefined,
  ]);
  // Requests can finish after a switch: the new machine's snapshot cannot classify the old notification center.
  if (machines.currentFp() !== c.fp) { c.openAsks = undefined; c.agents = undefined; }
  return c;
}
