/** Browser-only entry for isolated screenshots. Never imported by production navigation. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { fixtureDetail, fixtureIdentity, fixtureList, fixtureNow, fixtureTransport } from './shared-fixture';
import { SharedLedger } from './shared-ledger';
import { SharedLedgerView } from './shared-view';
import { makeDraft, rebaseDraft, rewrite, type Draft } from './shared-model';
import type { Command, FeatureDetail } from '../../../lib/api/shared-ledger';
const liveTransport = fixtureTransport(true);
function FixtureHarness() {
  const params = new URLSearchParams(location.search), mode = params.get('view') ?? 'list';
  const base = structuredClone(fixtureDetail);
  const latest = { ...base, serverSeq: 41, feature: { ...base.feature, rev: 8, version: 3, updatedBy: 'person-b' },
    dag: { ...base.dag, version: 3, nodes: base.dag.nodes.map(n => n.key === 'C4' ? { ...n, oneLine: '另一位成员更新的规划' } : n) } };
  const [detail, setDetail] = useState<FeatureDetail | null>(mode === 'list' ? null : base);
  const [creating, setCreating] = useState(mode === 'new');
  const [draft, setDraft] = useState<Draft | null>(() => {
    if (mode !== 'conflict') return null;
    const draft = makeDraft(base); draft.reason = '完善手机上的团队协作视图';
    draft.nodes[1]!.oneLine = '我的草稿：团队总表与冲突恢复'; return { ...draft, latest };
  });
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const submit = (command: Command) => {
    if ('nodes' in command) { setDetail(d => d ? { ...d, feature: { ...d.feature, rev: d.feature.rev + 1 },
      dag: { ...d.dag, version: d.dag.version + 1, nodes: command.nodes } } : d); }
    setDraft(null); setCreating(false); setSubmitted(true);
  };
  const trMode = params.get('language') === 'en' ? 'en' : 'zh';
  if (mode === 'live') return <SharedLedger identity={fixtureIdentity} transport={liveTransport} />;
  if (params.get('phase') === 'before') return <main style={{ padding: 24, fontFamily: 'system-ui' }}>
    <h1>Shared ledger · baseline 1307554e</h1><p>This feature has no UI in the baseline.</p></main>;
  return <><SharedLedgerView identity={fixtureIdentity} language={trMode} now={fixtureNow} list={fixtureList} detail={detail}
    draft={draft} creating={creating} busy={false} error={error} onOpen={() => setDetail(base)}
    onBack={() => { setDetail(null); setDraft(null); }} onCreate={() => setCreating(true)} onCancelCreate={() => setCreating(false)}
    onNew={submit} onEdit={() => detail && setDraft(makeDraft(detail))} onDraft={setDraft}
    onReload={() => { if (draft) { setDraft(rebaseDraft(draft, latest)); setDetail(latest); } }}
    onRetry={() => setError(null)} onReceipt={() => undefined} onSubmit={() => {
      if (draft) { try { submit(rewrite(draft)); } catch (e) { setError(String(e)); } }
    }} />{submitted && <output data-testid="submitted">Submitted</output>}</>;
}
createRoot(document.getElementById('root')!).render(<FixtureHarness />);
