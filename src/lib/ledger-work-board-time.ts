/** Estimates are advisory: completed steps in the last seven days, median with at least five samples;
 * otherwise apportion the node estimate, then fixed defaults. Remaining time never goes below zero.
 * Completion uses dependency critical paths plus total work / currently available machine slots, rounded to hours.
 */
import { stageTimeline } from './ledger-metrics.js';
import type { LedgerEvent } from './ledger-stages.js';
const DEFAULT_MINUTES = { restate: 10, write: 60, review: 30, fix: 30, merge: 15, deploy: 15 };
export type WorkStep = keyof typeof DEFAULT_MINUTES;
export const workStep = (stage: string): WorkStep | null =>
  ({ restate: 'restate', build: 'write', review: 'review', fix: 'fix', merge: 'merge', live: 'deploy' } as Record<string, WorkStep>)[stage] ?? null;
export function estimateMinutes(raw: string): number {
  if (raw.trim().toUpperCase() === 'S') return 30;
  if (raw.includes('半天')) return 240;
  const nums = raw.match(/\d+(?:\.\d+)?/g)?.map(Number);
  if (!nums?.length) return 120;
  const value = nums.reduce((a, b) => a + b, 0) / nums.length;
  return value * (/天|day/i.test(raw) ? 480 : /小时|hour|\bh\b/i.test(raw) ? 60 : /分|min/i.test(raw) ? 1 : 120 / value);
}
export function stepSamples(events: ReadonlyMap<string, readonly LedgerEvent[]>, now: number): Record<WorkStep, number[]> {
  const out = { restate: [], write: [], review: [], fix: [], merge: [], deploy: [] } as Record<WorkStep, number[]>;
  for (const own of events.values()) {
    const timeline = stageTimeline(own, now);
    for (const entry of timeline.slice(0, -1)) {
      const step = workStep(entry.stage);
      if (step && entry.to >= now - 7 * 86400000 && entry.to <= now) out[step].push(Math.max(0, entry.to - entry.from) / 60000);
    }
  }
  return out;
}
export function normalMinutes(step: WorkStep, samples: Record<WorkStep, number[]>, estimate: string): number {
  const sorted = [...samples[step]].sort((a, b) => a - b);
  if (sorted.length >= 5) {
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return estimate.trim() ? estimateMinutes(estimate) * DEFAULT_MINUTES[step] / 130 : DEFAULT_MINUTES[step];
}
export function remainingMinutes(step: WorkStep, elapsed: number, samples: Record<WorkStep, number[]>, estimate: string, code: boolean): number {
  const tails: Record<WorkStep, WorkStep[]> = { restate: ['write', 'review', 'merge', 'deploy'], write: ['review', 'merge', 'deploy'],
    review: ['merge', 'deploy'], fix: ['review', 'merge', 'deploy'], merge: ['deploy'], deploy: [] };
  return Math.max(normalMinutes(step, samples, estimate) - elapsed, 0) +
    (code ? tails[step] : []).reduce((sum, next) => sum + normalMinutes(next, samples, estimate), 0);
}
export function completionHours(nodes: readonly { id: string; deps: string[]; minutes: number }[], slots: number): number | null {
  if (slots <= 0 && nodes.some(n => n.minutes > 0)) return null;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const cache = new Map<string, number>(), visiting = new Set<string>();
  function path(id: string): number {
    if (cache.has(id)) return cache.get(id)!;
    if (visiting.has(id)) return Infinity;
    const n = byId.get(id);
    if (!n) return 0;
    visiting.add(id);
    const value = n.minutes + Math.max(0, ...n.deps.map(path));
    visiting.delete(id); cache.set(id, value); return value;
  }
  const minutes = Math.max(0, ...nodes.map(n => path(n.id)), nodes.reduce((sum, n) => sum + n.minutes, 0) / Math.max(1, slots));
  return Number.isFinite(minutes) ? Math.ceil(minutes / 60) : null;
}
