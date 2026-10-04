/**
 * team-parity-Bc1：ProductFeature.counts.activeUnknown 只许缺省或 true；加了它也不放宽旧的必填数值检查
 * （active 仍须是非负有限数，占位 0 合法）。旧非法 counts 照旧拒收。
 */
import { expect, test } from 'bun:test';
import type { ProductFeature } from '../web/lib/api/product-board-types';
import { assertProductBoard } from '../web/lib/api/product-board-types';

const feature = (id: string, counts: Record<string, unknown>, patch: Partial<ProductFeature> = {}) =>
  ({ id, title: `Feature ${id}`, status: 'active', hasDag: true, version: 1, counts, eta: null, ...patch });
const board = (...features: unknown[]) => ({ features, deps: [] });
const KNOWN = { total: 4, completed: 1, active: 0, blocked: 2 };

test('absent or true activeUnknown passes; real 0 without the flag stays valid', () => {
  expect(() => assertProductBoard(board(feature('a', KNOWN)))).not.toThrow();
  expect(() => assertProductBoard(board(feature('a', { ...KNOWN, activeUnknown: true })))).not.toThrow();
  expect(() => assertProductBoard(board(feature('c', { total: 1, completed: 0, active: 0, activeUnknown: true }, { hasDag: false, cards: [] })))).not.toThrow();
});

test('non-true activeUnknown values are rejected', () => {
  for (const bad of [false, 'true', 1, 0, null, {}, []]) {
    expect(() => assertProductBoard(board(feature('a', { ...KNOWN, activeUnknown: bad })))).toThrow('Invalid product feature');
  }
});

test('the flag never skips the old required numeric checks', () => {
  for (const counts of [
    { total: 4, completed: 1, blocked: 2, activeUnknown: true },
    { total: 4, completed: 1, active: null, blocked: 2, activeUnknown: true },
    { total: 4, completed: 1, active: -1, blocked: 2, activeUnknown: true },
    { total: 4, completed: 1, active: Number.NaN, blocked: 2, activeUnknown: true },
    { total: 4, active: 0, blocked: 2, activeUnknown: true },
    { completed: 1, active: 0, blocked: 2, activeUnknown: true },
    { total: 4, completed: 1, active: 0, activeUnknown: true },
  ]) expect(() => assertProductBoard(board(feature('a', counts)))).toThrow('Invalid product feature');
});

test('old invalid counts are still rejected without the flag', () => {
  for (const counts of [{ total: 4, completed: 1, blocked: 2 }, { total: 4, completed: 1, active: 1 }, { total: '4', completed: 1, active: 1, blocked: 0 }]) {
    expect(() => assertProductBoard(board(feature('a', counts)))).toThrow('Invalid product feature');
  }
});
