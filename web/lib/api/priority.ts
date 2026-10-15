/** Priority panel uses server-authorized asks; the browser never supplies actor or owner evidence. */
import { api } from './client';
export type PriorityBand = 'now' | 'next' | 'later';
export type PriorityTarget = { kind: 'task'; id: string } | { kind: 'node'; id: string; nodeKey: string };
export interface PanelRow {
  key: string; target: PriorityTarget; taskId: string | null; featureId: string | null; nodeKey: string | null;
  title: string; feature: string | null; stage: string; state: string; reason: string; since: number | null; escalation: string;
  priority: { recordId: string | null; rev: number; effective: PriorityBand; explicit: PriorityBand | null;
    source: 'explicit' | 'feature' | 'system'; inheritedFrom: string | null; order: number | null; note: string | null };
}
export interface PrioritySnapshot {
  project: string; now: number; version: string; rows: PanelRow[]; canWrite: boolean;
  modes: Record<'priorityPanel' | 'prioritySort' | 'priorityNowStart' | 'priorityStall', { mode: 'off' | 'observe' | 'on'; rev: number; available: boolean }>;
  order: { members: string[]; rev: number };
}
export interface PriorityChange {
  target: PriorityTarget; rev: number; operation: 'set' | 'clear' | 'up' | 'down'; band?: PriorityBand;
  snapshot: string; observedAt: number;
}
export interface PriorityHistoryEntry { seq: number; ts: number; text: string; actor: string; data: { op?: string; ownerWords?: string } }
const path = (project: string) => `/ledger/${encodeURIComponent(project)}/priority`;
export function fetchPriority(project: string, signal?: AbortSignal): Promise<PrioritySnapshot> {
  return api(path(project), { signal, timeoutMs: 10000 });
}
export function requestPriority(project: string, change: PriorityChange): Promise<{ askId: string; label: string; choice: string }> {
  return api(`${path(project)}/requests`, { method: 'POST', json: change, timeoutMs: 10000 });
}
export function priorityResult(project: string, askId: string): Promise<{ verified: boolean; observed: boolean }> {
  return api(`${path(project)}/result?askId=${encodeURIComponent(askId)}`, { timeoutMs: 10000 });
}
export function fetchPriorityHistory(project: string): Promise<{ history: PriorityHistoryEntry[] }> {
  return api(`${path(project)}/history`, { timeoutMs: 10000 });
}
