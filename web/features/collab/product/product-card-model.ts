/** 项目地图卡片的尺寸与显示模型：布局、桌面卡共用，手机仍使用旧正文。 */
import type { ProductFeature, ProductFrontierItem } from '../../../lib/api/product-board-types';
import { nodeClasses } from '../../../lib/product-node-counts';
import { READY_WORD, stageWord } from '../../../lib/owner-words';

export const CARD_W = 272, CHIP_W = 176, CHIP_H = 34;

/** 前沿已经由服务端排好；只用 active 的差额补足被服务端截断的行。旧团队源没有前沿，不出任务区。 */
export function cardTasks(f: ProductFeature) {
  const frontier = f.frontier ?? [];
  const active = nodeClasses(frontier.map(r => ({ ...r, deferred: false, deps: [] }))).filter(c => c === 'active').length;
  const more = f.frontier ? Math.max(0, frontier.length - 3) + Math.max(0, f.counts.active - active) : 0;
  return { rows: frontier.slice(0, 3), more };
}

export function cardHeight(f: ProductFeature): number {
  const { rows, more } = cardTasks(f), n = rows.length;
  return 75 + (n ? 6 + n * 21 : 0) + (more ? 17 : 0) + (more && !n ? 6 : 0);
}

/** 冻结覆盖阶段；planned 没绑卡，不拿它去查阶段词表。 */
export function frontierStage(r: ProductFrontierItem, tr: (word: string, params?: Record<string, string | number>) => string = w => w): string {
  const word = r.frozen ? '冻结' : r.stage === 'planned' ? READY_WORD : r.stage === null ? '读不到' : stageWord(r.stage);
  return tr(word) + (r.round > 1 ? ' ' + tr('第 {n} 轮', { n: r.round }).replace('{n}', String(r.round)) : '');
}

export function elapsedTime(since: number | null, now: number): { word: string; n: number } | null {
  if (since === null) return null;
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  return minutes < 60 ? { word: '{n} 分', n: minutes } : minutes < 1440
    ? { word: '{n} 小时', n: Math.floor(minutes / 60) } : { word: '{n} 天', n: Math.floor(minutes / 1440) };
}

/** 只格式化服务端认定的 stale，不在网页重新判定 24 小时门槛。 */
export function staleBadge(at: number | null | undefined, now: number): { word: string; n?: number } {
  if (at == null) return { word: '久未动' };
  const hours = Math.max(0, Math.floor((now - at) / 3600_000));
  return hours < 48 ? { word: '{n} 小时没动', n: hours } : { word: '{n} 天没动', n: Math.floor(hours / 24) };
}

/** 缺失的 waiting 自动为 0；异常重叠计数按条的剩余宽度截断，避免撑出卡框。 */
export function progressSegments(c: ProductFeature['counts']) {
  const parts = [
    ['completed', '完成', c.completed], ['active', '在跑', c.activeUnknown ? 0 : c.active], ['blocked', '受阻', c.blocked ?? 0],
    ['ready', READY_WORD, c.ready ?? 0], ['waiting', '在等前置', c.waiting ?? 0],
  ] as const;
  let left = c.total;
  const segments = parts.map(([key, word, count]) => {
    const n = Math.min(left, Math.max(0, count));
    left -= n;
    return { key, word, count, width: c.total ? n / c.total * 100 : 0 };
  });
  return [...segments, { key: 'rest', word: '其他', count: left, width: c.total ? left / c.total * 100 : 0 }].filter(p => p.width > 0);
}
