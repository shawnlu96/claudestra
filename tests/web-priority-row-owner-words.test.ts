import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { BANNED_OWNER_WORDS, ownerWordEn, ownerWordsTr, PRIORITY_WORDS } from '../web/lib/owner-words';
import { testChildEnv } from './test-env';

export const PRIORITY_NOW = Date.UTC(2026, 9, 14, 4);
export const priorityRows = (['explicit', 'feature', 'system'] as const).map((source, index) => ({
  key: `P${index + 1}`, target: { kind: 'task' as const, id: `P${index + 1}` }, taskId: `P${index + 1}`,
  featureId: index === 1 ? 'module-export' : null, nodeKey: null, title: ['Export preview', 'Export validation', 'Sync retry'][index]!,
  feature: index === 1 ? 'Export' : null, stage: 'build', state: 'working', reason: '执行中', since: PRIORITY_NOW - 90 * 60_000, escalation: '',
  priority: { recordId: null, rev: 0, effective: 'now' as const, explicit: source === 'explicit' ? 'now' as const : null,
    source, inheritedFrom: index === 1 ? 'module-export' : null, order: index === 2 ? null : index, note: null },
}));
export const prioritySnapshot = {
  project: 'proj-map', now: PRIORITY_NOW, stallThresholdMs: 3600_000, version: 'fixture', rows: priorityRows, canWrite: true,
  modes: Object.fromEntries(['priorityPanel', 'prioritySort', 'priorityNowStart', 'priorityStall'].map(key =>
    [key, { mode: 'observe', rev: 0, available: true }])), order: { members: [], rev: 0 },
};

const ownerText = (html: string) => html.replace(/\s(?:class|data-[\w-]+)="[^"]*"/g, '');

test('UXTERM6: render explicit/module/system sources without banned owner words in text, title or aria', () => {
  const repo = process.env.PRIORITY_WORDS_TEST_REPO ?? resolve(import.meta.dir, '..');
  const script = `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { PriorityPanel } from './features/collab/priority/priority-panel.tsx';
    console.log(renderToStaticMarkup(createElement(PriorityPanel, {
      project: 'proj-map', now: ${PRIORITY_NOW}, data: ${JSON.stringify(prioritySnapshot)}, error: '', stale: false,
      reload: async () => {}, onTask() {}, onNode() {},
    })));
  `;
  const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e', script], {
    cwd: resolve(repo, 'web'), env: testChildEnv(), stdout: 'pipe', stderr: 'pipe',
  });
  expect(child.exitCode).toBe(0);
  const html = ownerText(child.stdout.toString());
  expect(html.match(/<article(?: |>)/g)?.length).toBe(3);
  expect(BANNED_OWNER_WORDS.filter(word => html.includes(word))).toEqual([]);
  for (const word of ['owner 显式登记', '跟随所属模块', '系统缺省', '模块：Export', '不属于任何模块']) expect(html).toContain(word);
});

test('UXTERM6: every priority word has English, matching parameters, and no banned terms', () => {
  const en = ownerWordsTr('en');
  const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const zh of Object.values(PRIORITY_WORDS)) {
    expect(ownerWordEn(zh)).toBeDefined();
    expect(holes(en(zh))).toEqual(holes(zh));
    expect(en(zh)).not.toMatch(/[\u4e00-\u9fff]/);
    for (const value of [zh, en(zh)]) expect(BANNED_OWNER_WORDS.filter(word => value.includes(word))).toEqual([]);
  }
});

/** Real project page, real panel; deterministic rows. Opt in for browser and paired screenshots.
 * PRIORITY_WORDS_SHOTS_DIR=ui-shots PRIORITY_WORDS_BASE_REPO=.ui-base bun test tests/web-priority-row-owner-words.test.ts
 */
test.skipIf(!process.env.PRIORITY_WORDS_SHOTS_DIR)('UXTERM6: project priority panel at 1440/390; live English switch, menus and tooltips', async () => {
  const { chromium } = await import('playwright-core');
  const { mkdirSync } = await import('node:fs');
  const { bundleProjectTabs, MAP, ptRoute } = await import('./helpers/project-tabs-shots');
  const { serveToday, tailwindCss } = await import('./helpers/today-shots');
  const { guardedPage } = await import('./helpers/collab-fixture-serve');
  const out = resolve(process.env.PRIORITY_WORDS_SHOTS_DIR!);
  const base = process.env.PRIORITY_WORDS_BASE_REPO;
  const sides = [...(base ? [{ phase: 'before', repo: resolve(base) }] : []), { phase: 'after', repo: resolve(import.meta.dir, '..') }];
  const shots: { phase: string; view: string; size: string; file: string }[] = [];
  const evidence: Record<string, unknown> = {};
  const snapshot = { ...prioritySnapshot, rows: priorityRows.map((row, index) => ({ ...row,
    state: ['dependency', 'uncertain', 'unknown'][index],
    reason: ['等待依赖：A、B', '外部结果不明，需核实', '未绑卡计划：开工及停滞数据未知'][index],
  })) };
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
  try {
    for (const { phase, repo } of sides) {
      const dir = resolve(out, `bundle-${phase}`);
      await bundleProjectTabs(repo, dir, 'local');
      // Use the established project-page entry, exposing only a language-switch test hook.
      const entry = resolve(dir, 'entry.ts');
      await Bun.write(entry, (await Bun.file(entry).text()) + `
import { setLang } from ${JSON.stringify(resolve(repo, 'web/lib/i18n.tsx'))};
window.__priorityLang = setLang;`);
      const build = Bun.spawn([process.execPath, 'build', entry, '--target', 'browser', '--outdir', resolve(dir, 'dist'),
        '--tsconfig-override', 'web/tsconfig.json'], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
      if (await build.exited) throw new Error(await new Response(build.stderr).text());
      const server = serveToday(resolve(dir, 'dist'), await tailwindCss(repo), 'local', (path, req) => {
        if (path === `/ledger/${MAP}/priority`) return Response.json(snapshot);
        if (path === `/ledger/${MAP}/priority/history`) return Response.json({ history: [] });
        return ptRoute(path, new URL(req.url).searchParams);
      });
      try {
        for (const width of [1440, 390]) {
          const height = width === 390 ? 844 : 900, size = `${width}x${height}`;
          const g = await guardedPage(browser, String(server.url), { width });
          try {
            await g.page.setViewportSize({ width, height });
            await g.page.clock.setFixedTime(new Date(PRIORITY_NOW));
            await g.page.goto(String(server.url));
            await g.page.waitForFunction('!!window.__nav && !!window.__priorityLang');
            await g.page.evaluate(`window.__nav.open(${JSON.stringify(MAP)})`);
            await g.page.locator('[data-project-tab=module]').click();
            await g.page.getByRole('tab', { name: '按人', exact: true }).click();
            const panel = g.page.locator('[data-priority-panel]');
            await panel.locator('summary').click();
            await panel.locator('article').nth(2).waitFor();
            const later = g.page.getByRole('button', { name: '以后再说' });
            if (await later.isVisible()) await later.click();
            await g.page.evaluate('document.fonts.ready');
            const read = () => g.page.evaluate<string>(`(() => { const el = document.querySelector('[data-priority-panel]'); return el.innerText + '\\n' +
              [...el.querySelectorAll('[title], [aria-label], [aria-description]')].map(e =>
              ['title', 'aria-label', 'aria-description'].map(k => e.getAttribute(k) || '').join(' ')).join('\\n'); })()`);
            const text = await read();
            if (phase === 'before') expect(text).toContain('继承 feature');
            else {
              expect(BANNED_OWNER_WORDS.filter(w => text.includes(w))).toEqual([]);
              for (const zh of [PRIORITY_WORDS.sourceExplicit, PRIORITY_WORDS.sourceModule, PRIORITY_WORDS.sourceSystem]) expect(text).toContain(zh);
              expect(await panel.locator('article').nth(1).locator('button[title]').getAttribute('title')).toContain('模块：Export');
              expect(await panel.locator('article').nth(2).locator('button[title]').getAttribute('title')).toContain('不属于任何模块');
            }
            await g.page.mouse.move(width - 5, height - 5);
            const file = `${phase}-priority-${size}.png`;
            await g.page.screenshot({ path: resolve(out, file), animations: 'disabled' });
            shots.push({ phase, view: 'priority', size, file });
            evidence[`${phase}-${size}`] = { text, errors: g.errors, external: g.external };
            await g.page.evaluate('window.__priorityLang("en")');
            await g.page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
            const enFile = `${phase}-priority-en-${size}.png`;
            await g.page.screenshot({ path: resolve(out, enFile), animations: 'disabled' });
            shots.push({ phase, view: 'priority-en', size, file: enFile });
            if (phase === 'after') {
              await panel.getByRole('heading', { name: 'Current work 3 cards' }).waitFor();
              await panel.getByRole('button', { name: 'Adjust: Export validation', exact: true }).click();
              await panel.getByRole('group', { name: 'Adjustment options' }).waitFor();
              const english = await read();
              expect(english).not.toMatch(/[\u4e00-\u9fff]/);
              expect(BANNED_OWNER_WORDS.filter(w => english.includes(w))).toEqual([]);
              for (const en of ['Explicitly set by owner', 'Follows its module', 'System default', 'Module: Export', 'Not part of any module',
                'Record for this session: Restore inheritance']) expect(english).toContain(en);
              await panel.getByRole('button', { name: 'Priority history', exact: true }).click();
              await panel.getByText('No priority history yet', { exact: true }).waitFor();
              expect(await read()).not.toMatch(/[\u4e00-\u9fff]/);
              // Switching back updates already-open menus and their aria labels too.
              await g.page.evaluate('window.__priorityLang("zh")');
              await panel.getByRole('group', { name: '调整选项' }).waitFor();
            }
            expect(g.errors).toEqual([]);
            expect(g.external).toEqual([]);
            expect(await g.page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth + 1')).toBe(true);
          } finally { await g.ctx.close(); }
        }
      } finally { server.stop(true); }
    }
    await Bun.write(resolve(out, 'manifest.json'), JSON.stringify({ v: 1, summary: '项目页优先级来源与提示换词，桌面及手机同状态对照', shots }, null, 2));
    await Bun.write(resolve(out, 'assertions.json'), JSON.stringify(evidence, null, 2));
  } finally { await browser.close(); }
}, 180_000);
