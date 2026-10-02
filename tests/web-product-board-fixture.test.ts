import { expect, test } from 'bun:test';
import type { ProductBoard, ProductFeature } from '../web/lib/api/product-board-types';
import { assertProductBoard } from '../web/lib/api/product-board-types';
import { productEta, productLayout } from '../web/features/collab/product/product-layout';

export const feature = (id: string, patch: Partial<ProductFeature> = {}): ProductFeature => ({
  id, title: `Feature ${id}`, status: 'active', hasDag: true, version: 1,
  counts: { total: 4, completed: 1, active: 1, blocked: 2 }, eta: null, ...patch,
});
export const product: ProductBoard = {
  features: [feature('base', { title: '协作底座', status: 'done' }), feature('flow', { title: '调度与自动派单' }),
    feature('view', { title: '产品与团队视图', eta: { at: Date.UTC(2026, 9, 2, 5) } }),
    feature('shared', { title: '共享台账', status: 'paused' }), feature('cards', { title: '下一步探索', hasDag: false, version: 0,
      counts: { total: 1, completed: 0, active: 0 }, cards: [{ id: 'T-card', title: '验证新产品方向', stage: 'spec' }] }),
    feature('gone', { status: 'dropped' })],
  deps: [{ from: 'base', to: 'flow', note: '' }, { from: 'flow', to: 'view', note: '' }, { from: 'view', to: 'shared', note: '' }],
};

test('longest path columns, completed solid edges and unfinished dotted edges', () => {
  const c = productLayout(product, true);
  expect(c.nodes.find(n => n.id === 'shared')?.column).toBe(3);
  expect(c.edges.map(e => e.solid)).toEqual([true, false, false]);
  expect(c.nodes.some(n => n.id === 'gone')).toBe(false);
  expect(c.boxOf.get('view')).toBe('view');
});
test('done collapsed, paused retained and no-DAG card count retained', () => {
  const c = productLayout(product);
  expect(c.done.map(f => f.id)).toEqual(['base']);
  expect(c.nodes.some(n => n.id === 'base')).toBe(false);
  expect(c.fold?.members).toEqual(['base']);
  expect(c.edges.map(e => e.solid)).toEqual([true, false, false]);
  expect(c.nodes.find(n => n.id === 'cards')?.feature.counts.total).toBe(1);
  expect(c.nodes.some(n => n.feature.status === 'paused')).toBe(true);
});
test('cycles, missing endpoints, empty boards and branching never recurse or overlap', () => {
  const b = { features: ['a', 'b', 'c', 'd'].map(id => feature(id)), deps: [
    { from: 'a', to: 'b', note: '' }, { from: 'b', to: 'a', note: '' }, { from: 'c', to: 'd', note: '' },
    { from: 'missing', to: 'c', note: '' }] };
  const c = productLayout(b);
  expect(c.nodes).toHaveLength(4);
  expect(new Set(c.nodes.map(n => `${n.x}:${n.y}`)).size).toBe(4);
  expect(c.w).toBeGreaterThan(0);
  expect(productLayout({ features: [], deps: [] }).w).toBe(0);
  const branch = productLayout({ features: ['a', 'b', 'c', 'd'].map(id => feature(id)),
    deps: [['a', 'c'], ['a', 'b'], ['b', 'c'], ['c', 'd']].map(([from, to]) => ({ from, to, note: '' })) });
  expect(branch.nodes.map(n => n.column)).toEqual([0, 1, 2, 3]);
});
test('missing/invalid fields reject instead of entering render', () => {
  expect(() => assertProductBoard(product)).not.toThrow();
  for (const body of [{}, null, { features: [], deps: null }, { ...product, features: [{ id: 'bad' }] },
    { ...product, features: [feature('x', { eta: undefined as never })] },
    { ...product, features: [feature('x', { counts: { total: 1, active: 0, completed: 0 } })] },
    { ...product, features: [feature('x'), feature('x')] }]) expect(() => assertProductBoard(body)).toThrow();
});
test('ETA today has time, other dates have month/day, null is hidden', () => {
  const now = new Date(2026, 9, 2, 9).getTime();
  expect(productEta(new Date(2026, 9, 2, 14).getTime(), now, '今天')).toBe('今天 14:00');
  expect(productEta(new Date(2026, 9, 4).getTime(), now, '今天')).toBe('10-04');
  expect(productEta(null, now, '今天')).toBeNull();
});
