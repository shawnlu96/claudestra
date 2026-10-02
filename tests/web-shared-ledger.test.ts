import { expect, test } from 'bun:test';
import { SharedLedgerSession, identityKey } from '../web/lib/api/shared-ledger';
import type { FeatureDetail, FeatureList, Transport, Identity, Command, Result, Receipt } from '../web/lib/api/shared-ledger';
import { makeDraft, rebaseDraft, resolveNodeConflict, rewrite, stale, progress, boardFeature } from '../web/features/collab/shared/shared-model';
import { SHARED_LEDGER_FEATURE_FIXTURE, SHARED_LEDGER_LIST_FIXTURE } from '../src/lib/shared-ledger-contract-fixtures';
import { fixtureDetail } from '../web/features/collab/shared/shared-fixture';
import type { SharedLedgerCommand } from '../src/lib/shared-ledger-contract';
// Assignment checks the duplicated browser DTO against the frozen wire contract, without a web/src import.
const detail: FeatureDetail = SHARED_LEDGER_FEATURE_FIXTURE;
const list: FeatureList = SHARED_LEDGER_LIST_FIXTURE;
const identity: Identity = { center: 'center', team: list.teamId, person: 'alice', project: detail.feature.projectId, machine: 'a' };
const transport = (overrides: Partial<Transport> = {}): Transport => ({
  list: async () => list, detail: async () => detail,
  command: async c => ({ schemaVersion: 1, requestId: c.requestId, commandDigest: 'digest', serverSeq: 41, committedAt: 1,
    result: { featureId: detail.feature.id, rev: 8, version: 2 } }),
  receipt: async requestId => ({ status: 'unknown', requestId }), ...overrides,
});
const editable = (): FeatureDetail => ({ ...structuredClone(detail), dag: { ...structuredClone(detail.dag), nodes: [
  ...structuredClone(detail.dag.nodes), { key: 'NEW', oneLine: 'New plan', deps: [detail.dag.nodes[0]!.key], fileGlobs: ['web/**'], estimate: '1h' },
] } });
test('409 retains editable draft; reread uses fresh CAS and preserves newly bound nodes', () => {
  const base = editable(), draft = makeDraft(base);
  draft.reason = 'Update plan'; draft.nodes[1]!.oneLine = 'My draft';
  const latest = structuredClone(base); latest.feature.rev++; latest.dag.version++;
  const conflict = { ...draft, latest };
  expect(conflict.nodes[1]!.oneLine).toBe('My draft');
  expect(() => rewrite(conflict)).toThrow('conflict_requires_reread');
  const reread = rebaseDraft(conflict, latest), command = rewrite(reread, 'test-request');
  const wire: SharedLedgerCommand = command;
  expect(wire.type).toBe('dag.rewrite');
  if ('nodes' in wire) { expect(wire.expectedRev).toBe(latest.feature.rev); expect(wire.nodes[1]!.oneLine).toBe('My draft'); }
  latest.dag.bindings.push({ nodeKey: 'NEW', taskId: 'new-bound' });
  const boundConflict = rebaseDraft(conflict, latest);
  expect(boundConflict.conflicts[0]!.mine!.oneLine).toBe('My draft');
  expect(() => rewrite(boundConflict)).toThrow('unresolved_node_conflicts');
  expect(resolveNodeConflict(boundConflict, 'NEW', 'latest').nodes.find(n => n.key === 'NEW')!.oneLine).toBe('New plan');
});
test('bound nodes cannot change or disappear; malformed dependencies cannot submit', () => {
  const draft = makeDraft(editable()); draft.reason = 'Rewrite';
  draft.nodes[0]!.deps = ['NEW'];
  expect(() => rewrite(draft)).toThrow('bound_node_locked');
  draft.nodes = draft.nodes.slice(1);
  expect(() => rewrite(draft)).toThrow('bound_node_locked');
  const cyclic = makeDraft(editable()); cyclic.reason = 'Rewrite'; cyclic.nodes[1]!.deps = ['NEW'];
  expect(() => rewrite(cyclic)).toThrow('cyclic_dependencies');
  cyclic.nodes[1]!.deps = ['absent']; expect(() => rewrite(cyclic)).toThrow('missing_dependency');
});
test('late requests and errors from old identity cannot populate new identity cache', async () => {
  let resolveOld!: (value: FeatureList) => void, oldSignal!: AbortSignal;
  const session = new SharedLedgerSession(identity, transport({ list: signal => { oldSignal = signal;
    return new Promise(resolve => { resolveOld = resolve; }); } }));
  const pending = session.list();
  const newIdentity = { ...identity, person: 'bob', machine: 'b' };
  session.switchIdentity(newIdentity, transport({ list: async () => ({ ...list, serverSeq: 99 }) }));
  expect(oldSignal.aborted).toBe(true);
  expect(session.cached()).toBeUndefined();
  await session.list(); resolveOld(list);
  expect(await pending).toBeUndefined(); expect(session.cached()!.serverSeq).toBe(99);
  expect(identityKey(newIdentity)).not.toBe(identityKey(identity));
  session.close();
});
test('same watermark preserves snapshot identity; rollback refetches whole snapshot; scope mismatch fails', async () => {
  let seq = 40, calls = 0;
  const session = new SharedLedgerSession(identity, transport({ list: async () => { calls++; return { ...list, serverSeq: seq }; } }));
  const first = await session.list(); expect(await session.list()).toBe(first);
  seq = 39; const rollback = await session.list(); expect(calls).toBe(4); expect(rollback!.serverSeq).toBe(39);
  session.switchIdentity({ ...identity, team: 'other' }, transport());
  await expect(session.list()).rejects.toThrow('invalid_snapshot'); session.close();
});
test('stale and missing mirrors never count as completed or satisfied', () => {
  const now = detail.feature.projection!.observedAt + 30_001;
  const f = { ...detail.feature, status: 'done' as const, counts: { total: 3, completed: 3, blocked: 0, missing: 1 } };
  expect(stale(f, now)).toBe(true); expect(progress(f, now)).toBe(0);
  expect(progress({ ...f, projection: null }, now)).toBe(2);
  const board = boardFeature({ ...detail, feature: f }, now);
  expect(board.counts.done).toBe(0); expect(board.nodes[0]!.missing).toBe(true);
  expect(board.status).not.toBe('done');
});
test('identity switching fences details; effect replay reactivates its controller', async () => {
  let finish!: (detail: FeatureDetail) => void;
  const session = new SharedLedgerSession(identity, transport({ detail: async () => new Promise(resolve => { finish = resolve; }) }));
  const pending = session.detail(detail.feature.id);
  session.switchIdentity({ ...identity, center: 'other' }, transport()); finish(detail);
  expect(await pending).toBeUndefined(); session.close(); session.activate(); expect(await session.list()).toBeDefined();
});
test('V1 wire capabilities disable every execution action', () => {
  for (const key of ['task.new', 'dag.bind', 'stage', 'approval']) expect(detail.capabilities[key]!.enabled).toBe(false);
  const command: Command = { type: 'feature.new', requestId: 'r', projectId: 'p', title: 'Title', description: 'D', homeInstanceId: 'home' };
  const wire: SharedLedgerCommand = command; expect(wire.requestId).toBe('r');
});

test('late mutation and receipt responses are also fenced after identity changes', async () => {
  let finishCommand!: (value: Result) => void, finishReceipt!: (value: Receipt) => void;
  const t = transport({ command: async () => new Promise(resolve => { finishCommand = resolve; }),
    receipt: async () => new Promise(resolve => { finishReceipt = resolve; }) });
  const session = new SharedLedgerSession(identity, t);
  const command: Command = { type: 'feature.new', requestId: 'r', projectId: 'p', title: 'Title', description: '', homeInstanceId: 'h' };
  const pendingCommand = session.submit(command), pendingReceipt = session.receipt('r');
  session.switchIdentity({ ...identity, person: 'another' }, transport());
  finishCommand(await transport().command(command, new AbortController().signal));
  finishReceipt({ status: 'unknown', requestId: 'r' });
  expect(await pendingCommand).toBeUndefined(); expect(await pendingReceipt).toBeUndefined(); session.close();
});

test('He probe: C1/C4/C5 + OTHER; teammate unbound addition survives and newly bound edit needs latest choice', () => {
  const base = structuredClone(fixtureDetail), draft = makeDraft(base); draft.reason = 'Probe';
  draft.nodes.find(n => n.key === 'C4')!.oneLine = 'my edit';
  const latest = structuredClone(base); latest.feature.rev++; latest.dag.version++;
  latest.dag.nodes.push({ key: 'OTHER', oneLine: 'Teammate addition', deps: ['C1'], fileGlobs: ['other/**'], estimate: '1h' });
  latest.dag.bindings.push({ nodeKey: 'C4', taskId: 'task-c4' });
  const reread = rebaseDraft({ ...draft, latest }, latest);
  expect(reread.nodes.map(n => n.key)).toEqual(['C1', 'C4', 'C5', 'OTHER']);
  expect(reread.conflicts).toHaveLength(1); expect(reread.conflicts[0]!.mine!.oneLine).toBe('my edit');
  expect(reread.conflicts[0]!.locked).toBe(true);
  expect(() => rewrite(reread)).toThrow('unresolved_node_conflicts');
  expect(() => resolveNodeConflict(reread, 'C4', 'mine')).toThrow('bound_node_locked');
  const resolved = resolveNodeConflict(reread, 'C4', 'latest');
  const command = rewrite(resolved, 'he-probe');
  if (!('nodes' in command)) throw new Error('wrong_command');
  expect(command.nodes.map(n => n.key)).toEqual(['C1', 'C4', 'C5', 'OTHER']);
  expect(command.nodes.find(n => n.key === 'C4')!.oneLine).toBe('团队总表与冲突草稿');
  expect(command.expectedRev).toBe(latest.feature.rev); expect(command.baseVersion).toBe(latest.dag.version);
});
test('replay keeps teammate additions, replays my uncontested edit, and resolves concurrent unbound edits explicitly', () => {
  const base = structuredClone(fixtureDetail), draft = makeDraft(base); draft.reason = 'Replay';
  draft.nodes[1]!.oneLine = 'My update';
  const latest = structuredClone(base); latest.feature.rev++; latest.dag.version++;
  latest.dag.nodes.push({ key: 'OTHER', oneLine: 'New node', deps: [], fileGlobs: ['other/**'], estimate: '' });
  const uncontested = rebaseDraft(draft, latest);
  expect(uncontested.conflicts).toEqual([]); expect(uncontested.nodes[1]!.oneLine).toBe('My update');
  expect('nodes' in rewrite(uncontested)).toBe(true);
  latest.dag.nodes[1]!.oneLine = 'Their update';
  const contested = rebaseDraft(draft, latest);
  expect(contested.conflicts).toHaveLength(1); expect(() => rewrite(contested)).toThrow('unresolved_node_conflicts');
  expect(resolveNodeConflict(contested, 'C4', 'mine').nodes[1]!.oneLine).toBe('My update');
  expect(resolveNodeConflict(contested, 'C4', 'latest').nodes[1]!.oneLine).toBe('Their update');
  expect(rebaseDraft(contested, latest).conflicts[0]!.mine!.oneLine).toBe('My update');
});
test('my deletion versus latest edit/binding is an explicit conflict; untouched latest deletion is retained', () => {
  const base = editable(), draft = makeDraft(base); draft.reason = 'Delete'; draft.nodes.pop();
  const latest = structuredClone(base); latest.feature.rev++; latest.dag.version++;
  expect(rebaseDraft(draft, latest).nodes.some(n => n.key === 'NEW')).toBe(false);
  latest.dag.nodes[1]!.estimate = '2h';
  const contested = rebaseDraft(draft, latest);
  expect(contested.conflicts[0]!.mine).toBeNull(); expect(contested.conflicts[0]!.latest!.estimate).toBe('2h');
  expect(() => rewrite(contested)).toThrow('unresolved_node_conflicts');
  expect(resolveNodeConflict(contested, 'NEW', 'mine').nodes.some(n => n.key === 'NEW')).toBe(false);
  expect(resolveNodeConflict(contested, 'NEW', 'latest').nodes.some(n => n.key === 'NEW')).toBe(true);
  latest.dag.bindings.push({ nodeKey: 'NEW', taskId: 'bound-new' });
  expect(rebaseDraft(draft, latest).conflicts[0]!.locked).toBe(true);
  const untouched = makeDraft(base); untouched.reason = 'Keep current'; latest.dag.nodes.pop(); latest.dag.bindings.pop();
  expect(rebaseDraft(untouched, latest).nodes.some(n => n.key === 'NEW')).toBe(false);
});
