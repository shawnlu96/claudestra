import type { ExecCommand, ExecTransport } from '../../../../lib/api/shared-ledger-v2';
import type { ApprovalResult, ApprovalSubmission } from '../approve/approve-model';
import { ExecSubmission, type ExecPort } from './exec-model';

/** The TV1 source owns this session: closing a detail slot must not erase an ambiguous write. */
export class ExecSession {
  private submission: ExecSubmission;
  private atomicPending: ApprovalSubmission | null = null;
  private writing = false;
  private version = 0;
  private listeners = new Set<() => void>();
  constructor(transport: ExecTransport) { this.submission = new ExecSubmission(transport); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  get pending() { return !this.writing && !!(this.submission.pending || this.atomicPending); }
  get blocked() { return this.writing || !!(this.submission.pending || this.atomicPending); }
  private changed() { this.version++; for (const listener of this.listeners) listener(); }
  async submit(command: ExecCommand) {
    if (this.blocked) return { ok: false as const, code: 'unknown' };
    this.writing = true; this.changed();
    // A panel owns only read cancellation; an already sent write must settle even if its panel closes.
    try { return await this.submission.submit(command, new AbortController().signal); }
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
      return result;
    } catch {
      // The atomic port may have committed before losing its response; retain its exact receipt query.
      this.atomicPending = commands; return { ok: false, code: 'unknown' };
    } finally { this.writing = false; this.changed(); }
  }
  async receipt(port: ExecPort, signal: AbortSignal) {
    if (this.writing) return false;
    const atomic = this.atomicPending;
    const committed = atomic ? (await port.receiptApproval?.(atomic, signal))?.ok === true : await this.submission.receipt(signal);
    if (committed && this.atomicPending === atomic) this.atomicPending = null;
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
