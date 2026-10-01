import { expect, test } from 'bun:test';
import { completionHours, estimateMinutes, normalMinutes, remainingMinutes, stepSamples } from '../src/lib/ledger-work-board-time.js';
import type { LedgerEvent } from '../src/lib/ledger-stages.js';
const event = (stage: string, ts: number, seq: number): LedgerEvent => ({ seq, ts, project: 'p', target: 't', actor: 'owner',
  kind: 'stage', text: '', data: { to: stage }, dedupKey: null });
test('seven-day completed stage medians, five samples required, current stage excluded', () => {
  const events = new Map(Array.from({ length: 5 }, (_, i) => [`t${i}`, [event('build', 1000, 1), event('review', 1000 + (i + 1) * 60000, 2)]]));
  const samples = stepSamples(events, 400000);
  expect(samples.write).toEqual([1, 2, 3, 4, 5]);
  expect(samples.review).toEqual([]);
  expect(normalMinutes('write', samples, '1天')).toBe(3);
  expect(remainingMinutes('write', 10, samples, '', true)).toBe(60);
  expect(remainingMinutes('fix', 50, samples, '', true)).toBe(60);
  expect(stepSamples(events, 8 * 86400000).write).toEqual([]);
  expect(normalMinutes('write', { ...samples, write: [1, 2] }, '')).toBe(60);
  expect(normalMinutes('write', { ...samples, write: [] }, '半天')).toBeCloseTo(240 * 60 / 130);
});
test('estimate units, ranges and capacity-constrained critical path round to hours', () => {
  expect(['S', '半天', '1 天', '1-2天', 'garbled'].map(estimateMinutes)).toEqual([30, 240, 480, 720, 120]);
  const graph = [{ id: 'a', deps: [], minutes: 60 }, { id: 'b', deps: ['a'], minutes: 120 }, { id: 'c', deps: [], minutes: 240 }];
  expect(completionHours(graph, 3)).toBe(4);
  expect(completionHours(graph, 1)).toBe(7);
  expect(completionHours(graph, 0)).toBeNull();
  expect(completionHours([{ id: 'a', deps: ['a'], minutes: 60 }], 2)).toBeNull();
});
