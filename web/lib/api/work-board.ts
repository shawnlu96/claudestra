import type { WorkBoard } from '@/features/collab/work/work-types';
import { api } from './client';
export function fetchWorkBoard(project: string, signal?: AbortSignal): Promise<WorkBoard> {
  return api(`/ledger/${encodeURIComponent(project)}/work`, { timeoutMs: 10_000, signal });
}
