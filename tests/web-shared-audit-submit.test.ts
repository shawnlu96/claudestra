import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createRequire } from 'node:module';
import { ApiError } from '../web/lib/api/client';
import { SharedLedgerSession, type Command, type Result, type Transport } from '../web/lib/api/shared-ledger';
import { generateTeamFixture } from '../web/features/collab/shared/team-fixture-gen';
import { makeDraft, rewrite } from '../web/features/collab/shared/shared-model';

const requireWeb = createRequire(new URL('../web/package.json', import.meta.url));
const React = requireWeb('react');
let dom: ReturnType<typeof requireWeb>, useSubmission: any;
const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousAct: boolean | undefined;
beforeAll(async () => {
  GlobalRegistrator.register(); previousAct = actEnv.IS_REACT_ACT_ENVIRONMENT; actEnv.IS_REACT_ACT_ENVIRONMENT = true;
  dom = requireWeb('react-dom/client');
  const path = '../web/features/collab/shared/use-shared-submission.ts';
  useSubmission = (await import(path)).useSharedSubmission;
});
afterAll(async () => {
  if (previousAct === undefined) delete actEnv.IS_REACT_ACT_ENVIRONMENT; else actEnv.IS_REACT_ACT_ENVIRONMENT = previousAct;
  await GlobalRegistrator.unregister();
});

async function fixture(run: (f: any) => Promise<void>) {
  const fx = generateTeamFixture(), base = fx.details.at(-1)!, draft = makeDraft(base);
  draft.reason = 'audit submit'; draft.nodes.find(n => !base.dag.bindings.some(b => b.nodeKey === n.key))!.oneLine = 'Preserved draft';
  const command = rewrite(draft), identity = { center: 'fixture', team: fx.team, project: fx.project, person: 'person-a', machine: 'local' };
  const result: Result = { schemaVersion: 1, requestId: command.requestId, commandDigest: 'fixture', serverSeq: 41,
    committedAt: fx.now, result: { featureId: base.feature.id, rev: base.feature.rev + 1, version: base.feature.version + 1 } };
  const next = { ...base, feature: { ...base.feature, rev: result.result.rev, version: result.result.version } };
  const calls = { commands: [] as Command[], details: [] as string[], receipts: [] as string[], refresh: 0, open: 0 };
  const failures = { command: null as unknown, detail: null as unknown, refresh: null as unknown, gate: null as Promise<void> | null };
  const transport: Transport = {
    list: async () => fx.list,
    detail: async id => { calls.details.push(id); if (failures.gate) await failures.gate; if (failures.detail) throw failures.detail; return next; },
    command: async c => { calls.commands.push(c); if (failures.command) throw failures.command; return result; },
    receipt: async id => { calls.receipts.push(id); return { status: 'committed', receipt: result }; },
  };
  const session = new SharedLedgerSession(identity, transport);
  let state: any, ops: any;
  function Harness() {
    const [detail, setDetail] = React.useState(base), [currentDraft, setDraft] = React.useState(draft);
    const [pendingRequest, setPending] = React.useState(null), [error, setError] = React.useState(null);
    const [busy, setBusy] = React.useState(false), [creating, setCreating] = React.useState(false);
    const [previous, setPrevious] = React.useState(undefined);
    const selected = React.useRef(base.feature.id), alive = React.useRef(true);
    React.useEffect(() => () => { alive.current = false; }, []);
    ops = useSubmission({ session, identity, detail, pendingRequest, tr: (s: string) => s, alive, selected,
      setDetail, setDraft, setPending, setError, setBusy, setCreating, setPrevious,
      refresh: async () => { calls.refresh++; if (failures.refresh) throw failures.refresh; }, open: async () => { calls.open++; } });
    state = { detail, draft: currentDraft, pendingRequest, error, busy, creating, previous, selected };
    return null;
  }
  const document = (globalThis as any).document, host = document.createElement('div'); document.body.appendChild(host);
  const root = dom.createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    await run({ calls, failures, base, next, draft, command, state: () => state,
      submit: () => React.act(async () => ops.submit(command)), receipt: () => React.act(async () => ops.receipt()),
      retry: () => React.act(async () => ops.retry()), ops: () => ops });
  } finally { await React.act(async () => root.unmount()); session.close(); host.remove(); }
}

const failedRead = () => new ApiError('fixture failed', 500, {});
test('confirmed submit clears draft, retains selection and refreshes overview despite rejected detail', async () => {
  await fixture(async f => {
    f.failures.detail = failedRead(); await f.submit();
    expect(f.state().draft).toBeNull(); expect(f.state().pendingRequest).toBeNull();
    expect(f.state().error).toBe('已保存，详情刷新失败');
    expect(f.state().selected.current).toBe(f.base.feature.id); expect(f.calls.refresh).toBe(1);
    expect(f.state().previous).toEqual(f.base); expect(f.state().busy).toBe(false);
    f.failures.detail = null; await f.retry();
    expect(f.state().error).toBeNull(); expect(f.state().detail).toEqual(f.next);
    expect(f.state().draft).toBeNull(); expect(f.calls.commands).toEqual([f.command]);
    expect(f.calls.details).toEqual([f.base.feature.id, f.base.feature.id]); expect(f.calls.refresh).toBe(2);
  });
});

test('overview rejection is a refresh failure and never makes the confirmed command unknown', async () => {
  await fixture(async f => {
    f.failures.refresh = failedRead(); await f.submit();
    expect(f.state().draft).toBeNull(); expect(f.state().pendingRequest).toBeNull();
    expect(f.state().detail).toEqual(f.next); expect(f.state().error).toBe('已保存，总览刷新失败');
    f.failures.refresh = null; await f.retry();
    expect(f.state().error).toBeNull(); expect(f.calls.commands).toEqual([f.command]);
  });
});

for (const error of [new Error('connection lost'), failedRead(), new ApiError('network', 0, {}),
  new ApiError('bad json', 200, {}, 'invalid_json'), new ApiError('body lost', 200, {}, 'body_read_failed')]) {
  test(`ambiguous command keeps exact draft/request and only queries receipt: ${error.message}`, async () => {
    await fixture(async f => {
      f.failures.command = error; await f.submit();
      expect(f.state().draft).toEqual(f.draft); expect(f.state().pendingRequest).toBe(f.command.requestId);
      await f.submit(); expect(f.calls.commands).toEqual([f.command]);
      f.failures.detail = failedRead(); await f.receipt();
      expect(f.calls.receipts).toEqual([f.command.requestId]); expect(f.state().pendingRequest).toBeNull();
      expect(f.state().draft).toBeNull(); expect(f.state().error).toBe('已保存，详情刷新失败');
      expect(f.state().selected.current).toBe(f.base.feature.id); expect(f.calls.refresh).toBe(1);
      f.failures.detail = null; await f.retry(); expect(f.state().error).toBeNull();
      expect(f.calls.commands).toEqual([f.command]); expect(f.calls.open).toBe(0);
    });
  });
}
for (const status of [400, 403, 404, 422]) test(`definitive ${status} preserves draft without unknown request`, async () => {
  await fixture(async f => {
    f.failures.command = new ApiError('refused', status, {}); await f.submit();
    expect(f.state().draft).toEqual(f.draft); expect(f.state().pendingRequest).toBeNull();
    expect(f.calls.details).toEqual([]); expect(f.calls.refresh).toBe(0);
  });
});
test('409 still keeps complete draft and latest conflict snapshot', async () => {
  await fixture(async f => {
    f.failures.command = new ApiError('conflict', 409, { code: 'conflict', latest: f.next }); await f.submit();
    expect(f.state().draft).toEqual({ ...f.draft, latest: f.next }); expect(f.state().detail).toEqual(f.next);
    expect(f.state().pendingRequest).toBeNull(); expect(f.calls.refresh).toBe(0);
  });
});

test('repeated read failures preserve confirmed state and retry both reads without another write', async () => {
  await fixture(async f => {
    f.failures.detail = failedRead(); f.failures.refresh = failedRead(); await f.submit();
    expect(f.state().error).toBe('已保存，详情和总览刷新失败');
    await f.retry();
    expect(f.state().error).toBe('已保存，详情和总览刷新失败'); expect(f.state().pendingRequest).toBeNull();
    expect(f.state().draft).toBeNull(); expect(f.state().detail).toEqual(f.base); expect(f.calls.refresh).toBe(2);
    f.failures.detail = null; f.failures.refresh = null; await f.retry();
    expect(f.state().error).toBeNull(); expect(f.state().detail).toEqual(f.next);
    expect(f.calls.commands).toEqual([f.command]); expect(f.calls.refresh).toBe(3);
  });
});
test('cancelled selection is not reopened by a refresh retry', async () => {
  await fixture(async f => {
    f.failures.detail = failedRead(); await f.submit();
    f.state().selected.current = null;
    await f.retry();
    expect(f.state().selected.current).toBeNull(); expect(f.calls.details).toHaveLength(1);
    expect(f.calls.refresh).toBe(2); expect(f.calls.commands).toEqual([f.command]);
  });
});

test('UIWRITE2 [验收线 3] a saved refresh still in flight when a new open begins writes neither error nor detail', async () => {
  await fixture(async f => {
    f.failures.detail = failedRead(); await f.submit();
    let release!: () => void; f.failures.gate = new Promise<void>(r => { release = r; }); f.failures.detail = null;
    let pending!: Promise<void>;
    await React.act(async () => { pending = f.ops().retry(); });
    expect(f.state().busy).toBe(true);
    await React.act(async () => { f.ops().begin(); });
    f.failures.gate = null; release();
    await React.act(async () => pending);
    expect(f.state().error).toBe('已保存，详情刷新失败'); expect(f.state().detail).toEqual(f.base);
    expect(f.state().busy).toBe(false); expect(f.calls.commands).toEqual([f.command]);
  });
});
test('UIWRITE2 [验收线 2] after a new open fails, retry reopens that feature instead of re-reading the old save', async () => {
  await fixture(async f => {
    f.failures.detail = failedRead(); await f.submit();
    const reads = f.calls.details.length, refreshes = f.calls.refresh;
    await React.act(async () => { f.ops().begin(); f.ops().openFailed(f.base.feature.id); });
    await f.retry();
    expect(f.calls.open).toBe(1); expect(f.calls.details).toHaveLength(reads); expect(f.calls.refresh).toBe(refreshes);
    expect(f.calls.commands).toEqual([f.command]);
  });
});
