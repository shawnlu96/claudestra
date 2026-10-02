import { expect, test } from 'bun:test';
import { parseAsk, parseCommand, parseProposal, v2ObjectDigest } from '../src/lib/shared-ledger-contract-v2';
import { V2_DTO_FIXTURES, V2_FIXTURE_FENCE, V2_FIXTURE_SCOPE } from '../src/lib/shared-ledger-contract-v2-fixtures';
import {
  approvalCommands, approvalStatus, beginApproval, bindDigest, canSign, canonicalJson, documentView, driftReasons,
  approvalKey, settleApproval, settleIfCurrent, signBlocker, startApproval, stateFor, type ApprovalAsk, type ApprovalProposal, type ApprovalView,
} from '../web/features/collab/shared/approve/approve-model';
import {
  approveFixtureDrifted, approveFixtureExpired, approveFixtureMember, approveFixtureMergeView, approveFixtureNow,
  approveFixtureOwner, approveFixtureRevoked, approveFixtureScope, approveFixtureScopeView,
} from '../web/features/collab/shared/approve/approve-fixture';

const now = approveFixtureNow, owner = approveFixtureOwner, member = approveFixtureMember;
const scope = { ...V2_FIXTURE_SCOPE, ...V2_FIXTURE_FENCE };
const ids = { answer: 'request-answer', decide: 'request-decide' };
const view = approveFixtureScopeView;
const idle = beginApproval();

test('fixtures are valid V2 DTOs so the model reads the frozen wire shape', () => {
  const ask = parseAsk({ ...V2_DTO_FIXTURES.ask.valid as object, ...view.ask, source: 'business', blocking: true,
    createdAt: 1000, answeredBy: null, answeredAt: null, answer: null, decision: null, auditEventSeq: 1, ...V2_FIXTURE_SCOPE });
  expect(ask.bind?.proposalDigest).toBe(view.ask.bind!.proposalDigest);
  const proposal = V2_DTO_FIXTURES.proposal.valid as ApprovalProposal;
  expect(parseProposal({ ...proposal }).state).toBe('pending');
  const wireAsk: ApprovalAsk = V2_DTO_FIXTURES.ask.valid as ApprovalAsk;
  expect(wireAsk.bind?.expiresAt).toBe(wireAsk.expiresAt);
});

test('owner scope approval binds proposal digest, base version and expiry in the request body', async () => {
  expect(approvalStatus(view, now)).toBe('open');
  const digest = await bindDigest(view.ask.bind!);
  expect(digest).toBe(v2ObjectDigest(view.ask.bind));
  expect(canonicalJson({ b: 1, a: [undefined, { d: 2, c: undefined }] })).toBe('{"a":[null,{"d":2}],"b":1}');
  const { answer, decide } = approvalCommands(idle, view, owner, scope, now, 'approved', digest, ids);
  const parsedAnswer = parseCommand(answer), parsedDecide = parseCommand(decide);
  if (parsedAnswer.type !== 'ask.answer' || parsedDecide?.type !== 'dag.decide') throw Error('wrong command');
  expect(parsedAnswer.payload).toEqual({ askId: 'ask', expectedRev: 1, bindDigest: digest,
    answer: { kind: 'option', optionId: 'approve' }, decision: 'approved' });
  expect(parsedDecide.payload).toEqual({ featureId: 'feature', expectedRev: 3, proposalId: 'proposal',
    proposalDigest: 'a'.repeat(64), baseVersion: 1, askId: 'ask', decision: 'approved' });
  for (const field of ['proposalDigest', 'baseVersion', 'expiresAt'] as const) {
    const changed = { ...view.ask.bind!, [field]: field === 'proposalDigest' ? 'f'.repeat(64) : view.ask.bind![field]! + 1 };
    expect(await bindDigest(changed)).not.toBe(digest);
  }
  const rejected = approvalCommands(idle, view, owner, scope, now, 'rejected', digest, ids);
  expect(rejected.answer.payload.answer).toEqual({ kind: 'option', optionId: 'reject' });
  expect(rejected.decide?.payload.decision).toBe('rejected');
});

test('business authorization without a proposal sends only the bound ask answer', async () => {
  const merge = approveFixtureMergeView, digest = await bindDigest(merge.ask.bind!);
  const result = approvalCommands(idle, merge, owner, scope, now, 'approved', digest, ids);
  expect(result.decide).toBeNull();
  expect(parseCommand(result.answer).type).toBe('ask.answer');
  expect(() => approvalCommands(idle, merge, owner, scope, now, 'approved', 'bad', ids)).toThrow('invalid_command_input');
  expect(() => approvalCommands(idle, merge, owner, scope, now, 'approved', digest, { answer: 'x', decide: 'x' }))
    .toThrow('invalid_command_input');
});

test('shared copy and redacted summary are labelled as such; the original is only at home', () => {
  const copy = documentView(approveFixtureMergeView.document);
  expect(copy).toMatchObject({ kind: 'copy', label: '共享副本', body: '批准共享的规格副本', original: '仅在主场' });
  expect(copy.sharedDigest).not.toBe(copy.originalDigest);
  const summary = documentView(view.document);
  expect(summary).toMatchObject({ kind: 'summary', label: '脱敏摘要', original: '仅在主场', sharedDigest: null });
  expect(documentView(null)).toMatchObject({ kind: 'none', body: '', original: '仅在主场' });
  for (const shown of [copy, summary]) expect(shown.label).not.toContain('原文');
  const swapped: ApprovalView = { ...approveFixtureMergeView, document: { ...approveFixtureMergeView.document!,
    copy: { ...approveFixtureMergeView.document!.copy!, sharedDigest: 'f'.repeat(64) } } };
  expect(driftReasons(swapped)).toEqual(['document']);
  expect(approvalStatus(swapped, now)).toBe('drifted');
});

test('drifted, expired and revoked asks disable signing and show their state', () => {
  expect(driftReasons(approveFixtureDrifted)).toEqual(['baseVersion']);
  expect(approvalStatus(approveFixtureDrifted, now)).toBe('drifted');
  expect(approvalStatus(approveFixtureExpired, now)).toBe('expired');
  expect(approvalStatus(view, view.ask.bind!.expiresAt)).toBe('expired');
  expect(approvalStatus(approveFixtureRevoked, now)).toBe('revoked');
  expect(approvalStatus({ ...view, proposal: { ...view.proposal!, state: 'void' } }, now)).toBe('revoked');
  expect(approvalStatus({ ...view, proposal: { ...view.proposal!, proposalDigest: 'f'.repeat(64) } }, now)).toBe('drifted');
  expect(approvalStatus({ ...view, proposal: null }, now)).toBe('drifted');
  expect(approvalStatus(approveFixtureMergeView, now)).toBe('open');
  expect(approvalStatus({ ...approveFixtureMergeView, task: { rev: 3, specRev: 1 } }, now)).toBe('drifted');
  expect(approvalStatus({ ...view, ask: { ...view.ask, state: 'answered' } }, now)).toBe('answered');
  expect(approvalStatus({ ...view, ask: { ...view.ask, kind: 'decide', bind: null } }, now)).toBe('unbound');
  for (const blocked of [approveFixtureDrifted, approveFixtureExpired, approveFixtureRevoked]) {
    expect(canSign(idle, blocked, owner, now, 'approved')).toBe(false);
    expect(signBlocker(blocked, owner, now)).toBe(approvalStatus(blocked, now));
    expect(() => approvalCommands(idle, blocked, owner, scope, now, 'approved', 'a'.repeat(64), ids)).toThrow('approval_disabled');
  }
});

test('a member sees the approval but cannot sign on the owner’s behalf', () => {
  expect(approvalStatus(view, now)).toBe('open');
  expect(canSign(idle, view, member, now, 'approved')).toBe(false);
  expect(canSign(idle, view, member, now, 'rejected')).toBe(false);
  expect(signBlocker(view, member, now)).toBe('not_owner');
  expect(() => approvalCommands(idle, view, member, scope, now, 'approved', 'a'.repeat(64), ids)).toThrow('approval_disabled');
  expect(canSign(idle, view, owner, now, 'approved')).toBe(true);
});

test('form state: normal success, disabled, and central refusal never pretends success', () => {
  const submitting = startApproval(stateFor(idle, view), 'approved', 'request-1');
  expect(canSign(submitting, view, owner, now, 'approved')).toBe(false);
  const saved = settleApproval(submitting, { ok: true });
  expect(saved).toEqual({ key: approvalKey(view), phase: 'saved', decision: 'approved', error: null, requestId: 'request-1' });
  expect(canSign(saved, view, owner, now, 'approved')).toBe(false);
  for (const code of ['authorization_expired', 'authorization_mismatch', 'conflict', 'pending_proposal']) {
    const refused = settleApproval(submitting, { ok: false, code });
    expect(refused).toMatchObject({ phase: 'rejected', decision: 'approved', error: code });
    expect(refused.phase).not.toBe('saved');
    expect(canSign(refused, approveFixtureDrifted, owner, now, 'approved')).toBe(false);
  }
  expect(settleApproval(submitting, new Error('network'))).toMatchObject({ phase: 'rejected', error: 'network' });
  expect(settleApproval(submitting, { ok: false, code: '' })).toMatchObject({ phase: 'rejected', error: 'unavailable' });
  const onlyApprove: ApprovalView = { ...view, ask: { ...view.ask, options: [{ id: 'approve', label: '批准' }] } };
  expect(canSign(idle, onlyApprove, owner, now, 'rejected')).toBe(false);
  const freeText: ApprovalView = { ...onlyApprove, ask: { ...onlyApprove.ask, allowText: true } };
  expect(canSign(idle, freeText, owner, now, 'rejected')).toBe(true);
});

test('approval state is scoped to the ask and its bind; late completions for another record are dropped', () => {
  const askB: ApprovalView = { ...view, ask: { ...view.ask, id: 'ask-b', title: 'NEW ASK B', state: 'cancelled' } };
  expect(approvalKey(askB)).not.toBe(approvalKey(view));
  for (const changed of [{ ...view.ask, rev: 2 }, { ...view.ask, bind: { ...view.ask.bind!, baseVersion: 2 } },
    { ...view.ask, bind: { ...view.ask.bind!, expiresAt: 99_999 } }, { ...view.ask, bind: { ...view.ask.bind!, proposalDigest: 'f'.repeat(64) } }])
    expect(approvalKey({ ...view, ask: changed })).not.toBe(approvalKey(view));
  // pending A, view switches to B, A resolves ok: B stays idle (and revoked), never "saved".
  const pendingA = startApproval(stateFor(idle, view), 'approved', 'request-a');
  expect(stateFor(pendingA, askB)).toEqual(beginApproval(approvalKey(askB)));
  const afterA = settleIfCurrent(pendingA, pendingA, { ok: true });
  expect(afterA).toMatchObject({ key: approvalKey(view), phase: 'saved' });
  expect(stateFor(afterA, askB).phase).toBe('idle');
  expect(canSign(afterA, askB, owner, now, 'approved')).toBe(false);
  expect(signBlocker(askB, owner, now)).toBe('revoked');
  // already saved A, switch to an open B: B is fresh and signable, A's success does not leak.
  const openB: ApprovalView = { ...approveFixtureMergeView };
  expect(stateFor(afterA, openB).phase).toBe('idle');
  expect(canSign(afterA, openB, owner, now, 'approved')).toBe(true);
  // B submitted meanwhile: A's late completion must not settle B's pending request.
  const pendingB = startApproval(stateFor(pendingA, openB), 'rejected', 'request-b');
  expect(settleIfCurrent(pendingB, pendingA, { ok: true })).toBe(pendingB);
  expect(settleIfCurrent(pendingB, pendingB, { ok: false, code: 'conflict' })).toMatchObject({ phase: 'rejected', error: 'conflict' });
  // a second click on the same record (new request id) supersedes the old completion too.
  const retry = startApproval(stateFor(idle, view), 'approved', 'request-a2');
  expect(settleIfCurrent(retry, pendingA, { ok: true })).toBe(retry);
  expect(settleIfCurrent(afterA, pendingA, { ok: false, code: 'conflict' })).toBe(afterA);
});

test('fixtures use only 本机 / peer A / peer B identities', async () => {
  const text = await Bun.file('web/features/collab/shared/approve/approve-fixture.ts').text();
  expect(text).not.toMatch(/https?:\/\/|(\d{1,3}\.){3}\d{1,3}|\/Users\//);
  expect(text).toContain("'peer-a': 'peer A'");
});
