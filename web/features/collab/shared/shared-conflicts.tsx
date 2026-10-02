'use client';
import type { PlanNode } from '../../../lib/api/shared-ledger';
import type { Draft } from './shared-model';
import { resolveNodeConflict } from './shared-rebase';
import type { Tr } from '../collab-model';
import s from './shared.module.css';
function NodePreview({ node, tr }: { node: PlanNode | null; tr: Tr }) {
  if (!node) return <p>{tr('删除节点')}</p>;
  return <dl className={s.preview}>{[
    ['节点', node.key], ['标题', node.oneLine], ['依赖', node.deps.join(', ') || '—'],
    ['文件范围', node.fileGlobs.join(', ') || '—'], ['估时', node.estimate || '—'],
  ].map(([label, value]) => <div key={label}><dt>{tr(label!)}</dt><dd>{value}</dd></div>)}</dl>;
}
export function NodeConflicts({ draft, tr, busy, onChange }: { draft: Draft; tr: Tr; busy: boolean; onChange: (d: Draft) => void }) {
  if (!draft.conflicts.length) return null;
  return <section aria-label={tr('逐条处理冲突')} className={s.conflict}>
    <h3>{tr('逐条处理冲突')} · {draft.conflicts.length}</h3>
    {draft.conflicts.map(c => <section key={c.key} className={s.nodeConflict}>
      <h3>{c.key} {c.locked && <small>{tr('已绑卡，节点锁定')}</small>}</h3>
      <div className={s.compare}><div><h4>{tr('草稿')}</h4><NodePreview node={c.mine} tr={tr} /></div>
        <div><h4>{tr('最新图')}</h4><NodePreview node={c.latest} tr={tr} /></div></div>
      <div className={s.actions}><button type="button" disabled={busy || c.locked} aria-label={`${tr('用我的')} ${c.key}`}
        title={c.locked ? tr('已绑卡，节点锁定') : undefined} onClick={() => onChange(resolveNodeConflict(draft, c.key, 'mine'))}>{tr('用我的')}</button>
        <button type="button" disabled={busy} aria-label={`${tr('用最新')} ${c.key}`}
          onClick={() => onChange(resolveNodeConflict(draft, c.key, 'latest'))}>{tr('用最新')}</button></div>
    </section>)}
  </section>;
}
