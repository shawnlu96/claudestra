/** Browser copy of GET /team/roster; the contract test checks both assignment directions against the bridge. */
export type RosterFamily = "claude" | "codex";
export const ROSTER_FAMILIES: readonly RosterFamily[] = ["claude", "codex"];
export type RosterWorkerState = "running" | "silent" | "no_beat" | "unknown";
export type RosterWorkerRole = "author" | "reviewer";
export interface RosterWorker {
  id: string; name: string | null; family: RosterFamily; role: RosterWorkerRole;
  taskId: string | null; step: string | null; round: number | null; since: number | null;
  phase: string | null; excerpt: string | null; beatAt: number | null; state: RosterWorkerState;
}
export interface RosterSlot { total: number; busy: number; reportedBusy: number | null; placeable: number; held: boolean }
export interface RosterQuota { usedPct: number; resetAt: number; stopPct: number | null; observedAt: number | null }
export interface RosterCards { merge: string[]; live: string[]; blocked: string[] }
export interface RosterOutputDay { day: string; delivered: number; reviewed: number }
export interface RosterMachine {
  machineKey: string; instanceId: string | null;
  online: boolean | null; checkedAt: number | null; latencyMs: number | null; helloAt: number | null;
  proto: "local" | "push" | "poll" | null; why: string | null;
  slots: Record<RosterFamily, RosterSlot | null>; quota: Record<RosterFamily, RosterQuota | null>;
  grant: { roles: string[]; repos: number; until: number; ordersLeftToday: number } | null;
  paused: { reason: string; until: number } | null;
  workers: RosterWorker[]; cards: RosterCards; output: RosterOutputDay[];
}
export interface RosterWire {
  now: number; project: string; self: { instanceId: string | null }; machines: RosterMachine[]; unattributed: RosterCards;
}
/** A discarded malformed machine makes aggregate counts unknown, never a confirmed zero. */
export interface Roster extends RosterWire { dropped: number }
export const LOCAL_MACHINE_KEY = "local";
