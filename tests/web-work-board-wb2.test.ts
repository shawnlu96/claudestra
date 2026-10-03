/** Headless fixture-only screenshots; no bridge, production ledger or browser profile. */
import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorkBoard, WorkRow } from '../web/features/collab/work/work-types';
const out = process.env.WORK_BOARD_SHOTS_DIR;
const enabled = process.env.WORK_BOARD_BROWSER === '1' && !!out;
const row = (id: string): WorkRow => ({ taskId: id, featureId: null, nodeKey: null, title: '手动执行者推进协作任务',
  who: `agent-${id}`, machine: 'local', step: 'write', round: 1, since: 0, normalMinutes: 60, remainingMinutes: 90,
  overMinutes: 0, reason: null, code: null, estimate: '' });
const workers = ['CONV1', 'LC1', 'RI1', 'LQ1', 'C2', 'C3'].map(row);
const old = ['T41c', 'T44', 'T49', 'T65', 'T75', 'T76', 'T77', 'T78'].map(id => ({ ...row(id), title: '冻结的历史任务' }));
const common = { now: 60000, asOfSeq: 1, availableSlots: 6, todo: { ready: [], blocked: [] } };
const before: WorkBoard = { ...common, working: old, waiting: workers.map(r => ({ ...r, code: 'manual', reason: '退回人工（manual）：PM 人工推进' })),
  machines: { local: 8 }, completionHours: 4 };
const after: WorkBoard = { ...common, working: workers, waiting: [], machines: { local: 6 }, completionHours: 2,
  legacyTotal: 8, legacy: old.map(r => ({ taskId: r.taskId!, title: r.title, stage: 'build' })) };
test.skipIf(!enabled)('WB2 before/after 390/1400, legacy collapsed and interactive, task navigation', async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const fixture = resolve('web/features/collab/work/.wb2-shot.tsx');
  const oldView = resolve('web/features/collab/work/.wb2-before.tsx');
  const show = Bun.spawn(['git', 'show', '3f1fea65:web/features/collab/work/work-board-view.tsx'], { stdout: 'pipe', stderr: 'pipe' });
  const source = await new Response(show.stdout).text();
  if (await show.exited) throw new Error(await new Response(show.stderr).text());
  await Bun.write(oldView, source);
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    for (const [version, data] of [['before', before], ['after', after]] as const) {
      await Bun.write(fixture, `import React from 'react';import {createRoot} from 'react-dom/client';
        import {WorkBoardContent} from '${version === 'before' ? './.wb2-before' : './work-board-view'}';
        createRoot(document.getElementById('root')).render(<WorkBoardContent board={${JSON.stringify(data)}} retrying={false}
          tr={x=>x} onNode={()=>{}} onTask={id=>window.clicked=id}/>);`);
      const bundle = resolve(out, version);
      const build = Bun.spawn([process.execPath, 'build', fixture, '--target', 'browser', '--outdir', bundle], { stdout: 'pipe', stderr: 'pipe' });
      if (await build.exited) throw new Error(await new Response(build.stderr).text());
      const files = readdirSync(bundle);
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === '/favicon.ico') return new Response(null, { status: 204 });
        if (path !== '/') return new Response(Bun.file(resolve(bundle, path.slice(1))));
        return new Response(`<html><head>${files.filter(f => f.endsWith('.css')).map(f => `<link rel="stylesheet" href="/${f}">`).join('')}
          <style>:root{--text:#e9ebef;--muted:#9ca5b2;--line:#2e343e;--panel:#1a2029;--warn:#dca954;--accent:#83b5ff}
          *{box-sizing:border-box}body{margin:0;background:#121720;font-family:system-ui}#root{height:100vh}button{font:inherit}</style>
          </head><body><div id="root"></div><script src="/${files.find(f => f.endsWith('.js'))}"></script></body></html>`,
          { headers: { 'Content-Type': 'text/html' } });
      } });
      try {
        for (const width of [390, 1400]) {
          const page = await browser.newPage({ viewport: { width, height: 1100 } });
          const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
          await page.goto(server.url.toString());
          await page.getByRole('heading', { name: /在干活/ }).waitFor({ timeout: 5000 });
          expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
          if (version === 'after') {
            expect(await page.locator('details').getAttribute('open')).toBeNull();
            expect(await page.getByRole('button', { name: /T41c/ }).isVisible()).toBe(false);
            await page.getByRole('button', { name: /agent-CONV1/ }).click();
            expect(await page.evaluate<string>('window.clicked')).toBe('CONV1');
          }
          await page.screenshot({ path: resolve(out, `${version}-${width}.png`), fullPage: true });
          if (version === 'after') {
            await page.locator('summary').click();
            await page.getByRole('button', { name: /T41c/ }).click();
            expect(await page.evaluate<string>('window.clicked')).toBe('T41c');
            await page.screenshot({ path: resolve(out, `expanded-${width}.png`), fullPage: true });
            await page.locator('summary').click();
            expect(await page.getByRole('button', { name: /T41c/ }).isVisible()).toBe(false);
          }
          expect(errors).toEqual([]); await page.close();
        }
      } finally { server.stop(true); }
    }
  } finally { await browser.close(); unlinkSync(fixture); unlinkSync(oldView); }
}, 60000);
