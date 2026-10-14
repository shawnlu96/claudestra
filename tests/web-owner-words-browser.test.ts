/**
 * UXTERM1 A 段截图与 DOM 断言（opt-in，截图不进 git）：
 *   OWNER_WORDS_SHOTS_DIR=<仓库外目录> [OWNER_WORDS_BASE_REPO=<基线 main 的检出目录>] bun --no-env-file test tests/web-owner-words-browser.test.ts
 * 页面是合成夹具，内联在本文件里、打包到截图目录：
 *   sidebar = 三个会话行（简化行 + 真 LpBadge），分别是 low-priority 开着、用完、额度用完在等；
 *   lend    = 真 LendPanel（设置 → 借出）：一条授权（Codex 同时 3 个、每天 50 个）、两条借出中的活、额度线处在提醒态。
 * 1280 与 390、浅色；中文各拍一张，英文只断言不拍。给了 OWNER_WORDS_BASE_REPO 就用同一份数据再拍一套「改前」（只断言改前的现状）。
 * 改后每页的 document.body.innerText 不含 BANNED_OWNER_WORDS，英文下不出现 LP / feature；shotIssues 为空。
 * 回环 Bun.serve，非回环请求一律拦掉并断言为 0。协作视图那几页属于 B 段（UXTERM2）。
 */
import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { BANNED_OWNER_WORDS } from "../web/lib/owner-words";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.OWNER_WORDS_SHOTS_DIR, baseRepo = process.env.OWNER_WORDS_BASE_REPO;
const NOW = Date.parse("2026-10-14T04:00:00Z");
const VIEWS = ["sidebar", "lend"] as const;
type View = (typeof VIEWS)[number];

/** 每页必须出现的词：改前是旧词，改后是词表里的新词 */
const EXPECT: Record<"before" | "after", Record<View, string[]>> = {
  before: { sidebar: ["LP→15:00", "LP 已用完", "撞墙中"], lend: ["借出中的单", "停接线", "codex 3 · 50/d", "该家族"] },
  after: { sidebar: ["排队→15:00", "低优先级用完", "额度用完，等重置"],
    lend: ["借出中的活", "不再接新活", "同时 Codex 3 个 · 每天 50 个", "能同时跑的数量减半"] },
};

const fam = (family: string, over: Record<string, unknown>) => ({ family, warnPct: 70, stopPct: 80, weekUsedPct: 50, resetAt: NOW + 3 * 86_400_000,
  observedAt: NOW - 60_000, source: "live", freshness: "fresh", state: "below", mode: "on", limit: "none", wouldLimit: "none", granted: 3, lineCap: 3,
  available: 3, slots: 3, ...over });
const order = (n: number, over: Record<string, unknown>) => ({ orderId: `order-${n}`, peer: "team-a", family: "codex", state: "running", repo: "acme/shop",
  pr: 40 + n, taskId: `i9-T${n}`, step: "write", agent: `agent-lend-${n}`, startedAt: NOW - n * 600_000, updatedAt: NOW - 60_000, reason: null,
  notices: { start: NOW - n * 600_000 }, live: true, ...over });
const API: Record<string, unknown> = {
  "/app-config.json": { mode: "direct", fp: "local", machineName: "fixture" },
  "/api/v1/lend/grants": { writeOpen: true, maxDays: 7, shellSentence: "", peers: [{ name: "team-a", fp: "a".repeat(16) }],
    grants: [{ peer: "team-a", repos: ["acme/shop"], roles: ["write", "review"], families: { codex: 3 }, ordersPerDay: 50,
      until: new Date(NOW + 6 * 86_400_000).toISOString(), grantedAt: new Date(NOW - 86_400_000).toISOString(), paused: null, problem: null }],
    orders: [order(1, {}), order(2, { step: "review" })] },
  "/api/v1/lend/quota-lines": { ok: true, config: { status: "ok", error: null, mode: "on" }, at: NOW,
    families: [fam("codex", { weekUsedPct: 74, state: "warn", limit: "half", wouldLimit: "half", lineCap: 1, available: 1, slots: 1 }), fam("claude", { granted: 0, slots: 0 })] },
  "/api/v1/lend/claude-token": { loggedIn: true, reason: null, legacyTokenFile: null, legacyTokenEnv: false },
};

/** 入口放在仓库外（截图目录）：react 按 web/node_modules 里的路径引，不写 JSX；改前 / 改后同一份入口，只换仓库 */
async function bundle(repo: string, dir: string) {
  mkdirSync(dir, { recursive: true });
  const entry = resolve(dir, "entry.ts"), from = (f: string) => JSON.stringify(resolve(repo, f));
  await Bun.write(entry, `import { createElement as h } from ${from("web/node_modules/react/index.js")};
import { createRoot } from ${from("web/node_modules/react-dom/client.js")};
import { setLang } from ${from("web/lib/i18n.tsx")};
import { LpBadge } from ${from("web/features/fleet/lp-badge.tsx")};
import { LendPanel } from ${from("web/features/lend/lend-panel.tsx")};
import { ChatStoreProvider } from ${from("web/features/chat/chat-store.ts")};
const q = new URLSearchParams(location.search);
setLang(q.get("lang") === "en" ? "en" : "zh");
const lp = (over) => ({ lowPriority: "off", walled: false, offer: false, at: 0, ...over });
const SESSIONS = [["checkout-api", lp({ lowPriority: "on", resetsAt: "15:00", allowancePct: 40 })],
  ["search-index", lp({ lowPriority: "exhausted" })], ["billing-sync", lp({ walled: true, resetsAt: "15:00" })]];
const row = ([name, state]) => h("li", { key: name, className: "flex items-center gap-2 rounded-lg bg-base-100 px-3 py-2 text-sm" },
  h("span", { className: "min-w-0 flex-1 truncate" }, name), h(LpBadge, { lp: state }));
const sidebar = h("aside", { className: "w-72 max-w-full space-y-1 rounded-xl bg-base-200/60 p-2" }, h("ul", { className: "space-y-1" }, SESSIONS.map(row)));
const lend = h(ChatStoreProvider, null, h("div", { className: "mx-auto max-w-2xl" }, h(LendPanel)));
createRoot(document.getElementById("root")).render(h("main", { className: "min-h-screen bg-base-100 p-4 text-base-content" },
  h("p", { className: "pb-2 text-[11px] text-base-content/40" }, "synthetic fixture"), q.get("view") === "lend" ? lend : sidebar));
`);
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--outdir", resolve(dir, "dist"),
    "--tsconfig-override", "web/tsconfig.json"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  return resolve(dir, "dist");
}

/** 生产的 Tailwind 样式表（web/app/globals.css） */
async function tailwindCss(repo: string): Promise<string> {
  const req = createRequire(resolve(repo, "web/package.json")), globals = resolve(repo, "web/app/globals.css");
  return (await req("postcss")([req("@tailwindcss/postcss")({ base: resolve(repo, "web") })]).process(readFileSync(globals, "utf8"), { from: globals })).css;
}

function serve(dist: string, tw: string) {
  const files = readdirSync(dist), links = files.filter((f) => f.endsWith(".css")).map((f) => `<link rel="stylesheet" href="/${f}">`).join("");
  const page = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/tw.css">${links}</head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`;
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (path === "/tw.css") return new Response(tw, { headers: { "content-type": "text/css" } });
    if (files.includes(path.slice(1))) return new Response(Bun.file(resolve(dist, path.slice(1))));
    return Object.hasOwn(API, path) ? Response.json(API[path]) : Response.json({ ok: false, error: "not_found" }, { status: 404 });
  } });
}

test.skipIf(!out)("UXTERM1 A 段：侧栏 low-priority 徽章与借出页，1280 与 390 改前改后，改后不含禁用词", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const sides = [...(baseRepo ? [{ label: "before" as const, repo: resolve(baseRepo) }] : []), { label: "after" as const, repo: resolve(import.meta.dir, "..") }];
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, requests: Record<string, { external: string[]; errors: string[] }> = {}, texts: Record<string, string> = {};
  try {
    for (const { label, repo } of sides) {
      const server = serve(await bundle(repo, resolve(out, `bundle-${label}`)), await tailwindCss(repo));
      try {
        for (const width of [1280, 390]) for (const view of VIEWS) for (const lang of ["zh", "en"] as const) {
          const g = await guardedPage(browser, String(server.url), { width });
          await g.page.clock.install({ time: NOW });
          await g.page.goto(`${server.url}?view=${view}&lang=${lang}`);
          await (view === "lend" ? g.page.getByTestId("lend-quota-settings") : g.page.locator("li").nth(2)).waitFor();
          if (view === "lend") await g.page.locator(".font-mono", { hasText: "acme/shop#42" }).first().waitFor();
          await g.page.evaluate("document.fonts.ready");
          const name = `${label}-${view}-${width}${lang === "en" ? "-en" : ""}`, text = await g.page.evaluate<string>("document.body.innerText");
          texts[name] = text;
          requests[name] = { external: [...g.external], errors: [...g.errors] };
          if (lang === "zh") {
            await g.page.screenshot({ path: resolve(out, `${name}.png`), fullPage: true });
            issues[name] = await shotIssues(g.page);
            expect({ name, missing: EXPECT[label][view].filter((w) => !text.includes(w)) }).toEqual({ name, missing: [] });
          }
          if (label === "after") {
            expect({ name, banned: BANNED_OWNER_WORDS.filter((w) => text.includes(w)) }).toEqual({ name, banned: [] });
            if (lang === "en") expect({ name, hit: text.match(/\bLP\b|feature/i)?.[0] ?? null }).toEqual({ name, hit: null });
          }
          await g.ctx.close();
        }
      } finally { server.stop(true); }
    }
    await Bun.write(resolve(out, "shot-issues.json"), JSON.stringify(issues, null, 2));
    await Bun.write(resolve(out, "requests.json"), JSON.stringify(requests, null, 2));
    await Bun.write(resolve(out, "inner-text.json"), JSON.stringify(texts, null, 2));
    for (const [name, r] of Object.entries(requests)) expect({ name, ...r }).toEqual({ name, external: [], errors: [] });
    for (const [name, list] of Object.entries(issues).filter(([n]) => n.startsWith("after-"))) expect({ name, list }).toEqual({ name, list: [] });
  } finally { await browser.close(); }
}, 600_000);

import { serve as serveCollab } from './helpers/collab-fixture-serve';
import { generateHomeFixture } from '@/features/collab/shared/home-fixture-gen';
import { generateTeamFixture } from '@/features/collab/shared/team-fixture-gen';
import type { Locator, Page } from 'playwright-core';

const COLLAB_VIEWS = ['outline', 'overview', 'work', 'detail', 'planning'] as const;
/** 步骤线与详情占位已统一词表，完整标签豁免清单保持为空。 */
const PENDING_WORDS: { file: string; text: string; position: string }[] = [];
const remainingBanned = (text: string) => {
  // 只剥掉占完整一行的已登记标签 / 句子，不替换长句里的同一子串。
  for (const { text: word } of PENDING_WORDS) text = text.replaceAll(new RegExp(`^${word}$`, 'gm'), '');
  return BANNED_OWNER_WORDS.filter(w => text.includes(w));
};

/** 合成标题不含 UI 的内部词；三模块分别过期 25 分钟 / 最新 / 尚无进度，详情有两个等回答的问题。 */
function collabFixture() {
  const home = generateHomeFixture();
  // 数据标题去掉生成器讲架构的内部名，保留真实长标题形状；UI 文案必须靠产品代码换词。
  const clean = (s: string) => s.replaceAll('执行镜像', '任务进度').replaceAll('feature', 'module');
  for (const i of home.overview.items) { i.title = clean(i.title); i.oneLine = clean(i.oneLine); }
  for (const f of home.features) { f.title = clean(f.title); for (const v of f.versions) for (const n of v.nodes) n.oneLine = clean(n.oneLine); }
  for (const t of home.overview.tasks) t.title = clean(t.title);
  for (const d of Object.values(home.details)) d.task.title = clean(d.task.title);
  for (const [id, stage] of [['i28-A1', 'spec'], ['i28-A2', 'blocked'], ['i28-B3', 'restate']] as const) {
    const task = home.overview.tasks.find(t => t.id === id)!;
    Object.assign(task, { stage, stageBefore: stage === 'blocked' ? 'build' : null, metrics: {}, stageSince: home.now, updatedAt: home.now });
    home.details[id] = { ...home.details[id]!, task, events: [], timeline: [{ stage, from: home.now, to: home.now }], stepLine: null };
    home.rows[id]!.steps = []; home.rows[id]!.asks = [];
  }
  const parked = home.overview.tasks.at(-1)!;
  Object.assign(parked, { stage: 'parked', itemId: home.features[0]!.id, title: '等待分类的任务' });
  home.details[parked.id]!.task = parked;
  for (const version of home.features[0]!.versions) version.nodes.push({ key: parked.id, oneLine: parked.title, deps: [],
    fileGlobs: ['web/tests/**'], estimate: '1h', taskId: parked.id });
  const fx = generateTeamFixture({ features: 3, nodes: 10, now: home.now });
  for (const [i, d] of fx.details.entries()) {
    d.feature.title = `模块 ${i + 1}：同步不同机器上的任务进度`;
    d.feature.homeInstanceId = i === 2 ? home.sourceInstanceId : `peer-machine-${i + 1}`;
    d.feature.projection = i === 2 ? null : { ...d.feature.projection!, observedAt: home.now - (i === 0 ? 25 * 60_000 : 0) };
    for (const n of d.dag.nodes) n.oneLine = clean(n.oneLine);
    for (const t of d.tasks) {
      t.executorInstanceId = d.feature.homeInstanceId;
      t.specSummary = clean(t.specSummary ?? '');
      if (t.stage === 'review' || t.stage === 'fix') t.asks = [{ kind: 'question', state: 'open', blocking: true }, { kind: 'question', state: 'open', blocking: true }];
    }
  }
  fx.list.features = fx.details.map(d => d.feature);
  return { home, team: { list: fx.list, details: fx.details, localFeature: {} } };
}

async function collabBundle(repo: string, dir: string) {
  mkdirSync(dir, { recursive: true });
  const entry = resolve(dir, 'collab-entry.ts');
  await Bun.write(entry, `import { setLang } from ${JSON.stringify(resolve(repo, 'web/lib/i18n.tsx'))};
import ${JSON.stringify(resolve(repo, 'web/features/collab/shared/fixture-harness.tsx'))};
setLang(new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh');`);
  const p = Bun.spawn([process.execPath, 'build', entry, '--target', 'browser', '--outdir', resolve(dir, 'dist'),
    '--tsconfig-override', 'web/tsconfig.json'], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  if (await p.exited) throw new Error(await new Response(p.stderr).text());
  return resolve(dir, 'dist');
}

async function collabNavigate(page: Page, view: typeof COLLAB_VIEWS[number], lang: 'zh' | 'en', narrow: boolean) {
  const tr = (zh: string, en: string) => lang === 'zh' ? zh : en;
  if (view === 'planning') {
    const name = tr('规划与提案', 'Plans & proposals');
    await (narrow ? page.getByRole('button', { name, exact: true }) : page.getByRole('tab', { name, exact: true })).click();
    await page.getByText(tr('团队规划', 'Team planning'), { exact: true }).waitFor();
  } else if (view === 'work') {
    await page.getByRole('tab', { name: tr('谁在干活', 'Who is working'), exact: true }).click();
    await page.locator('[data-work-board="team"]').waitFor();
    if (narrow) await page.getByRole('tab', { name: /^(待做|To do)/ }).click();
  } else if (view === 'outline') {
    await page.getByRole('button').filter({ has: page.getByText(collabFixture().home.features[0]!.title, { exact: true }) }).first().click();
    if (!narrow) await page.getByRole('tab', { name: /^全部|^All/ }).first().click();
    await page.getByText('等待分类的任务', { exact: true }).first().waitFor();
  } else if (view === 'detail') {
    const title = collabFixture().team.details[0]!.dag.nodes.find(n => n.key === 'i28-A5')!.oneLine;
    if (narrow) await page.getByRole('button').filter({ has: page.getByText('模块 1：同步不同机器上的任务进度', { exact: true }) }).first().click();
    await page.getByText(title, { exact: true }).first().click();
    await page.locator('[data-team-fact]').first().waitFor();
  }
  await page.evaluate('document.fonts.ready');
  await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
}

test.skipIf(!out)('UXTERM2 B 段：同一协作视图的中英、1280 / 390、改前改后与精确残留清单', async () => {
  if (!out) return;
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
  const sides = [...(baseRepo ? [{ phase: 'before' as const, repo: resolve(baseRepo) }] : []), { phase: 'after' as const, repo: resolve(import.meta.dir, '..') }];
  const texts: Record<string, string> = {}, issues: Record<string, ShotIssue[]> = {}, requests: Record<string, unknown> = {};
  try {
    for (const { phase, repo } of sides) {
      const { home, team } = collabFixture();
      expect([...new Set(home.overview.tasks.map(t => t.stage))]).toEqual(expect.arrayContaining([
        'spec', 'restate', 'build', 'review', 'fix', 'merge', 'blocked', 'parked',
      ]));
      const dist = await collabBundle(repo, resolve(out, `collab-${phase}`));
      // helper 的 HTML 自动取唯一 js；Bun 入口名不影响产品 harness。
      const { server } = serveCollab(home, team, dist);
      try {
        for (const width of [1280, 390]) for (const view of COLLAB_VIEWS) for (const lang of ['zh', 'en'] as const) {
          const g = await guardedPage(browser, String(server.url), { width });
          await g.page.route('**/api/v1/shared-ledger/context', r => r.fulfill({ json: { identities: [{ center: 'center-fixture',
            team: home.team, person: 'person-fixture', project: home.project, homeInstanceId: home.sourceInstanceId }] } }));
          await g.page.route('**/api/v1/shared-projects/snapshot', r => r.fulfill({ json: { v: 1, identity: { subject: 'owner:self', kind: 'person',
            centerId: 'center-fixture', teamId: home.team, personId: 'person-fixture', instanceId: home.sourceInstanceId },
            teamRole: { available: true, value: 'member' }, capabilities: { invite: { available: false }, leave: { available: false } }, projects: [], localProjects: [], peers: [
              { name: '研发机', instanceId: 'peer-machine-1', enabled: true, invitable: true },
              { name: '开发', instanceId: 'peer-machine-2', enabled: true, invitable: true }] } }));
          await g.page.clock.install({ time: home.now });
          const side = view === 'outline' ? 'local' : 'team';
          await g.page.goto(`${server.url}?side=${side}&project=${home.project}&team=${home.team}&lang=${lang}&homeInstanceId=${home.sourceInstanceId}`);
          await g.page.getByRole('progressbar').first().waitFor();
          await collabNavigate(g.page, view, lang, width === 390);
          if (phase === 'after' && (view === 'detail' || view === 'planning')) await g.page.getByText(/研发机/).first().waitFor();
          if (view === 'detail') await g.page.locator('[data-team-fact]').last().scrollIntoViewIfNeeded();
          const name = `${phase}-collab-${view}-${width}${lang === 'en' ? '-en' : ''}`;
          const text = await g.page.locator('body').innerText();
          texts[name] = text;
          if (lang === 'zh') {
            await g.page.screenshot({ path: resolve(out, `${name}.png`), fullPage: true });
            issues[name] = await shotIssues(g.page);
          }
          requests[name] = { external: [...g.external], errors: [...g.errors] };
          expect({ name, external: g.external, errors: g.errors }).toEqual({ name, external: [], errors: [] });
          if (phase === 'after') {
            expect({ name, banned: remainingBanned(text) }).toEqual({ name, banned: [] });
            if (view === 'outline' && width === 1280) expect(text).toContain(lang === 'zh' ? '其他' : 'Other');
            expect(text).not.toMatch(/\bparked\b/);
            if (view === 'detail') expect(text).toContain(lang === 'zh' ? '任务所在的机器：研发机' : 'The machine running the task: 研发机');
            if (view === 'planning') expect(text).toContain(lang === 'zh' ? '任务所在的机器 开发' : 'The machine running the task 开发');
            if (view === 'work') expect(text).toContain(lang === 'zh' ? '可以开工' : 'Ready to start');
            if (view === 'planning') for (const word of (lang === 'zh'
              ? ['25 分钟没收到任务所在机器的更新', '进度是最新的', '还没收到任务所在机器的进度']
              : ["No update from the task's machine for 25 min", 'Progress is up to date', "No progress received from the task's machine yet"])) expect(text).toContain(word);
            if (lang === 'en') expect(text).not.toMatch(/\bLP\b|feature/i);
          }
          await g.ctx.close();
        }
      } finally { server.stop(true); }
    }
  } finally {
    await browser.close();
    await Bun.write(resolve(out, 'collab-inner-text.json'), JSON.stringify(texts, null, 2));
    await Bun.write(resolve(out, 'collab-shot-issues.json'), JSON.stringify(issues, null, 2));
    await Bun.write(resolve(out, 'collab-requests.json'), JSON.stringify(requests, null, 2));
    await Bun.write(resolve(out, 'pending-words.json'), JSON.stringify(PENDING_WORDS, null, 2));
  }
  for (const [name, list] of Object.entries(issues).filter(([n]) => n.startsWith('after-'))) expect({ name, list }).toEqual({ name, list: [] });
}, 600_000);

/** UXTERM4：团队源声明的仅在任务所在机器能看的六项（含 replay），和生产团队源 HOME_ONLY 同一组 */
const TEAM_HOME_ONLY = ['events.text', 'review.text', 'sessions', 'say', 'spec.full', 'replay'];

/** 缺正文的团队卡：同一份本机夹具的一张卡，事件全是脱敏的（只有类型和时间），没有阶段证据，回放给占位 */
function redactedCard() {
  const { home } = collabFixture();
  const task = home.overview.tasks.find(t => t.stage === 'review' && t.agent)!;
  const red = (kind: string, i: number) => ({ seq: 900 + i, ts: home.now - (5 - i) * 60_000, actor: 'agent-bait', target: task.id, kind, text: '', data: { redacted: true } });
  const detail = { ...home.details[task.id]!, events: ['stage', 'deliver', 'review', 'verify'].map(red), timeline: [] };
  return { home, project: home.project, id: task.id, overview: home.overview, detail };
}

/** 入口在截图目录：CollabView 外面包一个注入源（homeOnly 六项、task 给脱敏详情），改前 / 改后同一份入口，只换仓库 */
async function redactedBundle(repo: string, dir: string, card: ReturnType<typeof redactedCard>) {
  mkdirSync(dir, { recursive: true });
  const entry = resolve(dir, 'redacted-entry.ts'), from = (f: string) => JSON.stringify(resolve(repo, f));
  await Bun.write(entry, `import { createElement as h } from ${from('web/node_modules/react/index.js')};
import { createRoot } from ${from('web/node_modules/react-dom/client.js')};
import { setLang } from ${from('web/lib/i18n.tsx')};
import { ChatStoreProvider } from ${from('web/features/chat/chat-store.ts')};
import { CollabView } from ${from('web/features/collab/collab-view.tsx')};
import { CollabSourceContext } from ${from('web/features/collab/team-source-context.ts')};
import { openCollab, openCollabTask } from ${from('web/features/collab/collab-nav.ts')};
setLang(new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh');
const card = ${JSON.stringify({ project: card.project, id: card.id, overview: card.overview, detail: card.detail })};
const source = { homeOnly: new Set(${JSON.stringify(TEAM_HOME_ONLY)}), overview: async () => card.overview, task: async () => card.detail,
  follow: ({ signal }) => new Promise((r) => signal.addEventListener('abort', () => r())) };
openCollab(card.project);
openCollabTask(card.id);
createRoot(document.getElementById('root')).render(h(ChatStoreProvider, null, h(CollabSourceContext.Provider, { value: source }, h(CollabView, { project: card.project }))));
`);
  const p = Bun.spawn([process.execPath, 'build', entry, '--target', 'browser', '--outdir', resolve(dir, 'dist'),
    '--tsconfig-override', 'web/tsconfig.json'], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  if (await p.exited) throw new Error(await new Response(p.stderr).text());
  return resolve(dir, 'dist');
}

/** 每页必须出现的句子：改前是「仅主场」旧句，改后是任务所在机器的新句 */
const REDACTED_WANT = {
  before: { zh: ['回放仅主场', '审查（结论仅主场）'], en: ['Replay at home only', 'Review (verdict at home only)'] },
  after: { zh: ['回放要在任务所在的机器上看', '审查（结论在任务所在的机器上）', '线上验证（结果在任务所在的机器上）', '交付（详情在任务所在的机器上）'],
    en: ['Replay on the machine running this task', 'Review (verdict on the machine running this task)', 'Delivered (details on the machine running this task)'] },
};

test.skipIf(!out)('UXTERM4：缺正文团队卡详情的回放占位与脱敏事件句，1280 / 390 改前改后，改后不含禁用词', async () => {
  if (!out) return;
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
  const sides = [...(baseRepo ? [{ phase: 'before' as const, repo: resolve(baseRepo) }] : []), { phase: 'after' as const, repo: resolve(import.meta.dir, '..') }];
  const texts: Record<string, string> = {}, issues: Record<string, ShotIssue[]> = {};
  const card = redactedCard();
  try {
    for (const { phase, repo } of sides) {
      const { server } = serveCollab(card.home, collabFixture().team, await redactedBundle(repo, resolve(out, `redacted-${phase}`), card));
      try {
        for (const width of [1280, 390]) for (const lang of ['zh', 'en'] as const) {
          const g = await guardedPage(browser, String(server.url), { width });
          await g.page.clock.install({ time: card.home.now });
          await g.page.goto(`${server.url}?lang=${lang}`);
          await g.page.locator('[data-home-only="replay"]').waitFor();
          // 截图要拍到「最近 3 件事」和回放占位：回放占位滚到视口中间（手机底部有「对它说」条会挡住贴底的占位），上面的事件区跟着露出来
          await g.page.evaluate(`document.querySelector('[data-home-only="replay"]').scrollIntoView({ block: 'center' })`);
          await g.page.evaluate('document.fonts.ready');
          await g.page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
          const name = `${phase}-redacted-detail-${width}${lang === 'en' ? '-en' : ''}`, text = await g.page.locator('body').innerText();
          texts[name] = text;
          if (lang === 'zh') {
            await g.page.screenshot({ path: resolve(out, `${name}.png`) });
            issues[name] = await shotIssues(g.page);
          }
          expect({ name, external: g.external, errors: g.errors }).toEqual({ name, external: [], errors: [] });
          expect({ name, missing: REDACTED_WANT[phase][lang].filter(w => !text.includes(w)) }).toEqual({ name, missing: [] });
          if (phase === 'after') {
            expect({ name, banned: remainingBanned(text) }).toEqual({ name, banned: [] });
            expect({ name, hit: text.match(/at home only|\bhome\b/i)?.[0] ?? null }).toEqual({ name, hit: null });
          }
          await g.ctx.close();
        }
      } finally { server.stop(true); }
    }
  } finally {
    await browser.close();
    await Bun.write(resolve(out, 'redacted-inner-text.json'), JSON.stringify(texts, null, 2));
    await Bun.write(resolve(out, 'redacted-shot-issues.json'), JSON.stringify(issues, null, 2));
  }
  expect(PENDING_WORDS).toEqual([]);
  for (const [name, list] of Object.entries(issues).filter(([n]) => n.startsWith('after-'))) expect({ name, list }).toEqual({ name, list: [] });
}, 600_000);

import { execFixtureView } from '@/features/collab/shared/exec/exec-fixture';

/** UXTERM5：团队卡的团队操作区（执行面板 / 开卡表单 / 审批面板 / 提案页），生产 CollabView + TeamSource + 合成执行接线 */
const OPS_VIEWS = ['exec', 'task', 'approve', 'proposal'] as const;
type OpsView = (typeof OPS_VIEWS)[number];
/** 改后每页必须出现的新句（中文 / 英文）；改前只拍不断言新句 */
const OPS_WANT: Record<OpsView, { zh: string[]; en: string[] }> = {
  exec: { zh: ['任务所在的机器 · 本机'], en: ['The machine running the task · 本机'] },
  task: { zh: ['任务所在的机器 · 本机'], en: ['The machine running the task · 本机'] },
  approve: { zh: ['任务所在的机器 · 本机', '原文只在任务所在的机器上能看'],
    en: ['The machine running the task · 本机', 'Original text is only visible on the machine running this task'] },
  proposal: { zh: ['项目和任务所在的机器由本机绑定决定，不可改'], en: ["Project and the machine running this task come from this machine's binding; not editable"] },
};

function opsFixture() {
  const fx = generateTeamFixture({ features: 1, now: NOW });
  const clean = (s: string) => s.replaceAll('执行镜像', '任务进度').replaceAll('feature', 'module');
  const f = fx.details[0]!;
  f.feature.title = '模块 1：同步不同机器上的任务进度';
  f.feature.authorityMode = 'execution' as typeof f.feature.authorityMode; // 执行面板只在执行权模式下出现（同 stage2 截图夹具）
  for (const n of f.dag.nodes) n.oneLine = clean(n.oneLine);
  for (const t of f.tasks) t.specSummary = clean(t.specSummary ?? '');
  // 开卡表单原样显示所属模块的 id：夹具给一个可读 id，不让截图检查把 uuid 当标题
  const detail = JSON.parse(JSON.stringify(f).replaceAll(f.feature.id, 'module-sync')) as typeof f;
  fx.list.features = [detail.feature];
  // 详情要打开的卡：挑一张进行中的（默认筛选只列进行中），执行视图与待审批都挂在它上面，按它绑定的规划节点标题去点
  const open = detail.tasks.find(t => t.stage !== 'done' && t.stage !== 'verified')!;
  const card = detail.dag.nodes.find(n => n.key === open.sourceTaskId)!.oneLine;
  const view = execFixtureView(detail.feature.id, open.taskId);
  view.pendingAsks = view.pendingAsks.map(a => ({ ...a, expiresAt: NOW + 600_000, bind: { ...a.bind!, expiresAt: NOW + 600_000 } }));
  return { list: fx.list, detail, view, card };
}

async function opsBundle(repo: string, dir: string) {
  mkdirSync(dir, { recursive: true });
  const entry = resolve(dir, 'ops-entry.ts');
  await Bun.write(entry, `import { setLang } from ${JSON.stringify(resolve(repo, 'web/lib/i18n.tsx'))};
setLang(new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh');
await import(${JSON.stringify(resolve(repo, 'web/features/collab/shared/exec/fixture-harness.tsx'))});`);
  const p = Bun.spawn([process.execPath, 'build', entry, '--target', 'browser', '--outdir', resolve(dir, 'dist'),
    '--tsconfig-override', 'web/tsconfig.json'], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  if (await p.exited) throw new Error(await new Response(p.stderr).text());
  return resolve(dir, 'dist');
}

function opsServe(dist: string, fx: ReturnType<typeof opsFixture>) {
  const files = readdirSync(dist);
  return Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/app-config.json') return Response.json({ mode: 'direct', fp: 'local', machineName: 'fixture', version: '' });
    if (path === '/api/v1/shared-ledger/features') return Response.json(fx.list);
    if (path.startsWith('/api/v1/shared-ledger/features/')) return Response.json(fx.detail);
    if (path === '/api/v1/shared-projects/snapshot') return Response.json({ v: 1,
      identity: { subject: 'owner:self', kind: 'person', centerId: 'center', teamId: 'team-a', personId: 'person-a', instanceId: 'local' },
      teamRole: { available: true, value: 'owner' }, capabilities: { invite: { available: false }, leave: { available: false } }, peers: [],
      localProjects: [{ id: 'fixture-local', name: '合成项目', dirs: [], personal: false, eligible: false }],
      projects: [{ centerId: 'center', teamId: 'team-a', projectId: 'claude-orchestrator', name: '合成项目', rev: 1,
        status: 'active', projectRole: { available: true, value: 'owner' }, localProjectIds: ['fixture-local'] }] });
    if (path === '/api/v1/shared-feature-proposals') return Response.json({ ok: true, operations: [] });
    if (path.startsWith('/api/v1/shared-feature-proposals/projects/')) return Response.json({ ok: true, proposals: [] });
    if (path.startsWith('/api/v1/shared-exec/features/')) return Response.json(fx.view);
    if (path.startsWith('/api/v1/shared-exec/asks/')) return Response.json(fx.view.pendingAsks[0]);
    if (path.startsWith('/api/')) return Response.json({ ok: false, error: 'outside synthetic fixture' }, { status: 404 });
    if (path !== '/') return files.includes(path.slice(1)) ? new Response(Bun.file(resolve(dist, path.slice(1)))) : new Response(null, { status: 404 });
    return new Response(`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      ${files.filter(f => f.endsWith('.css')).map(f => `<link rel="stylesheet" href="/${f}">`).join('')}
      <style>*{box-sizing:border-box}body{margin:0;font:14px system-ui}button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}h2,h5{margin:0}</style></head>
      <body><div id="root"></div><script type="module" src="/${files.find(f => f.endsWith('.js'))}"></script></body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } });
  } });
}

/**
 * exec / task / approve：打开一张团队卡详情（生产 source.ops(openTask) → TaskOps + 按卡过滤的 ExecEntry），在详情里展开；
 * proposal：团队规划页（source.ops(null) → FeatureOps 的新建模块表单）。返回前断言确实在对应入口里
 */
async function opsNavigate(page: Page, view: OpsView, lang: 'zh' | 'en', narrow: boolean, title: string, card: string) {
  const tr = (zh: string, en: string) => lang === 'zh' ? zh : en;
  await page.getByText(title, { exact: true }).first().waitFor();
  let exec: Locator;
  if (view === 'proposal') {
    // 「团队」（桌面是中区标签，手机是顶栏按钮）→ 子标签「规划与提案」
    await page.getByRole(narrow ? 'button' : 'tab', { name: tr('团队', 'Team'), exact: true }).click();
    await page.getByRole('tab', { name: tr('规划与提案', 'Planning and proposals'), exact: true }).click();
    exec = page.getByRole('region', { name: tr('共享执行', 'Shared execution'), exact: true });
  } else {
    // 手机先点模块进任务列表，再点卡；桌面直接点画布 / 大纲里的卡
    if (narrow) await page.getByRole('button').filter({ has: page.getByText(title, { exact: true }) }).first().click();
    await page.getByText(card, { exact: true }).first().click();
    // 详情入口才有「团队操作」（TaskOps）；规划页入口只有「团队规划」，进错入口这里就失败
    const ops = page.getByText('团队操作', { exact: true });
    await ops.first().waitFor();
    expect(await page.getByText(tr('团队规划', 'Team planning'), { exact: true }).count()).toBe(0);
    // 详情里的共享执行面板按卡过滤：只列这一张卡
    exec = page.getByRole('region', { name: tr('共享执行', 'Shared execution'), exact: true });
  }
  await exec.waitFor();
  let target = exec;
  if (view === 'task') {
    await exec.getByRole('button', { name: tr('开卡', 'Create task'), exact: true }).last().click();
    target = page.getByText(tr('新建 spec 卡', 'New spec task'), { exact: true }).locator('xpath=ancestor::*[self::section or self::form][1]');
  } else if (view === 'approve') {
    await exec.getByRole('button', { name: tr('审批', 'Approval'), exact: true }).last().click();
    target = page.getByRole('button', { name: tr('批准', 'Approve'), exact: true }).locator('xpath=ancestor::section[1]');
  } else if (view === 'proposal') {
    await page.getByRole('button', { name: tr('新建模块', 'New module'), exact: true }).first().click();
    target = page.locator('form').filter({ hasText: tr('项目', 'Project') }).first();
  }
  await target.first().waitFor();
  await target.first().evaluate('el => el.scrollIntoView({ block: "center" })');
  await page.evaluate('document.fonts.ready');
  await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
}

test.skipIf(!out)('UXTERM5：团队操作区（执行面板 / 开卡 / 审批 / 提案页）1280 / 390 改前改后，改后不含禁用词与 home', async () => {
  if (!out) return;
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
  const sides = [...(baseRepo ? [{ phase: 'before' as const, repo: resolve(baseRepo) }] : []), { phase: 'after' as const, repo: resolve(import.meta.dir, '..') }];
  const texts: Record<string, string> = {}, issues: Record<string, ShotIssue[]> = {};
  const fx = opsFixture();
  try {
    for (const { phase, repo } of sides) {
      const server = opsServe(await opsBundle(repo, resolve(out, `ops-${phase}`)), fx);
      try {
        for (const width of [1280, 390]) for (const view of OPS_VIEWS) for (const lang of ['zh', 'en'] as const) {
          const g = await guardedPage(browser, String(server.url), { width });
          await g.page.clock.install({ time: NOW });
          await g.page.goto(`${server.url}?mode=on&lang=${lang}`);
          await opsNavigate(g.page, view, lang, width === 390, fx.detail.feature.title, fx.card);
          const name = `${phase}-ops-${view}-${width}${lang === 'en' ? '-en' : ''}`, text = await g.page.locator('body').innerText();
          texts[name] = text;
          if (lang === 'zh') {
            await g.page.screenshot({ path: resolve(out, `${name}.png`) });
            issues[name] = await shotIssues(g.page);
          }
          expect({ name, external: g.external, errors: g.errors }).toEqual({ name, external: [], errors: [] });
          if (phase === 'after') {
            expect({ name, missing: OPS_WANT[view][lang].filter(w => !text.includes(w)) }).toEqual({ name, missing: [] });
            expect({ name, banned: remainingBanned(text) }).toEqual({ name, banned: [] });
            expect({ name, hit: text.match(/\bhome\b/i)?.[0] ?? null }).toEqual({ name, hit: null });
          }
          await g.ctx.close();
        }
      } finally { server.stop(true); }
    }
  } finally {
    await browser.close();
    await Bun.write(resolve(out, 'ops-inner-text.json'), JSON.stringify(texts, null, 2));
    await Bun.write(resolve(out, 'ops-shot-issues.json'), JSON.stringify(issues, null, 2));
  }
  expect(PENDING_WORDS).toEqual([]);
  for (const [name, list] of Object.entries(issues).filter(([n]) => n.startsWith('after-'))) expect({ name, list }).toEqual({ name, list: [] });
}, 600_000);
