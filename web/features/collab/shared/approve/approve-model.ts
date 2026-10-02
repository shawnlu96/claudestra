/** Browser-side V2 scope approval / business authorization. The center re-checks role, bind, expiry and versions. */
export type ApproveAction = 'scope.change' | 'home.change' | 'task.cancel' | 'merge' | 'deploy' | 'release' | 'artifact.share' | 'workflow.auto';
export interface ApprovalBind {
  taskId: string | null; featureId: string; taskRev: number | null; specRev: number | null; workflowRev: number | null;
  baseVersion: number; proposalDigest: string | null; head: string | null;
  originalDigest: string; sharedDigest: string; actionDigest: string; redactionVersion: number;
  actions: ApproveAction[]; homeInstanceId: string; expiresAt: number;
}
export interface ApprovalAsk {
  id: string; featureId: string; taskId: string | null; kind: 'decide' | 'authorize' | 'owner_action' | 'accept';
  title: string; context: string; options: { id: string; label: string }[]; allowText: boolean; bind: ApprovalBind | null;
  state: 'open' | 'answered' | 'expired' | 'cancelled'; rev: number; createdBy: string; expiresAt: number;
}
export interface ApprovalProposal {
  id: string; featureId: string; baseVersion: number; version: number; reasonText: string;
  nodes: { key: string; oneLine: string }[]; cancels: string[]; scopeChange: boolean; proposalDigest: string;
  expiresAt: number; askId: string; state: 'pending' | 'approved' | 'rejected' | 'void' | 'expired';
}
/** Shared material: the approved copy (immutable artifact) or the redacted summary. The original never leaves home. */
export interface ApprovalDocument {
  summary: string; originalDigest: string;
  copy: { artifactId: string; sharedDigest: string; redactionVersion: number; content: string; visibility: 'approved_copy' } | null;
}
export interface ApprovalView {
  ask: ApprovalAsk; proposal: ApprovalProposal | null; document: ApprovalDocument | null;
  feature: { id: string; rev: number; currentVersion: number }; task: { rev: number; specRev: number } | null;
}
export interface ApprovalViewer { role: 'owner' | 'member'; instanceId: string }
export interface ApprovalScope { teamId: string; projectId: string; serviceGeneration: number; epoch: number; bootId: string }
export type ApprovalStatus = 'open' | 'drifted' | 'expired' | 'revoked' | 'answered' | 'unbound';
export type Decision = 'approved' | 'rejected';
export interface ApprovalState { phase: 'idle' | 'submitting' | 'rejected' | 'saved'; decision: Decision | null; error: string | null }
export type ApprovalResult = { ok: true } | { ok: false; code: string };

const required = (ok: boolean, code: string): void => { if (!ok) throw new Error(code); };
const validDigest = (value: string) => /^[a-f0-9]{64}$/.test(value);
const validId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);

/** Drift = anything the owner would be signing no longer matches what the bind recorded. */
export function driftReasons(view: ApprovalView): string[] {
  const { ask, proposal, document, feature, task } = view, bind = ask.bind;
  if (!bind) return [];
  const reasons: string[] = [];
  if (bind.featureId !== feature.id || ask.featureId !== feature.id) reasons.push('feature');
  if (bind.baseVersion !== feature.currentVersion) reasons.push('baseVersion');
  if (bind.actions.includes('scope.change')) {
    if (!proposal) reasons.push('proposal');
    else if (proposal.askId !== ask.id || proposal.featureId !== feature.id || proposal.proposalDigest !== bind.proposalDigest
      || proposal.baseVersion !== bind.baseVersion || proposal.expiresAt !== bind.expiresAt) reasons.push('proposal');
  }
  if (bind.taskId !== null && (!task || task.rev !== bind.taskRev || task.specRev !== bind.specRev)) reasons.push('task');
  if (document && (document.originalDigest !== bind.originalDigest
    || (document.copy !== null && (document.copy.sharedDigest !== bind.sharedDigest
      || document.copy.redactionVersion !== bind.redactionVersion)))) reasons.push('document');
  return reasons;
}

/** Precedence: revoked > answered > expired > drifted > open. Expiry uses the earliest of ask/bind/proposal. */
export function approvalStatus(view: ApprovalView, now: number): ApprovalStatus {
  const { ask, proposal } = view;
  if (ask.state === 'cancelled' || proposal?.state === 'void') return 'revoked';
  if (ask.state === 'answered' || proposal?.state === 'approved' || proposal?.state === 'rejected') return 'answered';
  if (ask.kind !== 'authorize' || !ask.bind) return 'unbound';
  const deadline = Math.min(ask.expiresAt, ask.bind.expiresAt, proposal?.expiresAt ?? Infinity);
  if (ask.state === 'expired' || proposal?.state === 'expired' || now >= deadline) return 'expired';
  return driftReasons(view).length > 0 ? 'drifted' : 'open';
}

/** The ask's answer for a decision: a matching option id, else free text when allowed, else not answerable. */
export function answerFor(ask: ApprovalAsk, decision: Decision): { kind: 'option'; optionId: string } | { kind: 'text'; text: string } | null {
  const ids = decision === 'approved' ? ['approve', 'approved', 'yes'] : ['reject', 'rejected', 'no'];
  const option = ask.options.find(o => ids.includes(o.id));
  if (option) return { kind: 'option', optionId: option.id };
  return ask.allowText ? { kind: 'text', text: decision === 'approved' ? '批准' : '驳回' } : null;
}

export const beginApproval = (): ApprovalState => ({ phase: 'idle', decision: null, error: null });
/** Members see everything but cannot sign; only an open, current bind is signable and never twice. */
export function canSign(state: ApprovalState, view: ApprovalView, viewer: ApprovalViewer, now: number, decision: Decision): boolean {
  return viewer.role === 'owner' && state.phase !== 'submitting' && state.phase !== 'saved'
    && approvalStatus(view, now) === 'open' && answerFor(view.ask, decision) !== null;
}
export function signBlocker(view: ApprovalView, viewer: ApprovalViewer, now: number): string | null {
  if (viewer.role !== 'owner') return 'not_owner';
  const status = approvalStatus(view, now);
  return status === 'open' ? null : status;
}

/**
 * The exact signed request. ask.answer carries bindDigest = sha256(canonical bind), which covers proposalDigest,
 * baseVersion and expiresAt together; a scope change also carries dag.decide with the proposal digest and base version.
 * X12 applies both in one transaction; neither is sent alone for a scope change.
 */
export function approvalCommands(state: ApprovalState, view: ApprovalView, viewer: ApprovalViewer, scope: ApprovalScope,
  now: number, decision: Decision, digestOfBind: string, requestIds: { answer: string; decide: string }) {
  required(canSign(state, view, viewer, now, decision), 'approval_disabled');
  required(validDigest(digestOfBind) && validId(requestIds.answer) && validId(requestIds.decide)
    && requestIds.answer !== requestIds.decide, 'invalid_command_input');
  const ask = view.ask, bind = ask.bind!, answer = answerFor(ask, decision)!;
  const answerCommand = { ...scope, requestId: requestIds.answer, type: 'ask.answer' as const,
    payload: { askId: ask.id, expectedRev: ask.rev, bindDigest: digestOfBind, answer, decision } };
  if (!bind.actions.includes('scope.change')) return { answer: answerCommand, decide: null };
  const proposal = view.proposal!;
  const decideCommand = { ...scope, requestId: requestIds.decide, type: 'dag.decide' as const,
    payload: { featureId: view.feature.id, expectedRev: view.feature.rev, proposalId: proposal.id,
      proposalDigest: bind.proposalDigest!, baseVersion: bind.baseVersion, askId: ask.id, decision } };
  return { answer: answerCommand, decide: decideCommand };
}
export type ApprovalSubmission = ReturnType<typeof approvalCommands>;

/** Only an explicit center acceptance counts; every refusal or transport failure stays visible as a failure. */
export function settleApproval(state: ApprovalState, result: ApprovalResult | Error): ApprovalState {
  if (result instanceof Error) return { ...state, phase: 'rejected', error: result.message || 'unavailable' };
  return result.ok ? { ...state, phase: 'saved', error: null } : { ...state, phase: 'rejected', error: result.code || 'unavailable' };
}
export const startApproval = (state: ApprovalState, decision: Decision): ApprovalState =>
  ({ phase: 'submitting', decision, error: null });

/** Shared copy / redacted summary are labelled as such; the full original is only ever "仅在主场". */
export function documentView(document: ApprovalDocument | null) {
  if (!document) return { kind: 'none' as const, label: '无共享材料', body: '', original: '仅在主场', originalDigest: null, sharedDigest: null };
  if (document.copy) return { kind: 'copy' as const, label: '共享副本', body: document.copy.content, original: '仅在主场',
    originalDigest: document.originalDigest, sharedDigest: document.copy.sharedDigest };
  return { kind: 'summary' as const, label: '脱敏摘要', body: document.summary, original: '仅在主场',
    originalDigest: document.originalDigest, sharedDigest: null };
}

/** Same canonical form as src/lib/ask-bind canonicalJson (sorted keys, undefined dropped); web cannot import src. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
export async function bindDigest(bind: ApprovalBind): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(bind)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
export const shortDigest = (digest: string | null): string => digest === null ? '—' : digest.slice(0, 12);
