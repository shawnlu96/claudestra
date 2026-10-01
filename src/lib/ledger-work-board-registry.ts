/** A stale cached registry must not vouch for a manual worker after a failed read. */
import { REGISTRY_PATH, readRegistryAgentsSync, type RegistryAgent } from './registry.js';
import { readJsonStateSync } from './state-file.js';
export function workBoardRegistry(path = REGISTRY_PATH): readonly RegistryAgent[] {
  try {
    const state = readJsonStateSync(path);
    if (state.status !== 'ok') {
      console.error('[work-board] registry unavailable', state.status === 'corrupt' ? state.error : 'missing');
      return [];
    }
    return readRegistryAgentsSync(path);
  } catch (error) {
    console.error('[work-board] registry read failed', error);
    return [];
  }
}
