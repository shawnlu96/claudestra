'use client';
/**
 * 项目地图的工具条（桌面，画布上方）：左边「按依赖 / 按板块」，右边「已收尾 N」「已暂停 N」胶囊；下面一行是主区摘要。
 * 模式和已收尾的展开存 localStorage（projmap:<project>:mode / :done），读写都包 try/catch，读不到用默认值，不进 URL。
 */
import { useState } from 'react';
import { READY_WORD } from '@/lib/owner-words';
import type { Tr } from '../collab-model';
import { Icon } from '../collab-icons';
import type { MapMode, MapSummary } from './product-layout';
import { pdText } from './product-i18n';
import m from './product-map.module.css';

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const store = () => (globalThis as { localStorage?: Store }).localStorage;
function readPref(key: string): string | null {
  try { return store()?.getItem(key) ?? null; } catch { return null; }
}
function writePref(key: string, value: string) {
  try { store()?.setItem(key, value); } catch { /* 存不进去只是下次不记得 */ }
}

/** 本设备记住的模式与已收尾展开；project 缺省时各项目共用一份 */
export function useMapPrefs(project = '_') {
  const key = (k: string) => `projmap:${project}:${k}`;
  const [mode, setModeState] = useState<MapMode>(() => (readPref(key('mode')) === 'lane' ? 'lane' : 'dep'));
  const [doneOpen, setDoneState] = useState(() => readPref(key('done')) === '1');
  return {
    mode, doneOpen,
    setMode: (v: MapMode) => { setModeState(v); writePref(key('mode'), v); },
    setDoneOpen: (v: boolean) => { setDoneState(v); writePref(key('done'), v ? '1' : '0'); },
  };
}

/** 摘要只数主区；0 的项不写 */
const SUMMARY: [keyof MapSummary, string][] = [['run', '在跑'], ['blocked', '受阻'], ['stale', '久未动'], ['ready', READY_WORD], ['gate', '待验收'], ['wait', '在等前置']];

export interface ToolbarProps {
  mode: MapMode; lanesOk: boolean; onMode: (m: MapMode) => void;
  done: number; doneOpen: boolean; onDone: () => void;
  paused: number; pausedOpen: boolean; onPaused: () => void;
  summary: MapSummary; tr: Tr;
}

export function ProductToolbar(p: ToolbarProps) {
  const t = (w: string, params?: Record<string, string | number>) => pdText(p.tr, w, params);
  const seg = (k: MapMode, label: string, disabled = false) => <button type="button" role="radio" aria-checked={p.mode === k} disabled={disabled}
    title={disabled ? t('还没配置板块分组') : undefined} className={`${m.segBtn} ${p.mode === k ? m.segOn : ''}`} onClick={() => p.onMode(k)}>{t(label)}</button>;
  return <div className={m.toolbar} data-pd-toolbar>
    <div className={m.toolRow}>
      <div className={m.seg} role="radiogroup" aria-label={t('布局')}>{seg('dep', '按依赖')}{seg('lane', '按板块', !p.lanesOk)}</div>
      <div className={m.pills}>
        <button type="button" className={m.pill} aria-expanded={p.doneOpen} onClick={p.onDone}>
          <Icon name="check" size={13} />{t('已收尾 {n}', { n: p.done })}</button>
        {p.paused > 0 && <button type="button" className={m.pill} aria-expanded={p.pausedOpen} onClick={p.onPaused}>
          <Icon name="pause" size={13} />{t('已暂停 {n}', { n: p.paused })}</button>}
      </div>
    </div>
    <div className={m.summary} data-pd-summary>
      {[t('{n} 个没收尾', { n: p.summary.total }), ...SUMMARY.filter(([k]) => p.summary[k] > 0).map(([k, w]) => `${p.summary[k]} ${t(w)}`)].join(' · ')}
    </div>
  </div>;
}
