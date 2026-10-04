import { expect, test } from 'bun:test';
import { READS_OFF, SharedLedgerReads } from '../web/lib/api/shared-ledger-reads';
import type { ExtCapabilities, FeatureActivity, FeatureVersions, ReadsTransport } from '../web/lib/api/shared-ledger-reads';
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
