import { ApiError } from '../../../lib/api/client';
import type { Command, FeatureDetail, Identity, SharedLedgerSession } from '../../../lib/api/shared-ledger';
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
    setPending, setPrevious, selected, setDetail, refresh, open } = p;
  const submit = async (command: Command) => {
    if (pendingRequest) return;
    setBusy(true); setError(null);
    try {
      const result = await session.submit(command);
      if (!alive.current || !result) return;
      setDraft(null); setCreating(false); setPending(null);
      setPrevious(detail ?? undefined);
      selected.current = result.result.featureId;
      const next = await session.detail(result.result.featureId);
      if (alive.current && next) setDetail(next);
      await refresh();
    } catch (e) {
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
    } finally { if (alive.current) setBusy(false); }
  };
  const receipt = async () => {
    if (!pendingRequest) return;
    setBusy(true);
    try {
      const r = await session.receipt(pendingRequest);
      if (!alive.current || !r) return;
      if (r.status === 'committed') { setPending(null); setDraft(null); setCreating(false); await open(r.receipt.result.featureId); await refresh(); }
      else setError(tr('未查到回执，保留草稿'));
    } catch (e) {
      if (alive.current) { console.warn('Shared receipt read failed', e); setError(tr('读取失败，保留缓存与草稿')); }
    } finally { if (alive.current) setBusy(false); }
  };
  return { submit, receipt };
}
