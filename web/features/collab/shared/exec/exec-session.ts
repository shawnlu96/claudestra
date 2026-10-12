import type { ExecCommand, ExecTransport } from '../../../../lib/api/shared-ledger-v2';
import type { ApprovalResult, ApprovalSubmission } from '../approve/approve-model';
import { ExecSubmission, type ExecPort } from './exec-model';
import type { TaskScope } from '../task/task-model';

const scopeKey = (s: TaskScope) => JSON.stringify([s.teamId, s.projectId, s.serviceGeneration, s.epoch, s.bootId]);

/** The TV1 source owns this session: closing a detail slot must not erase an ambiguous write. */
export class ExecSession {
  private submission: ExecSubmission;
  private atomicPending: ApprovalSubmission | null = null;
  private writing = false;
  private version = 0;
  private confirmations = new Map<string, number>();
  private listeners = new Set<() => void>();
  constructor(transport: ExecTransport) { this.submission = new ExecSubmission(transport); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  confirmed(scope: TaskScope) { return this.confirmations.get(scopeKey(scope)) ?? 0; }
  private confirm(scope: TaskScope) {
    const key = scopeKey(scope);
    this.confirmations.set(key, this.confirmed(scope) + 1);
  }
  get pending() { return !this.writing && !!(this.submission.pending || this.atomicPending); }
  get blocked() { return this.writing || !!(this.submission.pending || this.atomicPending); }
  private changed() { this.version++; for (const listener of this.listeners) listener(); }
  async submit(command: ExecCommand) {
    if (this.blocked) return { ok: false as const, code: 'unknown' };
    this.writing = true; this.changed();
    // A panel owns only read cancellation; an already sent write must settle even if its panel closes.
    try {
      const result = await this.submission.submit(command, new AbortController().signal);
      if (result.ok) this.confirm(command);
      return result;
    }
    finally { this.writing = false; this.changed(); }
  }
  async approve(commands: ApprovalSubmission, submit: NonNullable<ExecPort['submitApproval']>): Promise<ApprovalResult> {
    if (this.blocked) return { ok: false, code: 'unknown' };
    this.writing = true; this.changed();
    try {
      const result = await submit(commands, new AbortController().signal);
      if (!result.ok && ['unknown', 'unavailable'].includes(result.code)) {
        this.atomicPending = commands; return { ok: false, code: 'unknown' };
      }
      if (result.ok) this.confirm(commands.answer);
      return result;
    } catch {
      // The atomic port may have committed before losing its response; retain its exact receipt query.
      this.atomicPending = commands; return { ok: false, code: 'unknown' };
    } finally { this.writing = false; this.changed(); }
  }
  async receipt(port: ExecPort, signal: AbortSignal) {
    if (this.writing) return false;
    const atomic = this.atomicPending, command = atomic?.answer ?? this.submission.pending?.command;
    const committed = atomic ? (await port.receiptApproval?.(atomic, signal))?.ok === true : await this.submission.receipt(signal);
    // Concurrent atomic receipt queries may confirm the same pending object only once.
    if (committed && this.atomicPending === atomic && command) { this.atomicPending = null; this.confirm(command); }
    this.changed(); return committed;
  }
}

/** Scoped to one decorated source, never a global cache that can leak across machines or principals. */
export class ExecSessions {
  private sessions = new Map<string, ExecSession>();
  constructor(private project: string) {}
  get(featureId: string, localProjectId: string, transport: ExecTransport) {
    const key = JSON.stringify([this.project, featureId, localProjectId]);
    let session = this.sessions.get(key);
    if (!session) { session = new ExecSession(transport); this.sessions.set(key, session); }
    return session;
  }
}
