/** TEAMDEPS1b [验收线 3] web read (null on every failure, abort rethrown) and [验收线 4] sharedProductBoard deps / links. */
import { expect, test } from 'bun:test';
import { readFeatureDeps, type FeatureDeps, type FeatureDepsTransport } from '../web/lib/api/shared-ledger-reads';
import { ApiError } from '../web/lib/api/client';
import { sharedProductBoard } from '../web/features/collab/dag/shared-product-model';
import type { FeatureList } from '../web/lib/api/shared-ledger';
import { FEATURE_DEPS_READ_FIXTURE } from '../src/lib/shared-ledger-contract-feature-deps-fixtures';
import { parseFeatureDeps, type FeatureDeps as ContractFeatureDeps } from '../src/lib/shared-ledger-contract-feature-deps';
import { SHARED_LEDGER_LIST_FIXTURE } from '../src/lib/shared-ledger-contract-fixtures';

// Hand-copied browser type, checked both ways against the contract type.
const deps: FeatureDeps = FEATURE_DEPS_READ_FIXTURE;
const back: ContractFeatureDeps = deps;
const identity = { team: 'team-a', project: 'project-a' };
const signal = new AbortController().signal;

function reader(answer: () => Promise<unknown>) {
  const calls: string[] = [];
  const t: FeatureDepsTransport = { featureDeps: async () => { calls.push('feature-deps'); return answer() as Promise<FeatureDeps>; } };
  return { read: (s = signal) => readFeatureDeps(identity, t, s), calls };
}
const quiet = <T>(run: () => Promise<T>) => {
  const warn = console.warn, warned: unknown[][] = [];
  console.warn = (...a: unknown[]) => { warned.push(a); };
  return run().finally(() => { console.warn = warn; }).then(value => ({ value, warned }));
};

test('[验收线 3] a valid read comes back rebuilt; extra keys dropped; other projects filtered', async () => {
  expect(back).toBe(deps);
  const other = { ...deps.edges[0]!, projectId: 'project-b' };
  const leaky = { ...deps, actor: 'x', edges: [...deps.edges.map(e => ({ ...e, note: 'repo:org/x', evidence: [] })), other] };
  const { read, calls } = reader(async () => leaky);
  expect(await read()).toEqual(deps);
  expect(calls).toEqual(['feature-deps']);
});

test('[验收线 3] old center 403 / 404 → null without a log', async () => {
  for (const status of [403, 404]) {
    const { read } = reader(async () => { throw new ApiError('forbidden', status, { code: 'forbidden' }); });
    const { value, warned } = await quiet(() => read());
    expect(value).toBeNull();
    expect(warned).toEqual([]);
  }
});

test('[验收线 3] 429 / 503 / offline / bad shapes / other team → null; warnings carry the status only', async () => {
  const edge = deps.edges[0]!;
  const fails: (() => Promise<unknown>)[] = [
    async () => { throw new ApiError('rate limited', 429); },
    async () => { throw new ApiError('unavailable', 503); },
    async () => { throw new TypeError('Failed to fetch'); },
    async () => null,
    async () => ({ ...deps, edges: 'x' }),
    async () => ({ ...deps, edges: [null] }),
    async () => ({ ...deps, schemaVersion: 2 }),
    async () => ({ ...deps, teamId: 'team-b' }),
    async () => ({ ...deps, updatedAt: -1 }),
    async () => ({ ...deps, edges: [{ ...edge, kind: 'lock' }] }),
    async () => ({ ...deps, edges: [{ ...edge, to: edge.from }] }),
    async () => ({ ...deps, edges: [edge, edge] }),
    async () => ({ ...deps, edges: [{ ...edge, count: 0 }] }),
    async () => ({ ...deps, edges: [{ ...edge, satisfied: 'yes' }] }),
    async () => ({ ...deps, edges: [{ ...edge, from: '' }] }),
    async () => ({ ...deps, edges: Array.from({ length: 2001 }, (_, i) => ({ ...edge, from: `feature-${i}` })) }),
  ];
  for (const fail of fails) {
    const { read } = reader(fail);
    const { value, warned } = await quiet(() => read());
    expect(value).toBeNull();
    expect(warned.every(a => /^shared ledger feature-deps unavailable \((\d+|no status)\)$/.test(String(a[0])))).toBe(true);
  }
  // The same shapes the contract rejects (the web copy agrees with the single schema).
  expect(() => parseFeatureDeps({ ...deps, edges: [{ ...edge, kind: 'lock' }] })).toThrow('invalid_field');
  const full = { ...deps, edges: Array.from({ length: 2000 }, (_, i) => ({ ...edge, from: `feature-${i}` })) };
  expect((await reader(async () => full).read())?.edges).toHaveLength(2000);
});

test('[验收线 3] no cache or backoff; an aborted signal rethrows', async () => {
  let n = 0;
  const { read, calls } = reader(async () => { if (n++ === 0) throw new ApiError('rate limited', 429); return deps; });
  await quiet(async () => {
    expect(await read()).toBeNull();
    expect(await read()).toEqual(deps);
  });
  expect(calls).toEqual(['feature-deps', 'feature-deps']);
  const ctrl = new AbortController();
  const aborted = reader(async () => { ctrl.abort(); throw new Error('aborted'); });
  await expect(aborted.read(ctrl.signal)).rejects.toThrow('aborted');
});

const base = SHARED_LEDGER_LIST_FIXTURE.features[0]!;
const list: FeatureList = { ...SHARED_LEDGER_LIST_FIXTURE, features: ['feature-a', 'feature-b', 'feature-c'].map(id => ({ ...base, id, title: id })) } as FeatureList;
const now = base.updatedAt;

test('[验收线 4] without deps the board is unchanged: deps: [] and no links', () => {
  for (const board of [sharedProductBoard(list, now), sharedProductBoard(list, now, undefined, undefined, null)]) {
    expect(board.deps).toEqual([]);
    expect('links' in board).toBe(false);
  }
});

test('[验收线 4] split / declared → deps, task → links with no note or evidence; unknown endpoints dropped', () => {
  const read: FeatureDeps = { ...deps, edges: [...deps.edges,
    { projectId: 'project-a', from: 'feature-gone', to: 'feature-a', kind: 'declared', satisfied: false, count: 1 },
    { projectId: 'project-a', from: 'feature-b', to: 'feature-gone', kind: 'task', satisfied: true, count: 4 }] };
  const board = sharedProductBoard(list, now, undefined, undefined, read);
  expect(board.deps).toEqual([
    { from: 'feature-a', to: 'feature-b', note: '', kind: 'declared', satisfied: false, count: 1 },
    { from: 'feature-b', to: 'feature-c', note: '', kind: 'split', satisfied: true, count: 1 },
  ]);
  expect(board.links).toEqual([{ from: 'feature-a', to: 'feature-c', note: '', kind: 'task', satisfied: false, count: 2, evidence: [] }]);
  expect(board.features).toEqual(sharedProductBoard(list, now).features);
});
