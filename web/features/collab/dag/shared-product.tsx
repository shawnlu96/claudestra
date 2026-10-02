'use client';
import { useEffect, useState } from 'react';
import type { FeatureList } from '@/lib/api/shared-ledger';
import type { Tr } from '../collab-model';
import { ProductView } from '../product/product-view';
import { sharedProductBoard } from './shared-product-model';
import { SharedFeatureMeta } from './shared-product-meta';

export function SharedProduct({ list, now, onOpen, tr }: { list: FeatureList | null; now: number; onOpen: (id: string) => void; tr: Tr }) {
  const [narrow, setNarrow] = useState(true);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 720px)');
    const update = () => setNarrow(query.matches);
    update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  if (!list) return null;
  return <section aria-label={tr('全部 feature')} style={{ flex: 1, minHeight: 400, display: 'flex', flexDirection: 'column' }}>
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 400, height: narrow ? 'auto' : 600 }}><ProductView board={sharedProductBoard(list, now)} narrow={narrow}
      now={now} onFeature={onOpen} tr={tr} activeUnknown featureMeta={feature => {
        const f = list.features.find(item => item.id === feature.id);
        return f ? <SharedFeatureMeta feature={f} now={now} tr={tr} /> : null;
      }} /></div>
    {!list.features.length && <p>{tr('暂无 feature')}</p>}
  </section>;
}
