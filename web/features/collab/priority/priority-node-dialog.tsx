'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchDagBoard } from '@/lib/api/ledger';
import type { DagBoard } from '../dag/dag-types';
import { NodePage } from '../dag/dag-props';
import type { Tr } from '../collab-model';
import { ownerWordsTr, prioritySystemText, PRIORITY_WORDS as W } from '@/lib/owner-words';
import { useLang } from '@/lib/i18n';
import s from './priority-panel.module.css';

/** A team's center feature ids differ from local ids. Read the original node rather than guessing a mirror coordinate. */
export function PriorityNodeDialog({ project, feature, nodeKey, onClose, onTask, tr }: {
  project: string; feature: string; nodeKey: string; onClose: () => void; onTask: (id: string) => void; tr: Tr;
}) {
  const language = useLang(), words = ownerWordsTr(language);
  const [load, setLoad] = useState<{ board: DagBoard | null; error: string }>({ board: null, error: '' });
  const [key, setKey] = useState(nodeKey);
  useEffect(() => {
    const ctrl = new AbortController();
    void fetchDagBoard(project, ctrl.signal).then(board => setLoad({ board, error: '' }),
      (e: Error) => { if (!ctrl.signal.aborted) setLoad({ board: null, error: e.message }); });
    return () => ctrl.abort();
  }, [project]);
  const f = load.board?.features.find(f => f.id === feature), n = f?.nodes.find(n => n.key === key);
  return createPortal(<div className={s.backdrop}><div className={s.dialog} role="dialog" aria-modal="true" aria-label={words(W.nodeDialog)}>
    {f && n ? <NodePage feature={f} node={n} owner={null} mark={null} now={load.board!.now} planned={!n.taskId}
      onClose={onClose} onTask={onTask} onNode={setKey} onOwner={onClose} tr={tr} /> : <div className={s.confirm}>
      <button type="button" onClick={onClose}>{words(W.close)}</button><p role="status">
        {(load.error && prioritySystemText(load.error, W.readFailed, language)) || (load.board ? words(W.nodeGone) : words(W.loadingNode))}</p>
    </div>}
  </div></div>, document.body);
}
