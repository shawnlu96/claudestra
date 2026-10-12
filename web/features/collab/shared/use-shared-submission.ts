import { useRef } from 'react';
import { ApiError } from '../../../lib/api/client';
import type { Command, FeatureDetail, Identity, Result, SharedLedgerSession } from '../../../lib/api/shared-ledger';
import type { Dispatch, SetStateAction, RefObject } from 'react';
import type { Draft } from './shared-model';
import type { Tr } from '../collab-model';
type Setter<T> = Dispatch<SetStateAction<T>>;
interface SubmissionProps {
  session: SharedLedgerSession; alive: RefObject<boolean>; identity: Identity; detail: FeatureDetail | null;
  pendingRequest: string | null; tr: Tr; setBusy: Setter<boolean>; setError: Setter<string | null>;
  setDraft: Setter<Draft | null>; setCreating: Setter<boolean>; setPending: Setter<string | null>;
  setPrevious: Setter<FeatureDetail | undefined>; selected: RefObject<string | null>; setDetail: Setter<FeatureDetail | null>;
  refresh: () => Promise<void>; open: (id: string) => Promise<void>;
}
export function useSharedSubmission(p: SubmissionProps) {
  const { session, alive, identity, detail, pendingRequest, tr, setBusy, setError, setDraft, setCreating,
    setPending, setPrevious, selected: selectedRef, setDetail, refresh } = p;
  // A confirmed receipt survives read failures and renders; retries must never submit that command again.
  const savedRef = useRef<Result | null>(null);
  const refreshSaved = async (id: string) => {
    const [next, overview] = await Promise.allSettled([session.detail(id), Promise.resolve().then(refresh)]);
    if (!alive.current || selectedRef.current !== id) return;
    if (next.status === 'fulfilled' && next.value) setDetail(next.value);
    if (next.status === 'rejected') console.warn('Shared saved detail refresh failed', next.reason);
    if (overview.status === 'rejected') console.warn('Shared saved overview refresh failed', overview.reason);
    setError(next.status === 'rejected'
      ? tr(overview.status === 'rejected' ? '已保存，详情和总览刷新失败' : '已保存，详情刷新失败')
      : overview.status === 'rejected' ? tr('已保存，总览刷新失败') : null);
  };
  const committed = async (result: Result) => {
    savedRef.current = result;
    setDraft(null); setCreating(false); setPending(null); setError(null);
    setPrevious(detail ?? undefined); selectedRef.current = result.result.featureId;
    await refreshSaved(result.result.featureId);
  };
  const commandFailed = (e: unknown, command: Command) => {
    if (!alive.current) return;
    if (e instanceof ApiError && e.status === 409 && e.body.code === 'conflict' && e.body.latest) {
      const latest = e.body.latest as FeatureDetail;
      if (latest.teamId === identity.team && latest.feature.projectId === identity.project) {
        if (command.type === 'feature.new') setError(tr('同名 feature 已存在，请修改标题；表单已保留'));
        else { setDraft(old => old ? { ...old, latest } : old); setDetail(latest); }
      }
    } else {
      console.warn('Shared ledger command failed', e);
      if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500 || e.code === 'invalid_json' || e.code === 'body_read_failed') {
        setPending(command.requestId);
      }
      setError(tr('提交失败，草稿已保留'));
    }
  };
  const submit = async (command: Command) => {
    if (pendingRequest) return;
    setBusy(true); setError(null); savedRef.current = null;
    try {
      const result = await session.submit(command).catch(e => { commandFailed(e, command); });
      if (alive.current && result) await committed(result);
    } finally { if (alive.current) setBusy(false); }
  };
  const receipt = async () => {
    if (!pendingRequest) return;
    setBusy(true);
    try {
      const r = await session.receipt(pendingRequest);
      if (!alive.current || !r) return;
      if (r.status === 'committed') await committed(r.receipt);
      else setError(tr('未查到回执，保留草稿'));
    } catch (e) {
      if (alive.current) { console.warn('Shared receipt read failed', e); setError(tr('读取失败，保留缓存与草稿')); }
    } finally { if (alive.current) setBusy(false); }
  };
  const retry = async () => {
    const id = savedRef.current?.result.featureId;
    if (!id || selectedRef.current !== id) return refresh();
    setBusy(true);
    try { await refreshSaved(id); } finally { if (alive.current) setBusy(false); }
  };
  return { submit, receipt, retry };
}
