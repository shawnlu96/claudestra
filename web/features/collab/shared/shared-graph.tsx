'use client';
import { useState } from 'react';
import type { FeatureDetail } from '../../../lib/api/shared-ledger';
import { boardFeature } from './shared-model';
import { MobileDag } from '../dag/dag-mobile';
import { DagCanvasView } from '../dag/dag-canvas';
import { layoutDag } from '../dag/dag-layout';
import { DiffPage } from '../dag/dag-props';
import type { Tr } from '../collab-model';
import s from './shared.module.css';
export function SharedGraph({ detail, previous, now, tr }: { detail: FeatureDetail; previous?: FeatureDetail; now: number; tr: Tr }) {
  const f = boardFeature(detail, now), before = previous ? boardFeature(previous, now) : null;
  const [done, setDone] = useState(false), [diff, setDiff] = useState(false);
  const fold = () => setDone(x => !x);
  const noop = () => undefined;
  const look = () => ({ owner: null, act: '', now, hot: false, selected: false, flash: null });
  const compare = before ? { featureId: f.id, from: before.currentVersion, to: f.currentVersion } : null;
  const data = before ? { key: `${f.id}:${before.currentVersion}:${f.currentVersion}`,
    fromNodes: before.nodes, toNodes: f.nodes,
    diff: { ok: true as const, project: f.id, featureId: f.id, now, from: before.currentVersion, to: f.currentVersion,
      diff: { added: f.nodes.filter(n => !before.nodes.some(b => b.key === n.key)).map(n => n.key),
        removed: before.nodes.filter(n => !f.nodes.some(b => b.key === n.key)).map(n => n.key),
        carried: f.nodes.filter(n => before.nodes.some(b => b.key === n.key)).map(n => ({ key: n.key,
          changed: JSON.stringify(detail.dag.nodes.find(b => b.key === n.key)) !== JSON.stringify(previous?.dag.nodes.find(b => b.key === n.key)) })),
        cancelled: [] }, phaseNow: Object.fromEntries(f.nodes.map(n => [n.key, n.phase])), rewrittenDone: [] },
  } : null;
  return <>
    {before && <button type="button" onClick={() => setDiff(x => !x)}>{tr('对比')} v{before.currentVersion} → v{f.currentVersion}</button>}
    {diff && compare && <DiffPage feature={f} compare={compare} data={data} onVersions={noop} onClose={() => setDiff(false)} tr={tr} />}
    <div className={s.desktopGraph}><DagCanvasView canvas={layoutDag([f], [f.id], new Set(done ? [f.id] : []))}
      shelf={[]} evicted={null} look={look} compare={null} focus={null} onNode={noop} onOwner={noop}
      onFold={fold} onFeature={noop} onVersions={noop} onBackground={noop} tr={tr} /></div>
    <div className={s.mobileGraph}><MobileDag features={[f]} open={[f.id]} doneOpen={new Set(done ? [f.id] : [])}
      look={look} onFeature={noop} onFold={fold} onVersions={noop} onNode={noop} onOwner={noop} tr={tr} /></div>
  </>;
}
