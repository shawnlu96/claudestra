import type { LedgerTask } from './ledger-stages.js';

/** Keep the no-DAG projection as small as a card link, and scope it even if a foreign task has a stale feature binding. */
export function productFeatureCards(tasks: readonly LedgerTask[], project: string, featureId: string) {
  return tasks.filter(t => t.project === project && t.featureId === featureId)
    .map(({ id, title, stage }) => ({ id, title, stage }));
}
