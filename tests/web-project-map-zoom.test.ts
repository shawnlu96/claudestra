import { describe, expect, test } from 'bun:test';
import type { LedgerDepView, LedgerTaskView } from '../web/features/collab/collab-model';
import { causalCanvas } from '../web/features/collab/v4/causal-model';
import { fitAllView, fitsAll, initialView, reconcileView, type ViewState } from '../web/features/collab/v4/canvas-view';
import { productLayout } from '../web/features/collab/product/product-layout';
import { PRODUCT_MIN_K, productInitialView, singlesOffRight, zoomTier } from '../web/features/collab/product/product-zoom';
import { projectMapBoard, PROJECT_MAP_NOW } from './helpers/project-map-fixture';
import { enlargedProjectMap } from './web-project-map-zoom-fixture.test';

// Same I1/I2, build chain C0…C2 and task/dep fields as web-collab-causal.test.ts.
const task = (id: string): LedgerTaskView => ({ id, itemId: 'I1', title: `任务 ${id}`, kind: 'code', stage: 'build', stageBefore: null,
  round: 0, agent: null, pm: 'agent-pm', pr: null, spec: null, model: null, extra: {}, createdAt: 0, updatedAt: 0, lastEvent: null,
  metrics: { startTs: null, endTs: null, stageMs: {}, reviewRounds: 0, reviewWaitPendingMs: null, p0: 0, p1: 0, p2: 0 } });
const dep = (from: string, to: string): LedgerDepView => ({ from, to, kind: 'blocks', when: `${from} 合并后`, state: null,
  derived: 'waiting', effective: 'waiting', createdBy: 'agent-pm', createdAt: 0, updatedAt: 0 });
const causal = causalCanvas({ items: [{ id: 'I1', title: '事项一', oneLine: '' }, { id: 'I2', title: '事项二', oneLine: '' }],
  tasks: ['C0', 'C1', 'C2'].map(task), deps: [dep('C0', 'C1'), dep('C1', 'C2')] });

// Literal results captured from origin/main dac68af96 with the causal geometry fixture above.
describe('[验收线 1] shared viewport defaults', () => {
  test('initial, fit, fits and reconcile retain their baseline values', () => {
    const view = { x: 24, y: 24, k: 0.96 };
    expect(initialView(causal, 800, 600)).toEqual(view);
    expect(fitAllView(causal, 800, 600)).toEqual({ x: 24, y: 24, k: 0.96 });
    expect(fitsAll(causal, 800, 600)).toBe(false);
    const st: ViewState = { view: { x: 0, y: 0, k: 1 }, placed: false, centered: 0 };
    expect(reconcileView(st, causal, 800, 600, null)).toEqual({ view, placed: true, centered: 0 });
    const placed = { ...st, placed: true };
    expect(reconcileView(placed, causal, 800, 600, null)).toBe(placed);
  });
});

const layout = productLayout(projectMapBoard(PROJECT_MAP_NOW));
describe('[验收线 1] project map zoom geometry', () => {
  test('fit all accepts the product minimum and reports whether the whole map fits', () => {
    const view = fitAllView(layout, 1280, 800, PRODUCT_MIN_K);
    expect(view.k).toBeGreaterThanOrEqual(0.45);
    expect(view.k).toBeLessThan(0.96);
    expect(view.x + layout.w * view.k).toBeLessThanOrEqual(1280);
    expect(view.y + layout.h * view.k).toBeLessThanOrEqual(800);
    expect(fitsAll(layout, 1280, 800, PRODUCT_MIN_K)).toBe(true);
    const big = productLayout(enlargedProjectMap());
    expect(fitAllView(big, 1280, 600, PRODUCT_MIN_K).k).toBe(0.45);
    expect(fitsAll(big, 1280, 600, PRODUCT_MIN_K)).toBe(false);
  });
  test('dependency mode frames the whole chain group, including its heading', () => {
    const v = productInitialView(layout, 'dep')(layout, 1280, 800);
    const head = layout.zones.find(z => z.kind === 'chains')!;
    expect(v.k).toBeGreaterThanOrEqual(0.7);
    expect(v.k).toBeLessThanOrEqual(1);
    expect(v.x + head.x * v.k).toBe(24);
    expect(v.y + head.y * v.k).toBe(24);
    const st = { view: { x: 0, y: 0, k: 1 }, placed: false, centered: 0 };
    expect(reconcileView(st, layout, 1280, 800, null, productInitialView(layout, 'dep')).view).toEqual(v);
  });
  test('no chains falls back; lane mode fits width and starts at the top', () => {
    const board = projectMapBoard(PROJECT_MAP_NOW);
    const solo = productLayout({ ...board, deps: [], links: [] });
    expect(productInitialView(solo, 'dep')(solo, 800, 600)).toEqual(initialView(solo, 800, 600, PRODUCT_MIN_K));
    const lane = productLayout(board, { mode: 'lane' });
    const v = productInitialView(lane, 'lane')(lane, 1280, 800);
    expect(v).toEqual({ x: 24, y: 24, k: Math.max(0.45, Math.min(1, 1232 / lane.w)) });
  });
  test('30 solo cards count only their right edges, including partial visibility', () => {
    const big = productLayout(enlargedProjectMap());
    const solo = big.zones.find(z => z.kind === 'solo')!;
    const first = big.nodes.find(n => n.x === solo.x)!;
    expect(singlesOffRight(big, { x: -solo.x, y: 0, k: 1 }, first.w - 1)).toBe(30);
    expect(singlesOffRight(big, { x: -solo.x, y: -9999, k: 1 }, first.w)).toBe(20);
    expect(singlesOffRight(big, { x: -solo.x, y: 0, k: 1 }, solo.w)).toBe(0);
    expect(zoomTier(0.61)).toBe('far');
    expect(zoomTier(0.62)).toBe('near');
  });
});
