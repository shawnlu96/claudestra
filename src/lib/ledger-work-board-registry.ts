/** A stale cached registry must not vouch for a manual worker after a failed read. */
import { REGISTRY_PATH, normalizeRegistryAgents, type RegistryAgent } from './registry.js';
import { readJsonStateSync } from './state-file.js';
export function workBoardRegistry(path = REGISTRY_PATH): readonly RegistryAgent[] {
  try {
    const state = readJsonStateSync(path);
    if (state.status !== 'ok') {
      console.error('[work-board] registry unavailable', state.status === 'corrupt' ? state.error : 'missing');
      return [];
    }
    return normalizeRegistryAgents(state.data);
  } catch (error) {
    console.error('[work-board] registry read failed', error);
    return [];
  }
}

export function workBoardWorkerAlive(agent: RegistryAgent): boolean {
  return agent.status === 'active' || agent.status === 'creating';
}
