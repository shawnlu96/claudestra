/** Opt-in real Chromium UI checks and before/after screenshots. Isolated ephemeral server, no bridge or credentials. */
import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorkBoard, WorkRow } from '../web/features/collab/work/work-types';
const enabled = process.env.WORK_BOARD_BROWSER === '1';
const out = '/Users/shawn/.claude-orchestrator/ledger/reviews/i28-WB1-shots';
const row = (id: string, patch: Partial<WorkRow> = {}): WorkRow => ({ taskId: id, featureId: 'f', nodeKey: id, title: '协作视图：看清谁在干活与剩余时间',
  who: `agent-${id}`, machine: 'local', step: 'write', round: 1, since: 85 * 60000, normalMinutes: 60, remainingMinutes: 115, overMinutes: 0,
  reason: null, code: null, estimate: '半天', ...patch });
const board: WorkBoard = { now: 90 * 60000, asOfSeq: 1, machines: { local: 2, Sekai: 1, 'HedeMacBook-Pro': 1 }, availableSlots: 3, completionHours: 8,
  working: [row('WB1', { since: 0, overMinutes: 30, remainingMinutes: 60 }), row('R9', { who: 'peer:Sekai · codex', machine: 'Sekai', step: 'review', normalMinutes: 30, remainingMinutes: 55 }),
    row('W2', { who: 'peer:HedeMacBook-Pro · claude', machine: 'HedeMacBook-Pro', step: 'publishing' }), row('M1', { who: 'agent-manual-writer', title: 'PM 人工推进 · 执行者正在写代码' })],
  waiting: [row('C5', { reason: '等审查员领单', code: 'pooled' }), row('PD2', { reason: '合并排队：前面是 W3', code: 'merge_queue' }),
    row('V2', { reason: '等 CI', code: 'ci' }), row('Q1', { reason: '等 owner', code: 'owner' })],
  todo: { ready: [row('A1')], blocked: [row('A2', { reason: '被 A1 挡住' }), row('A3', { reason: '缺规格' })] } };

test.skipIf(!enabled)('390/1400 board, segmented navigation, node/task clicks and retry retains rows', async () => {
  mkdirSync(out, { recursive: true });
  const entry = resolve('web/features/collab/work/.shot-fixture.tsx');
  await Bun.write(entry, `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {WorkBoardContent} from './work-board-view';
    const b=${JSON.stringify(board)};
    createRoot(document.getElementById('root')).render(<WorkBoardContent board={b} retrying={true} tr={x=>x}
      onNode={(f,k)=>window.clicked=f+'/'+k} onTask={id=>window.clicked=id}/>);`);
  const bundle = resolve(out, 'after-bundle');
  const proc = Bun.spawn([process.execPath, 'build', entry, '--target', 'browser', '--outdir', bundle], { stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited, error = await new Response(proc.stderr).text();
  unlinkSync(entry);
  if (code) throw new Error(error);
  const files = readdirSync(bundle);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path !== '/') return new Response(Bun.file(resolve(bundle, path.slice(1))));
    return new Response(`<html><head>${files.filter(f => f.endsWith('.css')).map(f => `<link rel="stylesheet" href="/${f}">`).join('')}
      <style>:root{--text:#e9ebef;--muted:#9ca5b2;--line:#2e343e;--panel:#1a2029;--warn:#dca954;--accent:#83b5ff}
      *{box-sizing:border-box}body{margin:0;background:#121720;font-family:system-ui}#root{height:100vh}button{font:inherit}</style></head>
      <body><div id="root"></div><script src="/${files.find(f => f.endsWith('.js'))}"></script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
  } });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    for (const width of [390, 1400]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.on('pageerror', error => console.error(error));
      await page.goto(server.url.toString());
      await page.getByText('WB1', { exact: true }).waitFor();
      expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      await page.screenshot({ path: resolve(out, `after-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: /WB1/ }).click();
      expect(await page.evaluate<string>('window.clicked')).toBe('f/WB1');
      if (width === 390) {
        await page.getByRole('tab', { name: '在等 4' }).click();
        await page.getByText('等 CI', { exact: true }).waitFor();
        await page.screenshot({ path: resolve(out, `after-${width}-waiting.png`) });
        await page.getByRole('tab', { name: '待做 3' }).click();
        await page.getByText('缺规格', { exact: true }).waitFor();
        await page.screenshot({ path: resolve(out, `after-${width}-todo.png`) });
      }
      expect(await page.getByRole('status').count()).toBe(1);
      expect(await page.getByText('这部分出错了').count()).toBe(0);
      await page.close();
    }
  } finally { await browser.close(); server.stop(true); }
}, 60000);
