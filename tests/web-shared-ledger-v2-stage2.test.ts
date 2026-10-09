import { expect, test } from 'bun:test';
import { parseCommand as parseMirror } from '../web/lib/api/shared-ledger-v2-command';
import { parseCommand, v2ObjectDigest } from '../src/lib/shared-ledger-contract-v2';
import { taskCommand, beginEditor } from '../web/features/collab/shared/task/task-model';
import { taskFixtureCapabilities, taskFixtureCreate, taskFixtureScope } from '../web/features/collab/shared/task/task-fixture';
import { ExecSubmission } from '../web/features/collab/shared/exec/exec-model';
import type { ExecCommand, ExecTransport } from '../web/lib/api/shared-ledger-v2';
import { approvalCommands, beginApproval, bindDigest } from '../web/features/collab/shared/approve/approve-model';
import { approveFixtureMergeView, approveFixtureOwner, approveFixtureScope } from '../web/features/collab/shared/approve/approve-fixture';
import { ApiError } from '../web/lib/api/client';
const command = () => taskCommand(beginEditor({ ...taskFixtureCreate, title: 'Synthetic task' }), taskFixtureCapabilities,
  taskFixtureScope, 'a'.repeat(64), 'request-1');
const signal = new AbortController().signal;
export function stage2Receipt(c: ExecCommand) {
  return { schemaVersion: 2, teamId: c.teamId, projectId: c.projectId, requestId: c.requestId, commandDigest: v2ObjectDigest(c),
    command: c.type, serviceGeneration: c.serviceGeneration, serverSeq: 42, result: { epoch: c.epoch, operationId: null } };
}
function transport(send: ExecTransport['command'], receipt: ExecTransport['receipt'] = async () => ({ status: 'unknown' })): ExecTransport {
  return { command: send, receipt, snapshot: async () => { throw new Error('unused'); }, ask: async () => { throw new Error('unused'); } };
}
test('stage2 editor body passes browser mirror and frozen parseCommand, identity fields are refused', () => {
  const c = command();
  expect(v2ObjectDigest(parseMirror(c))).toBe(v2ObjectDigest(parseCommand(c)));
  for (const field of ['actor', 'role']) expect(() => parseMirror({ ...c, [field]: 'owner' })).toThrow();
  expect(() => parseMirror({ ...c, payload: { ...c.payload, stage: 'build' } })).toThrow();
});
test('stage2 unknown submission only queries the exact receipt; a second submit never writes', async () => {
  let posts = 0, reads = 0;
  const c = command(), tx = new ExecSubmission(transport(async () => { posts++; throw new Error('lost response'); }, async q => {
    reads++; expect(q).toEqual({ teamId: c.teamId, projectId: c.projectId, requestId: c.requestId,
      operationId: null, commandDigest: v2ObjectDigest(c) });
    return { status: 'committed', receipt: stage2Receipt(c) };
  }));
  expect(await tx.submit(c, signal)).toEqual({ ok: false, code: 'unknown' });
  expect(await tx.submit(c, signal)).toEqual({ ok: false, code: 'unknown' });
  expect([posts, reads]).toEqual([1, 0]);
  expect(await tx.receipt(signal)).toBe(true);
  expect([posts, reads]).toEqual([1, 1]);
});
test('stage2 mismatched receipt cannot clear an unknown write', async () => {
  const c = command(), tx = new ExecSubmission(transport(async () => ({}), async () => ({
    status: 'committed', receipt: { ...stage2Receipt(c), requestId: 'other' },
  })));
  expect((await tx.submit(c, signal)).ok).toBe(false);
  expect(await tx.receipt(signal)).toBe(false);
  expect(tx.pending?.command).toEqual(c);
});
test('stage2 conflict is definite and retains the latest feature for the existing X10 state', async () => {
  const latest = { ...taskFixtureCreate.feature, rev: 8 };
  const tx = new ExecSubmission(transport(async () => { throw new ApiError('conflict', 409, { latest, currentRev: 8 }); }));
  expect(await tx.submit(command(), signal)).toEqual({ ok: false, code: 'conflict', latest, currentRev: 8 });
  expect(tx.pending).toBeNull();
});

test('stage2 owner authorization body passes both command parsers without actor or role', async () => {
  const c = approvalCommands(beginApproval(), approveFixtureMergeView, approveFixtureOwner, approveFixtureScope,
    50000, 'approved', await bindDigest(approveFixtureMergeView.ask.bind!), { answer: 'answer-request', decide: 'decide-request' }).answer;
  expect(v2ObjectDigest(parseMirror(c))).toBe(v2ObjectDigest(parseCommand(c)));
});


test('stage2 local validation refuses before transport and permits a corrected submission', async () => {
  let posts = 0;
  const tx = new ExecSubmission(transport(async c => { posts++; parseMirror(c); return stage2Receipt(c); }));
  const bad = { ...command(), requestId: '' };
  expect(await tx.submit(bad, signal)).toEqual({ ok: false, code: 'invalid_field' });
  expect(tx.pending).toBeNull(); expect(posts).toBe(0);
  expect(await tx.submit(command(), signal)).toEqual({ ok: true }); expect(posts).toBe(1);
});

test('stage2 browser text validation matches frozen control-character rules', () => {
  for (const code of [...Array.from({ length: 32 }, (_, i) => i), 127]) {
    const title = `title${String.fromCharCode(code)}text`, c = command();
    const candidate = { ...c, payload: { ...c.payload, title } };
    if ([9, 10, 13].includes(code)) {
      expect(v2ObjectDigest(parseMirror(candidate))).toBe(v2ObjectDigest(parseCommand(candidate)));
    } else {
      expect(() => parseCommand(candidate)).toThrow(); expect(() => parseMirror(candidate)).toThrow();
    }
  }
});
