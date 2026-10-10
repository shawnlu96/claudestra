/** Browser mirrors of the execution view; no actor or role is sent in command bodies. */
import { parseCommand } from './shared-ledger-v2-command';
import { api, ApiError } from './client';
import type { MachineRef } from '../machines';
import type { Capability, FeatureAnchor, TaskCard, TaskScope, taskCommand } from '../../features/collab/shared/task/task-model';
import type { ApprovalView, approvalCommands } from '../../features/collab/shared/approve/approve-model';

export type ExecCommand = ReturnType<typeof taskCommand> | ReturnType<typeof approvalCommands>['answer'] | NonNullable<ReturnType<typeof approvalCommands>['decide']>;
export interface ExecView {
  teamId: string; projectId: string; serverSeq: number; serviceGeneration: number;
  feature: FeatureAnchor & { epoch: number; currentVersion: number };
  tasks: TaskCard[]; pendingAsks: ApprovalView['ask'][]; capabilities: Record<string, Capability>;
}
export interface ExecReceipt {
  schemaVersion: 2; teamId: string; projectId: string; requestId: string; commandDigest: string;
  command: string; serverSeq: number; serviceGeneration: number;
  result: { epoch: number; operationId: string | null };
}
export type ReceiptResult = { status: 'committed'; receipt: ExecReceipt } | { status: 'unknown'; requestId: string };
export interface ReceiptQuery {
  teamId: string; projectId: string; requestId: string; operationId: string | null; commandDigest: string;
}
export interface ExecTransport {
  snapshot(featureId: string, signal: AbortSignal): Promise<ExecView>;
  command(command: ExecCommand, signal: AbortSignal): Promise<unknown>;
  receipt(query: ReceiptQuery, signal: AbortSignal): Promise<unknown>;
  ask(askId: string, signal: AbortSignal): Promise<ApprovalView['ask']>;
}
export function sharedExecTransport(project: string, machine?: MachineRef): ExecTransport {
  const root = '/shared-exec', query = `project=${encodeURIComponent(project)}`;
  return {
    snapshot: (id, signal) => api(`${root}/features/${encodeURIComponent(id)}?${query}`, { signal }, machine),
    command: (json, signal) => api(`${root}/commands`, { method: 'POST', json: parseCommand(json), signal }, machine),
    receipt: (q, signal) => api(`${root}/receipts/${encodeURIComponent(q.requestId)}?${query}`
      + `&operationId=${encodeURIComponent(q.operationId ?? '')}&commandDigest=${encodeURIComponent(q.commandDigest)}`, { signal }, machine),
    ask: (id, signal) => api(`${root}/asks/${encodeURIComponent(id)}?${query}`, { signal }, machine),
  };
}
/** Validate the coordinates used by editors against the trusted context; never infer a fence from a reply. */
export function assertExecView(view: ExecView, scope: TaskScope, featureId: string): ExecView {
  if (view.teamId !== scope.teamId || view.projectId !== scope.projectId || view.serviceGeneration !== scope.serviceGeneration
    || view.feature.id !== featureId || view.feature.authorityMode !== 'execution' || view.feature.epoch !== scope.epoch
    || !Number.isSafeInteger(view.feature.rev) || view.feature.rev < 1 || typeof view.feature.homeInstanceId !== 'string'
    || !view.capabilities || Array.isArray(view.capabilities) || typeof view.capabilities !== 'object'
    || Object.values(view.capabilities).some(c => !c || typeof c.enabled !== 'boolean' || typeof c.reason !== 'string')
    || !Number.isSafeInteger(view.serverSeq) || view.serverSeq < 0 || !Array.isArray(view.tasks) || !Array.isArray(view.pendingAsks)
    || view.tasks.some(t => t.featureId !== featureId) || view.pendingAsks.some(a => a.featureId !== featureId)) throw new Error('invalid_snapshot');
  return view;
}
export function execFailure(error: unknown): { ok: false; code: string; currentRev?: number; latest?: TaskCard | FeatureAnchor } {
  if (error instanceof ApiError && error.status === 409) return { ok: false, code: 'conflict',
    currentRev: typeof error.body.currentRev === 'number' ? error.body.currentRev : undefined,
    latest: error.body.latest as TaskCard | FeatureAnchor | undefined };
  return { ok: false, code: error instanceof ApiError ? error.code ?? 'unavailable' : 'unavailable' };
}
