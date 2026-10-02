/** Opt-in isolated headless UI tests. Output location is supplied by the runner; no production data or services. */
import { expect, test } from 'bun:test';
import { chromium, type Page } from 'playwright-core';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { board, feature as dagFeature, node } from './web-collab-dag-fixture';
import { product } from './web-product-board-fixture.test';

const out = process.env.PRODUCT_BOARD_SHOTS_DIR;
const enabled = !!out;
const snapshot = board(product.features.map(f => dagFeature(f.id, f.hasDag ? [node('A', 'done'), node('B', 'active', ['A'], { since: Date.UTC(2026, 9, 1, 23) }), node('C', 'idle', ['B'])] : [],
  { title: f.title, status: f.status, currentVersion: f.version })));

async function baseline(path: string) {
  const p = Bun.spawn(['git', 'show', `1307554e:${path}`], { stdout: 'pipe', stderr: 'pipe' });
  const source = await new Response(p.stdout).text();
  if (await p.exited) throw new Error(await new Response(p.stderr).text());
  return source.replaceAll('"./', '"../dag/');
}

async function serveFixture(version: 'before' | 'after', output: string) {
  const dir = resolve('web/features/collab/product');
  const entry = resolve(dir, '.product-shot.tsx');
  const oldPanes = resolve(dir, '.before-panes.tsx'), oldUi = resolve(dir, '.before-ui.ts');
  const temporary = [entry];
  try {
    if (version === 'before') {
      temporary.push(oldPanes, oldUi);
      await Bun.write(oldUi, await baseline('web/features/collab/dag/use-dag-ui.ts'));
      await Bun.write(oldPanes, (await baseline('web/features/collab/dag/use-dag-panes.tsx')).replace('"../dag/use-dag-ui"', '"./.before-ui"'));
    }
    await Bun.write(entry, `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import {useDagPanes} from '${version === 'before' ? './.before-panes' : '../dag/use-dag-panes'}';
      import s from '../collab.module.css';import {fillParams} from '@/lib/i18n-fill';
      function Fixture(){const [sel,select]=useState(null);const [rev,setRev]=useState(1);
        window.refresh=()=>setRev(x=>x+1);
        const narrow=innerWidth<600;const pane=useDagPanes({project:'p',rev,now:${Date.UTC(2026, 9, 2, 0)},narrow,
          agents:[],actions:new Map(),busy:new Map(),hot:null,sel,select,close:()=>select(null),tr:fillParams,pickTask:id=>window.clicked=id});
        return <div className={s.tokens} style={{height:'100vh',display:'flex',flexDirection:'column',background:'var(--bg)'}}>
          {narrow?pane.mobile(<div>旧列表</div>):pane.center(<div>旧画布</div>,<div>团队</div>)}
          {sel&&<output>{JSON.stringify(sel)}</output>}</div>}
      createRoot(document.getElementById('root')).render(<Fixture/>);`);
    const bundle = resolve(output, `${version}-bundle`);
    const build = Bun.spawn([process.execPath, 'build', entry, '--target', 'browser', '--outdir', bundle], { stdout: 'pipe', stderr: 'pipe' });
    if (await build.exited) throw new Error(await new Response(build.stderr).text());
    const files = readdirSync(bundle);
    return Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/app-config.json') return Response.json({ mode: 'direct' });
      if (path.endsWith('/product')) return Response.json(product);
      if (path.endsWith('/dag')) return Response.json(snapshot);
      if (path === '/favicon.ico') return new Response(null, { status: 204 });
      if (path !== '/') return new Response(Bun.file(resolve(bundle, path.slice(1))));
      return new Response(`<html><head>${files.filter(f => f.endsWith('.css')).map(f => `<link rel="stylesheet" href="/${f}">`).join('')}
        <style>*{box-sizing:border-box}body{margin:0;font-family:system-ui}button{font:inherit;border:0;background:none;padding:0;color:inherit}</style></head>
        <body><div id="root"></div><script src="/${files.find(f => f.endsWith('.js'))}"></script></body></html>`,
      { headers: { 'Content-Type': 'text/html' } });
    } });
  } finally { for (const path of temporary) unlinkSync(path); }
}

async function noOverflow(page: Page) {
  expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
}

test.skipIf(!enabled)('product and sub-DAG before/after light/dark at 390/1400, navigation and cards', async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    for (const version of ['before', 'after'] as const) {
      const server = await serveFixture(version, out);
      try {
        for (const theme of ['light', 'dark']) for (const width of [390, 1400]) {
          const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'Asia/Tokyo' });
          const errors: string[] = [];
          page.on('pageerror', e => errors.push(e.message));
          await page.goto(server.url.toString());
          await page.evaluate(`document.documentElement.dataset.theme = '${theme}'`);
          await page.getByText('调度与自动派单', { exact: true }).first().waitFor();
          await noOverflow(page);
          await page.screenshot({ path: resolve(out, `${version}-${theme}-${width}-product.png`) });
          if (version === 'after') {
            if (width === 1400) expect(await page.getByRole('tab', { name: '子 DAG', exact: true }).isDisabled()).toBe(true);
            expect(await page.getByRole('progressbar').count()).toBe(3);
            await page.getByRole('button', { name: /1 已完成/ }).click();
            expect(await page.getByRole('progressbar').count()).toBe(4);
            await page.getByRole('button', { name: /1 已完成/ }).click();
            expect(await page.getByRole('tab', { name: '谁在干活' }).count()).toBe(1);
            await page.getByRole('button', { name: /调度与自动派单/ }).click();
            await page.getByRole('navigation').getByRole('button', { name: '产品 DAG' }).waitFor();
            expect(await page.getByText('产品与团队视图', { exact: true }).count()).toBe(0);
            await noOverflow(page);
            await page.screenshot({ path: resolve(out, `after-${theme}-${width}-subdag.png`) });
            await page.getByRole('navigation').getByRole('button').click();
            await page.getByRole('button', { name: /下一步探索/ }).click();
            await page.getByText('还没有子 DAG').waitFor();
            await page.screenshot({ path: resolve(out, `after-${theme}-${width}-cards.png`) });
            await page.getByRole('button', { name: /验证新产品方向/ }).click();
            expect(await page.evaluate<string>('window.clicked')).toBe('T-card');
            await page.getByRole('navigation').getByRole('button').click();
            if (width === 390) {
              const boxes = await page.evaluate<{ w: number; h: number }[]>(
                `Array.from(document.querySelectorAll('button')).map(e=>e.getBoundingClientRect()).map(r=>({w:r.width,h:r.height}))`);
              expect(boxes.every(b => b.w >= 44 && b.h >= 44)).toBe(true);
            }
          }
          expect(errors).toEqual([]);
          await page.close();
        }
      } finally { server.stop(true); }
    }
  } finally { await browser.close(); }
}, 60000);

test.skipIf(!enabled)('404/500/timeout/missing fields return grouped DAG and automatically retry', async () => {
  if (!out) return;
  const server = await serveFixture('after', out);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    for (const failure of ['404', '500', 'timeout', 'missing']) {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      let calls = 0;
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/product', async route => {
        calls++;
        if (calls > 1) return route.fulfill({ json: product });
        if (failure === 'timeout') { await new Promise(r => setTimeout(r, 10500)); return route.abort(); }
        return route.fulfill({ status: failure === 'missing' ? 200 : Number(failure), json: failure === 'missing' ? {} : { error: failure } });
      });
      await page.goto(server.url.toString());
      await page.getByRole('tab', { name: '子 DAG', exact: true }).waitFor();
      await page.getByText('调度与自动派单', { exact: true }).first().waitFor();
      expect(await page.getByText('这部分出错了').count()).toBe(0);
      await page.getByRole('tab', { name: '产品 DAG', exact: true }).waitFor({ timeout: 16000 });
      expect(calls).toBeGreaterThan(1);
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally { await browser.close(); server.stop(true); }
}, 60000);
