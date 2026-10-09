import type { ExecCommand, ExecReceipt, ExecTransport, ReceiptQuery } from '../../../../lib/api/shared-ledger-v2';
import { parseCommand } from '../../../../lib/api/shared-ledger-v2-command';
import { execFailure } from '../../../../lib/api/shared-ledger-v2';
import { canonicalJson, type ApprovalViewer, type ApprovalSubmission, type ApprovalResult, type ApprovalView } from '../approve/approve-model';
import { sha256, type TaskScope } from '../task/task-model';

/** Supplied by the composition root from authenticated identity and local switch/fence, never a response body. */
export interface ExecContext {
  mode: 'off' | 'observe' | 'on'; localProjectId: string; scope: TaskScope; viewer: ApprovalViewer;
  repository: string; instanceNames: Readonly<Record<string, string>>;
}
export interface ExecPort {
  context(featureId: string): ExecContext | null;
  approvalView?(askId: string, signal: AbortSignal): Promise<ApprovalView>;
  submitApproval?(submission: ApprovalSubmission, signal: AbortSignal): Promise<ApprovalResult>;
  receiptApproval?(submission: ApprovalSubmission, signal: AbortSignal): Promise<ApprovalResult>;
}
export interface PendingExec { command: ExecCommand; query: ReceiptQuery }
export function confirmsReceipt(raw: unknown, pending: PendingExec): raw is ExecReceipt {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as ExecReceipt, c = pending.command;
  return r.schemaVersion === 2 && r.teamId === c.teamId && r.projectId === c.projectId && r.requestId === c.requestId
    && r.commandDigest === pending.query.commandDigest && r.command === c.type && r.serviceGeneration === c.serviceGeneration
    && Number.isSafeInteger(r.serverSeq) && r.serverSeq > 0 && r.result?.epoch === c.epoch
    && r.result.operationId === pending.query.operationId;
}
/** An ambiguous write holds its exact query until a receipt confirms it. No retry or automatic receipt request. */
export class ExecSubmission {
  pending: PendingExec | null = null;
  private busy = false;
  constructor(private transport: ExecTransport) {}
  async submit(command: ExecCommand, signal: AbortSignal) {
    if (this.busy || this.pending) return { ok: false as const, code: 'unknown' };
    try { parseCommand(command); } catch (cause) {
      // Local rejection cannot have committed; keep the editor writable and never create a receipt query.
      return { ok: false as const, code: 'invalid_field' };
    }
    this.busy = true;
    try {
      const query: ReceiptQuery = { teamId: command.teamId, projectId: command.projectId, requestId: command.requestId,
        operationId: null, commandDigest: await sha256(canonicalJson(command)) };
      this.pending = { command, query };
      const raw = await this.transport.command(command, signal);
      const receipt = raw && typeof raw === 'object' && 'status' in raw ? ('receipt' in raw && raw.status === 'committed' ? raw.receipt : null) : raw;
      if (!confirmsReceipt(receipt, this.pending)) return { ok: false as const, code: 'unknown' };
      this.pending = null;
      return { ok: true as const };
    } catch (error) {
      // A definite 4xx refusal is safe to edit; transport/5xx failures may already have committed.
      const result = execFailure(error);
      if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
        && error.status >= 400 && error.status < 500) { this.pending = null; return result; }
      return { ok: false as const, code: 'unknown' };
    } finally { this.busy = false; }
  }
  async receipt(signal: AbortSignal): Promise<boolean> {
    if (!this.pending) return false;
    const pending = this.pending, raw = await this.transport.receipt(pending.query, signal);
    const receipt = raw && typeof raw === 'object' && 'status' in raw ? ('receipt' in raw && raw.status === 'committed' ? raw.receipt : null) : raw;
    if (this.pending !== pending || !confirmsReceipt(receipt, pending)) return false;
    this.pending = null; return true;
  }
}
