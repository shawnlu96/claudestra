/** Opt-in production TV1 harness with synthetic 409s; UIEDIT_BASELINE records the pinned unfixed head. */
import { expect, test } from 'bun:test';
import { chromium, type Page } from 'playwright-core';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateTeamFixture } from '../web/features/collab/shared/team-fixture-gen';
import { execFixtureView } from '../web/features/collab/shared/exec/exec-fixture';
import { canonicalJson } from '../web/features/collab/shared/approve/approve-model';
import { sha256, type TaskCard } from '../web/features/collab/shared/task/task-model';
import { parseCommand } from '../src/lib/shared-ledger-contract-v2';
import { shotIssues } from './helpers/ui-shot-checks';

const out = process.env.UIEDIT_SHOTS_DIR, baseline = process.env.UIEDIT_BASELINE === '1';
const now = 1791699762879, mineTitle = '我的标题草稿', minePlan = '我的规划草稿';
// UIEDIT2 compares against UIEDIT1 as merged into main (PR #1146).
const baselineHead = '7c1eae1eedb87dbcb66d2d858381d64dbb191916';
async function buildHarness(bundle: string, language: 'zh' | 'en' = 'zh') {
  let entry = 'web/features/collab/shared/exec/fixture-harness.tsx';
  if (language === 'en') {
    // The harness mounts no I18nInit; switch language after the first render as layout's second pass does.
    const wrapper = join(bundle, 'entry', 'fixture-harness.tsx');
    mkdirSync(join(bundle, 'entry'));
    await Bun.write(wrapper, `import { setLang } from ${JSON.stringify(resolve('web/lib/i18n.tsx'))};
import ${JSON.stringify(resolve(entry))};
setLang('en');\n`);
    entry = wrapper;
  }
  // Bun's in-test plugin builds resolve aliases differently; use the same isolated bundler process for both versions.
  const script = String.raw`const bundle = ${JSON.stringify(bundle)}, baseline = ${baseline}, baselineHead = ${JSON.stringify(baselineHead)};
  const result = await Bun.build({ entrypoints: [${JSON.stringify(entry)}], target: 'browser',
    outdir: bundle, tsconfig: 'web/tsconfig.json', plugins: baseline ? [{ name: 'pinned-task-editor', setup(builder) {
      builder.onLoad({ filter: /(\/task\/(task-model\.ts|task-forms\.tsx)|\/i18n-dict-shared-ledger-v2\.ts)$/ }, ({ path }) => {
        const source = Bun.spawnSync(['git', 'show', baselineHead + ':' + path.slice(process.cwd().length + 1)]);
        if (source.exitCode) throw Error(source.stderr.toString());
        return { contents: source.stdout.toString(), loader: path.endsWith('.tsx') ? 'tsx' : 'ts' };
      });
    } }] : [] });
  if (!result.success) throw new AggregateError(result.logs, 'fixture build failed');`;
  const proc = Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' });
  const [exit, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exit) throw Error(stderr);
}
const zhNames = { team: '团队', exec: '共享执行', edit: '编辑', title: '标题', plan: '规划说明' };
const enNames = { team: 'Team', exec: 'Shared execution', edit: 'Edit', title: 'Title', plan: 'Plan' };
async function openEditor(page: Page, url: string, width: number, title: string, names = zhNames) {
  await page.goto(url);
  await page.getByText(title, { exact: true }).first().waitFor();
  await page.getByRole(width < 700 ? 'button' : 'tab', { name: names.team, exact: true }).first().click();
  await page.getByRole('region', { name: names.exec, exact: true }).getByRole('button', { name: names.edit, exact: true }).click();
  await page.getByLabel(names.title, { exact: true }).fill(mineTitle);
  // In English 'Plan' is also a substring of the planning panel's Edit plan button label.
  await (names === enNames ? page.getByRole('textbox', { name: names.plan, exact: true })
    : page.getByLabel(names.plan, { exact: false })).fill(minePlan);
}
function serveFixture(fx: ReturnType<typeof generateTeamFixture>, bundle: string) {
  const detail = fx.details[0]!;
  const view = execFixtureView(detail.feature.id, detail.tasks[0]?.taskId ?? 'task');
  const base = view.tasks[0]!;
  let latest: TaskCard = base, posts: unknown[] = [], conflicts = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    if (path === '/__reset') {
      posts = []; conflicts = 0;
      latest = { ...base, stage: url.searchParams.get('stage') ?? 'build', rev: base.rev + 1, specRev: base.specRev + 1,
        title: '最新标题', plan: '最新规划', spec: { ...base.spec, summary: '同事更新的规格' } };
      return Response.json({ ok: true });
    }
    if (path === '/app-config.json') return Response.json({ mode: 'direct', fp: 'local', machineName: 'fixture', version: '' });
    if (path === '/api/v1/shared-ledger/features') return Response.json({ ...fx.list,
      features: fx.list.features.map(feature => ({ ...feature, authorityMode: 'execution' })) });
    if (path.startsWith('/api/v1/shared-ledger/features/')) return Response.json({ ...detail,
      feature: { ...detail.feature, authorityMode: 'execution' } });
    if (path === '/api/v1/shared-projects/snapshot') return Response.json({ v: 1, peers: [], localProjects: [],
      identity: { subject: 'owner:self', kind: 'person', centerId: 'center', teamId: 'team-a', personId: 'person-a', instanceId: 'local' },
      teamRole: { available: true, value: 'owner' }, capabilities: { invite: { available: true }, leave: { available: true } },
      projects: [{ centerId: 'center', teamId: 'team-a', projectId: 'claude-orchestrator', name: 'Synthetic project', rev: 1,
        status: 'active', projectRole: { available: true, value: 'owner' }, localProjectIds: [] }] });
    if (path.startsWith('/api/v1/shared-feature-proposals')) return Response.json({ ok: true, operations: [], proposals: [] });
    if (path.startsWith('/api/v1/shared-exec/features/')) return Response.json({ ...view, pendingAsks: [] });
    if (path === '/api/v1/shared-exec/commands') {
      const body = parseCommand(await req.json()); posts.push(body);
      if (!conflicts++) return Response.json({ error: 'conflict', currentRev: latest.rev, latest }, { status: 409 });
      return Response.json({ status: 'committed', receipt: { schemaVersion: 2, teamId: body.teamId, projectId: body.projectId,
        requestId: body.requestId, commandDigest: await sha256(canonicalJson(body)), command: body.type,
        serverSeq: 41, serviceGeneration: body.serviceGeneration, result: { epoch: body.epoch, operationId: null } } });
    }
    if (path.startsWith('/api/')) return Response.json({ error: 'outside synthetic fixture' }, { status: 404 });
    if (path.endsWith('.js') || path.endsWith('.css')) return new Response(Bun.file(join(bundle, path.slice(1))));
    if (path !== '/') return new Response(null, { status: 404 });
    return new Response(`<!doctype html><html data-theme="${url.searchParams.get('theme')}"><head>
      <link rel="stylesheet" href="/fixture-harness.css"><style>
      html,body{margin:0;font:14px system-ui}button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
      h2,h5{margin:0}*{box-sizing:border-box}</style></head><body><div id="root"></div>
      <script type="module" src="/fixture-harness.js"></script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
  } });
  return { server, get latest() { return latest; }, get posts() { return posts; } };
}
async function shootSpec(page: Page, editor: ReturnType<Page['locator']>, width: number, theme: string) {
  await editor.scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
  const issues = await shotIssues(page);
  expect(issues).toEqual([]);
  const file = `${width}-${theme}-spec-${baseline ? 'before' : 'after'}.png`;
  await page.screenshot({ path: resolve(out!, file), fullPage: true });
  return { file, width, theme, shotIssues: issues, alertsAfterRefresh: await editor.getByRole('alert').count() };
}
test.skipIf(!out)('[验收线 4] task conflict refresh baseline/fixed desktop/mobile light/dark with copy and discard', async () => {
  const bundle = mkdtempSync(join(tmpdir(), 'uiedit-bundle-'));
  await buildHarness(bundle); mkdirSync(out!, { recursive: true });
  const fx = generateTeamFixture({ features: 1, now }), detail = fx.details[0]!;
  // Use a readable synthetic feature id because the editor displays it as an anchor, not as a title.
  detail.feature.id = 'feature-audit';
  const fixture = serveFixture(fx, bundle), { server } = fixture;
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const evidence: object[] = [];
  try {
    for (const width of [390, 1200]) for (const theme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width, height: 1600 }, colorScheme: theme });
      page.setDefaultTimeout(5000);
      const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(`Date.now = () => ${now};`);
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.url.origin });
      await page.request.get(`${server.url}__reset?stage=build`);
      await openEditor(page, `${server.url}?mode=on&theme=${theme}`, width, detail.feature.title);
      const editor = page.locator('section').filter({ has: page.getByRole('heading', { name: '编辑 spec 卡', exact: true }) }).last();
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('button', { name: '刷新版本并保留草稿', exact: true }).waitFor();
      expect(fixture.posts.length).toBe(1);
      expect(await page.getByLabel('标题', { exact: true }).inputValue()).toBe(mineTitle);
      expect(await page.getByLabel('规划说明', { exact: false }).inputValue()).toBe(minePlan);
      expect(await editor.getByRole('button', { name: '保存', exact: true }).isEnabled()).toBe(false);
      await page.getByRole('button', { name: '刷新版本并保留草稿', exact: true }).click();
      expect(fixture.posts.length).toBe(1);
      await page.getByLabel('新规格摘要', { exact: false }).fill('新规格草稿');
      await page.getByLabel('改规格原因', { exact: false }).fill('需求更新');
      const submit = page.getByRole('button', { name: '提交新 specRev', exact: true });
      // The UIEDIT1 baseline already enables the locked-field submit, so both runs expect it enabled.
      expect(await submit.isEnabled()).toBe(true);
      // UIEDIT2 [验收线 3]: the explicit refresh leaves no standing alert; the area is titled 保留修改.
      const alertsAfterRefresh = await editor.getByRole('alert').count();
      if (!baseline) {
        expect(alertsAfterRefresh).toBe(0);
        expect(await editor.getByText('当前版本已更新；草稿仍在。').count()).toBe(0);
        expect(await editor.getByText('保留修改', { exact: true }).count()).toBe(1);
      }
      await editor.scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
      const issues = await shotIssues(page);
      expect(issues).toEqual([]);
      const file = `${width}-${theme}-${baseline ? 'before' : 'after'}.png`;
      await page.screenshot({ path: resolve(out!, file), fullPage: true });
      evidence.push({ file, width, theme, shotIssues: issues, postsBeforeExplicitSubmit: fixture.posts.length, alertsAfterRefresh });
      if (!baseline) {
        for (const [label, value] of [['标题', mineTitle], ['规划', minePlan]]) {
          const item = page.getByRole('region', { name: `保留修改：${label}`, exact: true });
          expect(await item.getByText(value, { exact: true }).count()).toBe(1);
          await item.getByRole('button', { name: '复制', exact: true }).click();
          await item.getByRole('status').waitFor();
          expect(await page.evaluate<string>('navigator.clipboard.readText()')).toBe(value);
        }
        await page.getByRole('region', { name: '保留修改：规划', exact: true }).getByRole('button', { name: '放弃', exact: true }).click();
        expect(await page.getByRole('region', { name: '保留修改：规划', exact: true }).count()).toBe(0);
        expect(await page.getByLabel('新规格摘要', { exact: false }).inputValue()).toBe('新规格草稿');
        await submit.click(); await editor.getByRole('status', { name: '', exact: true }).filter({ hasText: '已保存' }).waitFor();
        expect(fixture.posts.length).toBe(2);
        expect(fixture.posts[1]).toMatchObject({ type: 'task.spec', payload: { expectedRev: fixture.latest.rev, expectedSpecRev: fixture.latest.specRev } });
        expect((fixture.posts[1] as { payload: object }).payload).not.toHaveProperty('title');
        expect((fixture.posts[1] as { payload: object }).payload).not.toHaveProperty('plan');
        expect(await page.getByRole('region', { name: '保留修改：标题', exact: true }).count()).toBe(1);
        // The second scenario exercises the hidden-summary conflict through the same production panel and transport.
        await page.request.get(`${server.url}__reset?stage=spec`);
        await openEditor(page, `${server.url}?mode=on&theme=${theme}`, width, detail.feature.title);
        await editor.getByRole('button', { name: '保存', exact: true }).click();
        await page.getByRole('button', { name: '刷新版本并保留草稿', exact: true }).click();
        expect(fixture.posts.length).toBe(1);
        // UIEDIT2 [验收线 2]: both sides changed the still-editable plan; the colleague's value stays visible.
        const contested = page.getByRole('region', { name: '最新版本：规划', exact: true });
        expect(await contested.getByText('最新规划', { exact: true }).count()).toBe(1);
        expect(await contested.getByText(minePlan, { exact: true }).count()).toBe(1);
        expect(await contested.getByRole('button', { name: '用最新', exact: true }).count()).toBe(1);
        expect(await page.getByLabel('规划说明', { exact: false }).inputValue()).toBe(minePlan);
        evidence.push(await shootSpec(page, editor, width, theme));
        await page.getByLabel('标题', { exact: true }).fill('刷新后标题');
        expect(await editor.getByRole('button', { name: '保存', exact: true }).isEnabled()).toBe(true);
        await editor.getByRole('button', { name: '保存', exact: true }).click();
        await editor.getByRole('status').filter({ hasText: '已保存' }).waitFor();
        expect(fixture.posts[1]).toMatchObject({ type: 'task.set', payload: { expectedRev: fixture.latest.rev, expectedSpecRev: fixture.latest.specRev,
          patch: { title: '刷新后标题', plan: minePlan } } });
      }
      else {
        // Baseline: the same spec-stage refresh, for the before/after pair of the both-sides-changed plan.
        await page.request.get(`${server.url}__reset?stage=spec`);
        await openEditor(page, `${server.url}?mode=on&theme=${theme}`, width, detail.feature.title);
        await editor.getByRole('button', { name: '保存', exact: true }).click();
        await page.getByRole('button', { name: '刷新版本并保留草稿', exact: true }).click();
        evidence.push(await shootSpec(page, editor, width, theme));
      }
      expect(errors).toEqual([]); await page.close();
    }
    await Bun.write(resolve(out!, 'evidence.json'), JSON.stringify({ baseline, baselineHead,
      fixture: 'web/features/collab/shared/exec/fixture-harness.tsx', evidence }, null, 2));
  } finally { await browser.close(); server.stop(true); rmSync(bundle, { recursive: true, force: true }); }
}, 120000);

test.skipIf(!out)('[验收线 1] English conflict area at 1200 light/dark: all copy English, comparison column Latest', async () => {
  const bundle = mkdtempSync(join(tmpdir(), 'uiedit-bundle-'));
  await buildHarness(bundle, 'en'); mkdirSync(out!, { recursive: true });
  const fx = generateTeamFixture({ features: 1, now }), detail = fx.details[0]!;
  detail.feature.id = 'feature-audit';
  const fixture = serveFixture(fx, bundle), { server } = fixture;
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const evidence: object[] = [];
  try {
    for (const theme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width: 1200, height: 1600 }, colorScheme: theme });
      page.setDefaultTimeout(5000);
      const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(`Date.now = () => ${now};`);
      await page.request.get(`${server.url}__reset?stage=build`);
      await openEditor(page, `${server.url}?mode=on&theme=${theme}`, 1200, detail.feature.title, enNames);
      const editor = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Edit spec task', exact: true }) }).last();
      await editor.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('button', { name: 'Refresh version and retain draft', exact: true }).click();
      expect(fixture.posts.length).toBe(1);
      await editor.scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
      const issues = await shotIssues(page);
      expect(issues).toEqual([]);
      const file = `1200-${theme}-en-${baseline ? 'before' : 'after'}.png`;
      await page.screenshot({ path: resolve(out!, file), fullPage: true });
      // The conflict area minus the synthetic user and colleague values; anything CJK left is untranslated copy.
      const area = (await editor.locator('section[role="region"]').allInnerTexts()).join('\n');
      const copy = [mineTitle, minePlan, '最新标题', '最新规划'].reduce((text, value) => text.replaceAll(value, ''), area);
      const untranslated = copy.match(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/g) ?? [];
      evidence.push({ file, width: 1200, theme, language: 'en', shotIssues: issues, untranslated });
      if (!baseline) {
        expect(untranslated).toEqual([]);
        expect(copy).toContain('Latest'); expect(copy).toContain('My edit'); expect(copy).not.toContain('Fresh');
        expect(await editor.getByText('Retained edits', { exact: true }).count()).toBe(1);
        expect(await editor.getByRole('alert').count()).toBe(0);
      }
      expect(errors).toEqual([]); await page.close();
    }
    await Bun.write(resolve(out!, 'evidence-en.json'), JSON.stringify({ baseline, baselineHead,
      fixture: 'web/features/collab/shared/exec/fixture-harness.tsx', evidence }, null, 2));
  } finally { await browser.close(); server.stop(true); rmSync(bundle, { recursive: true, force: true }); }
}, 120000);
