import { expect, test } from 'bun:test';
import { READS_OFF, SharedLedgerReads } from '../web/lib/api/shared-ledger-reads';
import type { ExtCapabilities, FeatureActivity, FeatureVersions, ReadsTransport, TaskFacts } from '../web/lib/api/shared-ledger-reads';
import { ApiError } from '../web/lib/api/client';
import { TASK_FACTS_FIXTURE } from '../src/lib/shared-ledger-contract-task-facts-fixtures';
import type { SharedLedgerTaskFacts } from '../src/lib/shared-ledger-contract-task-facts';
import {
  SHARED_LEDGER_ACTIVITY_FIXTURE, SHARED_LEDGER_EXT_CAPABILITIES_NEW_FIXTURE, SHARED_LEDGER_EXT_CAPABILITIES_READONLY_FIXTURE,
  SHARED_LEDGER_VERSIONS_FIXTURE,
} from '../src/lib/shared-ledger-contract-fixtures';
import { EXT_CAPABILITIES_OFF, type SharedLedgerExtCapabilities, type SharedLedgerFeatureActivity, type SharedLedgerFeatureVersions } from '../src/lib/shared-ledger-contract-reads';

// Assignment both ways checks the browser DTOs against the single src schema types, without a web/src import.
const caps: ExtCapabilities = SHARED_LEDGER_EXT_CAPABILITIES_NEW_FIXTURE;
const versions: FeatureVersions = SHARED_LEDGER_VERSIONS_FIXTURE;
const activity: FeatureActivity = SHARED_LEDGER_ACTIVITY_FIXTURE;
const back: [SharedLedgerExtCapabilities, SharedLedgerFeatureVersions, SharedLedgerFeatureActivity] = [caps, versions, activity];
const identity = { team: 'team-a', project: 'project-a' };
const signal = new AbortController().signal;

function transport(extCapabilities: () => Promise<ExtCapabilities>) {
  const calls: string[] = [];
  const t: ReadsTransport = {
    extCapabilities: async () => { calls.push('caps'); return extCapabilities(); },
    versions: async id => { calls.push(`versions:${id}`); return versions; },
    activity: async (id, after) => { calls.push(`activity:${id}:${after}`); return activity; },
    taskFacts: async id => { calls.push(`task-facts:${id}`); return facts; },
  };
  return { t, calls };
}

test('browser all-off equals the contract constant minus teamId', () => {
  expect(back).toHaveLength(3);
  const { schemaVersion: _s, ...off } = EXT_CAPABILITIES_OFF;
  expect(READS_OFF).toEqual(off);
});

test('capability off (old center 404 → all-off, or any read error) sends no versions/activity request', async () => {
  const failures: (() => Promise<ExtCapabilities>)[] = [
    async () => ({ ...EXT_CAPABILITIES_OFF, teamId: 'team-a' }),
    async () => { throw new Error('HTTP 503'); },
    async () => ({ ...caps, teamId: 'team-b' }),
  ];
  for (const fail of failures) {
    const { t, calls } = transport(fail);
    const reads = new SharedLedgerReads(identity, t);
    expect(await reads.capabilities(signal)).toEqual(READS_OFF);
    expect(await reads.versions('feature-a', signal)).toBeNull();
    expect(await reads.activity('feature-a', 0, signal)).toBeNull();
    expect(calls.every(c => c === 'caps')).toBe(true);
  }
});

test('read-only center: reads go out, uploads stay false; capabilities are asked once', async () => {
  const { t, calls } = transport(async () => SHARED_LEDGER_EXT_CAPABILITIES_READONLY_FIXTURE);
  const reads = new SharedLedgerReads(identity, t);
  expect(await reads.versions('feature-a', signal)).toEqual(versions);
  expect(await reads.activity('feature-a', 7, signal)).toEqual(activity);
  expect((await reads.capabilities(signal)).uploads.projectionExt1).toBe(false);
  expect(calls).toEqual(['caps', 'versions:feature-a', 'activity:feature-a:7']);
});

test('only the advertised read is sent; bad cursors and foreign projects are refused', async () => {
  const { t, calls } = transport(async () => ({ ...caps, reads: { ...caps.reads, activity: false } }));
  const reads = new SharedLedgerReads(identity, t);
  expect(await reads.activity('feature-a', 0, signal)).toBeNull();
  expect(await reads.versions('feature-a', signal)).toEqual(versions);
  for (const after of [-1, 0.5, 2 ** 53]) await expect(reads.activity('feature-a', after, signal)).rejects.toThrow('invalid_cursor');
  expect(calls).toEqual(['caps', 'versions:feature-a']);
  const foreign = new SharedLedgerReads({ team: 'team-a', project: 'project-b' }, transport(async () => caps).t);
  await expect(foreign.versions('feature-a', signal)).rejects.toThrow('invalid_snapshot');
});

test('an aborted capability read propagates instead of turning into all-off', async () => {
  const ctrl = new AbortController();
  const reads = new SharedLedgerReads(identity, transport(async () => { ctrl.abort(); throw new Error('aborted'); }).t);
  await expect(reads.capabilities(ctrl.signal)).rejects.toThrow('aborted');
});

// task-facts: hand-copied browser type, checked both ways against the contract type.
const facts: TaskFacts = TASK_FACTS_FIXTURE;
const factsBack: SharedLedgerTaskFacts = facts;
function factsTransport(answer: () => Promise<unknown>) {
  const calls: string[] = [];
  const { t } = transport(async () => { throw new Error('ext-capabilities must not be asked'); });
  const ft: ReadsTransport = { ...t,
    extCapabilities: async () => { calls.push('caps'); throw new Error('unexpected'); },
    taskFacts: async id => { calls.push(`task-facts:${id}`); return answer() as Promise<TaskFacts>; } };
  return { reads: new SharedLedgerReads(identity, ft), calls };
}
const quiet = <T>(run: () => Promise<T>) => {
  const warn = console.warn, warned: unknown[][] = [];
  console.warn = (...a: unknown[]) => { warned.push(a); };
  return run().finally(() => { console.warn = warn; }).then(value => ({ value, warned }));
};

test('[验收线 4] old center 403 → null, no throw, no ext-capabilities request, no log', async () => {
  expect(factsBack).toBe(facts);
  const { reads, calls } = factsTransport(async () => { throw new ApiError('forbidden', 403, { code: 'forbidden' }); });
  const { value, warned } = await quiet(() => reads.taskFacts('feature-a', signal));
  expect(value).toBeNull();
  expect(calls).toEqual(['task-facts:feature-a']);
  expect(warned).toEqual([]);
});

test('[验收线 4] 429 / 503 / offline / bad shape / other team-project-feature → null; extra keys dropped', async () => {
  const fails: (() => Promise<unknown>)[] = [
    async () => { throw new ApiError('rate limited', 429); },
    async () => { throw new ApiError('unavailable', 503); },
    async () => { throw new TypeError('Failed to fetch'); },
    async () => ({ ...facts, tasks: 'x' }),
    async () => ({ ...facts, tasks: [{ ...facts.tasks[0]!, lastEvent: { at: 0, kind: 'stage' } }] }),
    async () => ({ ...facts, tasks: [null] }),
    async () => ({ ...facts, teamId: 'team-b' }),
    async () => ({ ...facts, projectId: 'project-b' }),
    async () => ({ ...facts, featureId: 'feature-b' }),
  ];
  for (const fail of fails) {
    const { reads } = factsTransport(fail);
    const { value, warned } = await quiet(() => reads.taskFacts('feature-a', signal));
    expect(value).toBeNull();
    expect(warned.every(a => !/team-b|project-b|feature-b|Failed/.test(String(a[0])))).toBe(true);
  }
  const leaky = { ...facts, actor: 'x', tasks: facts.tasks.map(t => ({ ...t, text: '原文', lastEvent: t.lastEvent && { ...t.lastEvent, summary: 's' } })) };
  const { reads } = factsTransport(async () => leaky);
  expect(await reads.taskFacts('feature-a', signal)).toEqual(facts);
});

test('[验收线 4] no backoff or cache: a call right after 429 goes out again; aborted signal throws', async () => {
  let n = 0;
  const { reads, calls } = factsTransport(async () => { if (n++ === 0) throw new ApiError('rate limited', 429); return facts; });
  await quiet(async () => {
    expect(await reads.taskFacts('feature-a', signal)).toBeNull();
    expect(await reads.taskFacts('feature-a', signal)).toEqual(facts);
    expect(await reads.taskFacts('feature-a', signal)).toEqual(facts);
  });
  expect(calls).toEqual(['task-facts:feature-a', 'task-facts:feature-a', 'task-facts:feature-a']);
  const ctrl = new AbortController();
  const aborted = factsTransport(async () => { ctrl.abort(); throw new Error('aborted'); });
  await expect(aborted.reads.taskFacts('feature-a', ctrl.signal)).rejects.toThrow('aborted');
});
