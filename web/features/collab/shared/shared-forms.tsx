'use client';
import { useState } from 'react';
import type { Command } from '../../../lib/api/shared-ledger';
import type { Draft } from './shared-model';
import type { Tr } from '../collab-model';
import { Icon } from '../collab-icons';
import s from './shared.module.css';
export function NewFeature({ project, home, busy, tr, onSubmit, onCancel }: {
  project: string; home: string; busy: boolean; tr: Tr; onSubmit: (command: Command) => void; onCancel: () => void;
}) {
  const [title, setTitle] = useState(''), [description, setDescription] = useState('');
  const [projectId, setProject] = useState(project), [homeId, setHome] = useState(home);
  return <form className={s.form} onSubmit={e => { e.preventDefault(); onSubmit({ type: 'feature.new', requestId: crypto.randomUUID(),
    projectId, title: title.trim(), description, homeInstanceId: homeId }); }}>
    <h2>{tr('新建 feature')}</h2>
    <label>{tr('项目')}<input required value={projectId} onChange={e => setProject(e.target.value)} /></label>
    <label>{tr('标题')}<input required value={title} onChange={e => setTitle(e.target.value)} /></label>
    <label>{tr('描述')}<textarea value={description} onChange={e => setDescription(e.target.value)} /></label>
    <label>{tr('默认规划主场')}<input required value={homeId} onChange={e => setHome(e.target.value)} /></label>
    <div className={s.actions}><button disabled={busy || !title.trim()}>{tr('创建')}</button>
      <button type="button" onClick={onCancel}>{tr('取消')}</button></div>
  </form>;
}
const split = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);
export function PlanEditor({ draft, busy, tr, onChange, onSubmit, onCancel }: {
  draft: Draft; busy: boolean; tr: Tr; onChange: (draft: Draft) => void; onSubmit: () => void; onCancel: () => void;
}) {
  const locked = new Set(draft.base.dag.bindings.map(b => b.nodeKey));
  const patch = (index: number, field: string, value: string | string[]) => onChange({ ...draft,
    nodes: draft.nodes.map((n, i) => i === index ? { ...n, [field]: value } : n) });
  return <form className={s.form} onSubmit={e => { e.preventDefault(); onSubmit(); }}>
    <h2>{tr('编辑规划')} · v{draft.base.dag.version}</h2>
    {draft.nodes.map((n, i) => <fieldset key={i} disabled={locked.has(n.key) || busy || !!draft.latest} className={s.nodeForm}>
      <legend>{n.key} {locked.has(n.key) && <span><Icon name="shieldCheck" /> {tr('已绑卡，节点锁定')}</span>}</legend>
      <label>{tr('节点')}<input required aria-label={`${tr('节点')} ${i + 1}`} value={n.key} onChange={e => patch(i, 'key', e.target.value)} /></label>
      <label>{tr('标题')}<input required value={n.oneLine} onChange={e => patch(i, 'oneLine', e.target.value)} /></label>
      <label>{tr('依赖')}<input value={n.deps.join(', ')} onChange={e => patch(i, 'deps', split(e.target.value))} /></label>
      <label>{tr('文件范围')}<input required value={n.fileGlobs.join(', ')} onChange={e => patch(i, 'fileGlobs', split(e.target.value))} /></label>
      <label>{tr('估时')}<input value={n.estimate} onChange={e => patch(i, 'estimate', e.target.value)} /></label>
      <button type="button" onClick={() => onChange({ ...draft, nodes: draft.nodes.filter((_, index) => index !== i) })}>{tr('删除节点')}</button>
    </fieldset>)}
    <button type="button" disabled={busy || !!draft.latest} onClick={() => onChange({ ...draft,
      nodes: [...draft.nodes, { key: `N${draft.nodes.length + 1}`, oneLine: '', deps: [], fileGlobs: [], estimate: '' }] })}>
      <Icon name="plus" /> {tr('添加节点')}</button>
    <label>{tr('改图原因')}<textarea required disabled={busy || !!draft.latest} value={draft.reason}
      onChange={e => onChange({ ...draft, reason: e.target.value })} /></label>
    <div className={s.actions}><button disabled={busy || !!draft.latest}>{tr('提交新版本')}</button>
      <button type="button" onClick={onCancel}>{tr('取消')}</button></div>
  </form>;
}
