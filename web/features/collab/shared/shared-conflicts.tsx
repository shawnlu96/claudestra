'use client';
import type { PlanNode } from '../../../lib/api/shared-ledger';
import type { Draft } from './shared-model';
import { resolveNodeConflict } from './shared-rebase';
import type { Tr } from '../collab-model';
import c from '../collab.module.css';
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
    <div className={s.head}>{tr('逐条处理冲突')} · {draft.conflicts.length}</div>
    {draft.conflicts.map(x => <section key={x.key} className={s.nodeConflict}>
      <div className={s.head}>{x.key} {x.locked && <small>{tr('已绑卡，节点锁定')}</small>}</div>
      <div className={s.compare}><div><div className={s.sub}>{tr('草稿')}</div><NodePreview node={x.mine} tr={tr} /></div>
        <div><div className={s.sub}>{tr('最新图')}</div><NodePreview node={x.latest} tr={tr} /></div></div>
      <div className={s.actions}><button className={c.btn} type="button" disabled={busy || x.locked} aria-label={`${tr('用我的')} ${x.key}`}
        title={x.locked ? tr('已绑卡，节点锁定') : undefined} onClick={() => onChange(resolveNodeConflict(draft, x.key, 'mine'))}>{tr('用我的')}</button>
        <button className={c.btn} type="button" disabled={busy} aria-label={`${tr('用最新')} ${x.key}`}
          onClick={() => onChange(resolveNodeConflict(draft, x.key, 'latest'))}>{tr('用最新')}</button></div>
    </section>)}
  </section>;
}
