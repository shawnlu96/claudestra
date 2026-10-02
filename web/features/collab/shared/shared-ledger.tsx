'use client';
import { useEffect, useRef, useState } from 'react';
import { identityKey, SharedLedgerSession, sharedLedgerTransport } from '../../../lib/api/shared-ledger';
import type { FeatureDetail, FeatureList, Identity, Transport } from '../../../lib/api/shared-ledger';
import { sharedLedgerTr } from '../../../lib/i18n-dict-shared-ledger';
import { useSharedSubmission } from './use-shared-submission';
import { makeDraft, rebaseDraft, rewrite, type Draft } from './shared-model';
import { SharedLedgerView } from './shared-view';
export interface SharedLedgerProps { identity: Identity; language?: 'zh' | 'en'; transport?: Transport }
/** Identity-keyed mounting clears all editable/UI state before a different member can see it. */
export function SharedLedger(props: SharedLedgerProps) { return <SessionView key={identityKey(props.identity)} {...props} />; }
function SessionView({ identity, language = 'zh', transport }: SharedLedgerProps) {
  const [session] = useState(() => new SharedLedgerSession(identity, transport ?? sharedLedgerTransport({ fp: identity.machine }, identity.project)));
  const [list, setList] = useState<FeatureList | null>(null), [detail, setDetail] = useState<FeatureDetail | null>(null);
  const [previous, setPrevious] = useState<FeatureDetail | undefined>(), [draft, setDraft] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now()), [pendingRequest, setPending] = useState<string | null>(null);
  const selected = useRef<string | null>(null), alive = useRef(true), polling = useRef(false);
  const tr = sharedLedgerTr(language);
  const refresh = async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const snapshot = await session.list();
      if (!alive.current || !snapshot) return;
      setList(snapshot); setError(null);
      const id = selected.current;
      if (id) {
        const next = await session.detail(id);
        if (alive.current && next && selected.current === id) setDetail(old => {
          return old?.serverSeq === next.serverSeq ? old : next;
        });
      }
    } catch (e) {
      if (alive.current) { console.warn('Shared ledger refresh failed', e); setError(tr('读取失败，保留缓存与草稿')); }
    } finally { polling.current = false; }
  };
  useEffect(() => {
    alive.current = true; session.activate();
    queueMicrotask(() => void refresh());
    const timer = setInterval(() => { setNow(Date.now()); void refresh(); }, 5000);
    const wake = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', wake);
    return () => { alive.current = false; session.close(); clearInterval(timer); document.removeEventListener('visibilitychange', wake); };
    // This instance is permanently bound to the identity supplied at construction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  const open = async (id: string) => {
    selected.current = id; setCreating(false); setBusy(true); setError(null); setDraft(null);
    try {
      const next = await session.detail(id);
      if (alive.current && next && selected.current === id) { setDetail(next); setPrevious(undefined); }
    } catch (e) {
      if (alive.current) { console.warn('Shared feature read failed', e); setError(tr('读取失败，保留缓存与草稿')); }
    } finally { if (alive.current) setBusy(false); }
  };
  const reload = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const next = await session.detail(draft.base.feature.id);
      if (alive.current && next) { setDraft(rebaseDraft(draft, next)); setDetail(next); setError(null); }
    } catch (e) {
      if (alive.current) { console.warn('Conflict re-read failed', e); setError(tr('读取失败，保留缓存与草稿')); }
    } finally { if (alive.current) setBusy(false); }
  };
  const { submit, receipt } = useSharedSubmission({ session, alive, identity, detail, pendingRequest, tr,
    setBusy, setError, setDraft, setCreating, setPending, setPrevious, selected, setDetail, refresh, open });
  return <SharedLedgerView identity={identity} language={language} now={now} list={list} detail={detail} previous={previous}
    draft={draft} creating={creating} busy={busy} error={error} pendingRequest={pendingRequest} onOpen={id => void open(id)}
    onBack={() => { selected.current = null; setDetail(null); setDraft(null); }} onCreate={() => setCreating(true)}
    onCancelCreate={() => setCreating(false)} onNew={c => void submit(c)} onEdit={() => detail && setDraft(makeDraft(detail))}
    onDraft={next => { setDraft(next); if (!next) setError(null); }} onReload={() => void reload()} onRetry={() => void refresh()}
    onReceipt={() => void receipt()} onSubmit={() => {
      if (!draft || pendingRequest) return;
      try { void submit(rewrite(draft)); } catch (e) {
        setError(tr(e instanceof Error && e.message === 'reason_required' ? '请填写改图原因' : '节点需有唯一代号、标题和文件范围；依赖必须存在且无环'));
      }
    }} />;
}
