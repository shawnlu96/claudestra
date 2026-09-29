/** Only explicit, recorded participants make edges. Task targets are not agent recipients. */
import type { LedgerEvent } from "./ledger-stages.js";

export const TEAM_WINDOW_MS = 10 * 60_000;
export interface TeamInteraction {
  id: string;
  at: number;
  from: string;
  to: string | null;
  kind: "assign" | "dispatch" | "deliver" | "review" | "message";
  task: string | null;
}
interface MessageEvent {
  seq: number; ts: string; agent: string; chatId: string; type: string; data: Record<string, unknown>;
}

export function teamIdentity(value: unknown, localNames: ReadonlySet<string>): string | null {
  if (typeof value !== "string" || !value) return null;
  if (value === "owner" || value === "owner:self" || value === "api:owner:self") return "owner";
  if (value.startsWith("peer:")) return `instance:${value.slice(5)}`;
  const at = value.lastIndexOf("@");
  if (at > 0 && at < value.length - 1) return `peer:${value.slice(at + 1)}/${value.slice(0, at).replace(/^agent-/, "")}`;
  const name = value.replace(/^agent-/, "");
  return localNames.has(name) ? `local:${name}` : `unknown:${value}`;
}

const recent = (at: number, now: number) => Number.isFinite(at) && at > now - TEAM_WINDOW_MS && at <= now;

export function ledgerInteractions(events: readonly LedgerEvent[], localNames: ReadonlySet<string>, now: number): TeamInteraction[] {
  return events.flatMap((e) => {
    if (!recent(e.ts, now) || e.data.approxTime) return [];
    const from = teamIdentity(e.actor, localNames);
    if (!from) return [];
    let kind: TeamInteraction["kind"], recipient: unknown;
    if (e.kind === "step" && e.data.op === "assign") {
      kind = e.data.step === "review" || e.data.step === "final_review" ? "dispatch" : "assign"; recipient = e.data.executor;
    }
    else if (e.kind === "dispatch") { kind = "dispatch"; recipient = null; }
    else if (e.kind === "deliver" || e.kind === "review") { kind = e.kind; recipient = null; }
    else return [];
    const to = teamIdentity(recipient, localNames);
    return [{ id: `ledger:${e.seq}`, at: e.ts, from, to: to === from ? null : to, kind, task: e.target || null }];
  });
}

/** Count all ring entries, not just messages: tool traffic can evict messages too. */
export function teamRingTruncated(events: readonly MessageEvent[], members: ReadonlySet<string>, now: number, limit: number): boolean {
  const byAgent = new Map<string, number[]>();
  for (const e of events) {
    if (!members.has(e.agent.replace(/^agent-/, ""))) continue;
    const times = byAgent.get(e.agent) ?? [];
    times.push(Date.parse(e.ts));
    byAgent.set(e.agent, times);
  }
  return [...byAgent.values()].some((times) => times.length >= limit && Math.min(...times) > now - TEAM_WINDOW_MS);
}

export function messageInteractions(events: readonly MessageEvent[], localNames: ReadonlySet<string>, projectNames: ReadonlySet<string>, now: number): TeamInteraction[] {
  return events.flatMap((e) => {
    const at = Date.parse(e.ts);
    if (e.type !== "chat_message" || !recent(at, now) || !projectNames.has(e.agent.replace(/^agent-/, ""))) return [];
    let from: string | null = null, to: string | null = null;
    if (e.data.direction === "in") {
      to = teamIdentity(e.agent, localNames);
      if (e.data.srcKind === "local" && e.data.fromId === "agent") from = teamIdentity(e.data.from, localNames);
      else if (e.data.srcKind === "api" && e.data.fromId === "api:owner:self") from = "owner";
    } else if (e.data.direction === "out" && e.chatId === "api:owner:self" && !e.data.notice) {
      from = teamIdentity(e.agent, localNames); to = "owner";
    }
    return from && to && from !== to ? [{ id: `bridge:${e.seq}`, at, from, to, kind: "message" as const, task: null }] : [];
  });
}
