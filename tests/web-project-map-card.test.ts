/** PDCARD1 [验收线 1]：卡高、前沿截断、阶段和时长；同一模型供布局和组件使用。 */
import { expect, test } from 'bun:test';
import { cardHeight, cardTasks, elapsedTime, frontierStage, progressSegments, staleBadge } from '../web/features/collab/product/product-card-model';
import { PROJECT_MAP_NOW as now, projectMapBoard } from './helpers/project-map-fixture';

const features = projectMapBoard(now).features;
const team = features.find(f => f.id === 'f-team')!;
const row = team.frontier![0]!;

test('card heights: no frontier, two rows, five rows (three visible plus overflow)', () => {
  expect(cardHeight({ ...team, frontier: undefined })).toBe(75);
  expect(cardHeight({ ...team, counts: { ...team.counts, active: 2 }, frontier: team.frontier!.slice(0, 2) })).toBe(123);
  expect(cardHeight(team)).toBe(161);
  expect(cardHeight({ ...team, frontier: [] })).toBe(98);
});

test('more nodes includes only truncated frontier plus the active count missing from that frontier', () => {
  expect(cardTasks(team).more).toBe(2);
  expect(cardTasks({ ...team, counts: { ...team.counts, active: 7 } }).more).toBe(5);
  expect(cardTasks({ ...team, counts: { ...team.counts, active: 0 } }).more).toBe(2);
  expect(cardTasks({ ...team, frontier: undefined }).more).toBe(0);
});

test('planned, unreadable, fix round two and frozen use the owner vocabulary', () => {
  expect(frontierStage({ ...row, stage: 'planned' })).toBe('可以开工');
  expect(frontierStage({ ...row, stage: null })).toBe('读不到');
  expect(frontierStage({ ...row, stage: 'fix', round: 2 })).toBe('返工 第 2 轮');
  expect(frontierStage({ ...row, frozen: true })).toBe('冻结');
});

test('elapsed minutes, hours, days and null; future timestamps never produce negative time', () => {
  expect(elapsedTime(now - 40 * 60_000, now)).toEqual({ word: '{n} 分', n: 40 });
  expect(elapsedTime(now - 5 * 3600_000, now)).toEqual({ word: '{n} 小时', n: 5 });
  expect(elapsedTime(now - 3 * 86400_000, now)).toEqual({ word: '{n} 天', n: 3 });
  expect(elapsedTime(null, now)).toBeNull();
  expect(elapsedTime(now + 1, now)).toEqual({ word: '{n} 分', n: 0 });
});

test('stale badge uses hours below 48 hours, days thereafter, and a missing-time fallback', () => {
  expect(staleBadge(now - 47 * 3600_000, now)).toEqual({ word: '{n} 小时没动', n: 47 });
  expect(staleBadge(now - 4 * 86400_000, now)).toEqual({ word: '{n} 天没动', n: 4 });
  expect(staleBadge(null, now)).toEqual({ word: '久未动' });
});

test('progress preserves segment order, waiting count and total width, including old team counts', () => {
  const parts = progressSegments({ total: 20, completed: 4, active: 3, blocked: 2, ready: 1, waiting: 7 });
  expect(parts.map(p => [p.word, p.count])).toEqual([
    ['完成', 4], ['在跑', 3], ['受阻', 2], ['可以开工', 1], ['在等前置', 7], ['其他', 3],
  ]);
  expect(parts.reduce((n, p) => n + p.width, 0)).toBe(100);
  expect(progressSegments(team.counts).some(p => p.key === 'waiting')).toBe(false);
  expect(progressSegments({ total: 0, completed: 0, active: 0 })).toEqual([]);
  expect(progressSegments({ total: 2, completed: 2, active: 5 }).map(p => p.width)).toEqual([100]);
});
