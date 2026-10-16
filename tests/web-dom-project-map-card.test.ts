/** PDCARD1 [验收线 2]：真 DOM 的兄弟按钮、徽章、分段条、冻结和团队旧源。 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { PROJECT_MAP_NOW as now, projectMapBoard } from './helpers/project-map-fixture';

type ReactNS = typeof import('../web/node_modules/@types/react/index');
type ReactDomClient = typeof import('../web/node_modules/@types/react-dom/client');
interface El {
  textContent: string | null; getAttribute(n: string): string | null; querySelectorAll(s: string): ArrayLike<El>;
  click(): void; remove(): void; appendChild(c: El): void;
}
const webRequire = createRequire(new URL('../web/package.json', import.meta.url));
let React: ReactNS, createRoot: ReactDomClient['createRoot'], ProductView: unknown;
// 已收尾小标签按本地时区出日期；同分片别的测试会改 TZ（跨文件共享），这里钉成 UTC，结束时显式赋回原值
const savedTZ = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
beforeAll(() => {
  process.env.TZ = 'UTC';
  GlobalRegistrator.register({ url: 'http://localhost/', width: 1280, height: 800 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire('react') as ReactNS;
  ({ createRoot } = webRequire('react-dom/client') as ReactDomClient);
  ({ ProductView } = require('../web/features/collab/product/product-view.tsx') as { ProductView: unknown });
});
afterAll(async () => {
  process.env.TZ = savedTZ;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});
const tr = (s: string, p?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(p?.[k] ?? ''));
const all = (host: El, sel: string) => Array.from(host.querySelectorAll(sel));
async function mount(board = projectMapBoard(now)) {
  const doc = (globalThis as unknown as { document: { createElement(t: string): El; body: El } }).document;
  const host = doc.createElement('div'); doc.body.appendChild(host);
  const root = createRoot(host as never), featureCalls: string[] = [], taskCalls: string[] = [];
  const h = React.createElement as unknown as (...a: unknown[]) => unknown;
  await React.act(async () => root.render(h(ProductView, { board, now, tr, narrow: false,
    onFeature: (id: string) => featureCalls.push(id), onTask: (id: string) => taskCalls.push(id) }) as never));
  return { host, featureCalls, taskCalls, unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}
const click = (el: El) => React.act(async () => el.click());

test('three task buttons and two extra nodes; task and main button call their own handlers without nesting', async () => {
  const { host, featureCalls, taskCalls, unmount } = await mount();
  try {
    const card = all(host, '[data-pd-card=f-team]')[0]!;
    const tasks = all(card, ':scope > button[data-pd-task]');
    expect(tasks).toHaveLength(3);
    expect(card.textContent).toContain('还有 2 个节点');
    expect(card.textContent).toContain('机器 B');
    expect(card.textContent).toContain('返工 第 2 轮');
    await click(tasks[0]!);
    expect(taskCalls).toEqual(['t-tp-5']); expect(featureCalls).toEqual([]);
    // PDFOCUS1：单击 / 第一次 Enter 只选中；已选中再按 Enter（click 的 detail 为 0）或双击才进入
    const main = all(card, 'button').find(b => all(b, 'strong').length > 0)!;
    await click(main);
    expect(featureCalls).toEqual([]); expect(card.getAttribute('data-pd-selected')).toBe('true');
    await click(main);
    expect(featureCalls).toEqual(['f-team']);
    const Mouse = (globalThis as unknown as { MouseEvent: new (t: string, o: object) => unknown }).MouseEvent;
    await React.act(async () => (main as unknown as { dispatchEvent(e: unknown): void }).dispatchEvent(new Mouse('dblclick', { bubbles: true })));
    expect(featureCalls).toEqual(['f-team', 'f-team']); expect(taskCalls).toHaveLength(1);
    expect(all(host, 'button button')).toHaveLength(0);
    expect(all(host, '[data-pd-card=f-lend] div[data-pd-task]')).toHaveLength(1);
  } finally { await unmount(); }
});

test('badges, frozen row with no duration, detail flags, and one accessible progressbar per card', async () => {
  const board = projectMapBoard(now);
  board.features.find(f => f.id === 'f-unclosed')!.lastActivityAt = now;
  const { host, unmount } = await mount(board);
  try {
    for (const [id, text] of [['f-dispatch', '1 受阻'], ['f-sched', '4 天没动'], ['f-bgtask', '待验收'], ['f-lend', '拆自 协作底座改版']]) {
      expect(all(host, `[data-pd-card=${id}]`)[0]!.textContent).toContain(text!);
    }
    const frozen = all(host, '[data-pd-task=am-3]')[0]!;
    expect(frozen.textContent).toContain('冻结'); expect(frozen.textContent).not.toContain('天');
    expect(all(host, '[data-pd-task=am-4]')[0]!.textContent).toContain('14 天');
    for (const card of all(host, '[data-pd-card]')) {
      const f = board.features.find(f => f.id === card.getAttribute('data-pd-card'))!;
      const bars = all(card, '[role=progressbar]');
      expect(bars).toHaveLength(1);
      expect(bars[0]!.getAttribute('aria-valuenow')).toBe(String(f.counts.completed));
      expect(bars[0]!.getAttribute('aria-valuemax')).toBe(String(f.counts.total));
      expect(all(card, '[data-pd-title]')).toHaveLength(1);
      expect(all(card, '[data-pd-task]:not([data-pd-detail])')).toHaveLength(0);
    }
    expect(all(host, '[data-pd-card=f-direct] [title="在等前置 19"]')).toHaveLength(1);
    await click(all(host, 'button').find(b => b.textContent === '已收尾 8')!);
    const chip = all(host, '[data-pd-chip="done:f-unclosed"]')[0]!;
    expect(chip.textContent).toContain('10-14');
    expect(all(chip, '[title="全部完成，还没关单"]')).toHaveLength(1);
  } finally { await unmount(); }
});

test('old team source has no task region and falls back to blocked counts without requiring waiting', async () => {
  const board = projectMapBoard(now);
  const f = { ...board.features.find(f => f.id === 'f-dispatch')!, state: undefined, frontier: undefined };
  const { host, unmount } = await mount({ features: [f], deps: [] });
  try {
    expect(host.textContent).toContain('1 受阻');
    expect(all(host, '[data-pd-task]')).toHaveLength(0);
    expect(all(host, '[role=progressbar]')).toHaveLength(1);
    expect(host.textContent).not.toContain('还有');
  } finally { await unmount(); }
});
