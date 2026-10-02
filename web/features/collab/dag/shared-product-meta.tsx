import type { Feature } from '@/lib/api/shared-ledger';
import type { Tr } from '../collab-model';
import { Icon } from '../collab-icons';
import { stale } from '../shared/shared-model';
import s from './shared-product.module.css';

export function SharedFeatureMeta({ feature: f, now, tr }: { feature: Feature; now: number; tr: Tr }) {
  const statuses = { active: '进行中', planned: '待规划', done: '已完成', blocked: '已阻塞' };
  return <span className={s.meta}>
    <span className={s.badge} title={f.projectId}>{f.projectId}</span>
    <span className={s.badge}>{tr(statuses[f.status])}</span>
    <span className={s.badge} title={`${tr('主场')}: ${f.homeInstanceId}`} aria-label={`${tr('主场')}: ${f.homeInstanceId}`}>
      <Icon name="flag" size={11} />{f.homeInstanceId}</span>
    <span className={s.badge} title={`${tr('执行机器')}: ${f.executorInstanceIds.join(', ')}`} aria-label={`${tr('执行机器')}: ${f.executorInstanceIds.join(', ')}`}>
      <Icon name="terminal" size={11} />{f.executorInstanceIds.length}</span>
    {f.counts.missing > 0 && <span className={`${s.badge} ${s.warn}`} title={tr('缺失')} aria-label={tr('缺失')}>
      <Icon name="circleAlert" size={11} />{f.counts.missing}</span>}
    {stale(f, now) && <span className={`${s.badge} ${s.warn}`} title={tr('过期')} aria-label={tr('过期')}><Icon name="clock" size={11} /></span>}
    <time className={s.badge} title={new Date(f.updatedAt).toLocaleString()} dateTime={new Date(f.updatedAt).toISOString()}>
      <Icon name="history" size={11} />{new Date(f.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
  </span>;
}
