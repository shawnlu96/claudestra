import type { DagBoard } from '../dag/dag-types';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A product summary cannot substitute for a readable snapshot of the selected feature. */
export function hasFeatureSnapshot(board: DagBoard | null, id: string): boolean {
  return !!board?.features.some(f => f.id === id && f.currentVersion > 0 && Array.isArray(f.nodes));
}

/** Do not store incomplete successful responses; downstream layouts assume node dependencies and counts exist. */
export function assertDagSnapshot(board: unknown): asserts board is DagBoard {
  if (!object(board) || !Array.isArray(board.features) || !Array.isArray(board.agents)) throw new Error('Invalid DAG snapshot');
  for (const f of board.features) {
    if (!object(f) || typeof f.id !== 'string' || typeof f.currentVersion !== 'number' || !object(f.counts)
      || !Array.isArray(f.nodes) || f.nodes.some(n => !object(n) || typeof n.key !== 'string' || !Array.isArray(n.deps))) {
      throw new Error('Invalid feature snapshot');
    }
  }
}

export const dagRetryDelay = (delay: number): number => Math.min(delay * 2, 60_000);
