/**
 * team-parity-TEAMCNT1 截图（opt-in）：COUNT_SHOTS_DIR=<目录> bun test tests/web-collab-count-browser.test.ts
 * 团队版协作视图（fixture-harness ?side=team），1280 / 390 × 900 浅色中文，同一份合成夹具（3 个 feature）：
 * - 429：首轮第 3 个 feature 的详情回 429（Retry-After 30 秒），首轮刚结束那一刻。改前全骨架（等下一轮 15 秒），改后已出数并带「另有 1 个」提示。
 * - loading：首轮详情全到，主场本机 /work 看板迟迟不回（计数还在 loading）。改前指标栏、筛选全骨架，改后只有三个状态格和「进行中」骨架。
 * COUNT_BASELINE_WEB=<改前的 web 目录> 换成改前的构建、文件名前缀 before-（改前对照图）。纯 fixture，不连生产。
 */
import { expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateTeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.COUNT_SHOTS_DIR;
const webRoot = process.env.COUNT_BASELINE_WEB ?? "web";
const phase = process.env.COUNT_BASELINE_WEB ? "before" : "after";
type State = "429" | "loading";

function serve(bundle: string, state: State) {
  const fx = generateTeamFixture();
  const files = readdirSync(bundle);
  const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(v, { status, headers });
  const late = fx.list.features[2]!.id;
  const seen = { limited: 0, work: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    const at = Date.now();
    const details = fx.details.map((d) => ({ ...d, feature: { ...d.feature, projection: d.feature.projection && { ...d.feature.projection, observedAt: at, receivedAt: at } } }));
    if (path === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (path === "/api/v1/lend/quota-lines") return json({ families: [{ family: "claude", warnPct: 80, stopPct: 95, weekUsedPct: 42, resetAt: null }] });
    if (path === `/api/v1/ledger/${fx.project}/work`) { seen.work = at; return new Promise<Response>(() => {}); } // 主场本机看板不回：计数停在 loading
    if (path === `/api/v1/ledger/${fx.project}`) return json({ ok: true, ...fx.local, now: at });
    if (path === "/api/v1/shared-ledger/features") return json({ ...fx.list, features: details.map((d) => d.feature) });
    const feature = path.match(/^\/api\/v1\/shared-ledger\/features\/(.+)$/);
    if (feature) {
      const id = decodeURIComponent(feature[1]!);
      if (state === "429" && id === late) { seen.limited = at; return json({ ok: false, error: "rate limited", retryAfter: 30 }, 429, { "retry-after": "30" }); }
      return json(details.find((d) => d.feature.id === id));
    }
    if (path.startsWith("/api/")) return json({ ok: false, error: "not in fixture" }, 404);
    if (path !== "/") return files.includes(path.slice(1)) ? new Response(Bun.file(resolve(bundle, path.slice(1)))) : new Response(null, { status: 404 });
    return new Response(`<!doctype html><html data-theme="light" lang="zh"><head><meta charset="utf-8">
      ${files.filter((f) => f.endsWith(".css")).map((f) => `<link rel="stylesheet" href="/${f}">`).join("")}
      <style>*{box-sizing:border-box}body{margin:0;font:14px system-ui}button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
      h5{margin:0}#root{height:100vh;position:relative}</style></head>
      <body><div id="root"></div><script type="module" src="/${files.find((f) => f.endsWith(".js"))}"></script></body></html>`,
    { headers: { "content-type": "text/html" } });
  } });
  return { server, fx, seen };
}

/** 字符串求值：根 tsconfig 不带 dom 类型 */
const probe = (page: Page) => page.evaluate(`(() => {
  const cell = (k) => document.querySelector('[data-metric=' + k + ']');
  const skel = (el) => !!el && !!el.querySelector('[aria-hidden]:empty');
  return {
    status: ['working', 'waiting', 'notStarted'].map((k) => cell(k) ? (skel(cell(k)) ? 'skel' : cell(k).querySelector('b').textContent) : null),
    quota: cell('quota') ? (skel(cell('quota')) ? 'skel' : cell('quota').querySelector('b').textContent) : null,
    hint: document.querySelector('[data-metrics] [role=img]')?.getAttribute('title') ?? null,
    chips: Array.from(document.querySelectorAll('[role=tablist] [role=tab]')).slice(0, 4).map((c) => skel(c) ? 'skel' : c.textContent),
  };
})()`) as Promise<{ status: (string | null)[]; quota: string | null; hint: string | null; chips: string[] }>;

test.skipIf(!out)("TEAMCNT1 团队版首屏计数：首轮 1 个 feature 429 / 本机看板未回，1280 / 390", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const bundle = resolve(out, `${phase}-bundle`);
  const build = Bun.spawn([process.execPath, "build", `${webRoot}/features/collab/shared/fixture-harness.tsx`, "--target", "browser",
    "--outdir", bundle, "--tsconfig-override", `${webRoot}/tsconfig.json`], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const browser: Browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, seenAt: Record<string, Awaited<ReturnType<typeof probe>>> = {}, shots: { view: string; size: string; phase: string; file: string }[] = [];
  try {
    for (const state of ["429", "loading"] as const) for (const width of [1280, 390]) {
      const { server, fx, seen } = serve(bundle, state);
      const page = await browser.newPage({ viewport: { width, height: 900 }, locale: "zh-CN" });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      // loading：主场本机实例 = 第一个 feature 的主场，团队看板要等本机 /work（不回）
      const home = state === "loading" ? `&homeInstanceId=${fx.details[0]!.feature.homeInstanceId}` : "";
      await page.goto(`${server.url}?side=team&theme=light&lang=zh&project=${fx.project}&team=${fx.team}${home}`);
      const deadline = Date.now() + 10_000;
      while (!(state === "429" ? seen.limited : seen.work) && Date.now() < deadline) await Bun.sleep(100);
      expect({ state, width, triggered: !!(state === "429" ? seen.limited : seen.work) }).toEqual({ state, width, triggered: true });
      await Bun.sleep(1500); // 首轮刚结束：远短于 15 秒轮询与 20 秒兜底
      await page.evaluate("document.fonts.ready");
      await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
      const size = `${width}x900`, file = `${phase}-${state}-${size}.png`;
      await page.screenshot({ path: resolve(out, file) });
      shots.push({ view: `team-${state}`, size, phase, file });
      issues[file] = await shotIssues(page);
      seenAt[file] = await probe(page);
      expect(errors).toEqual([]);
      await page.close();
      server.stop(true);
    }
  } finally { await browser.close(); }
  writeFileSync(resolve(out, `${phase}-probe.json`), JSON.stringify({ card: "team-parity-TEAMCNT1", web: webRoot, shots, issues, seenAt }, null, 2) + "\n");
  for (const [name, list] of Object.entries(issues)) expect({ name, list }).toEqual({ name, list: [] });
  if (phase === "after") {
    // 1280 有顶栏与左栏：429 那一刻已出数并带提示；loading 时只有三个状态格与「进行中」骨架，周额度与其余芯片有数
    const a = seenAt["after-429-1280x900.png"]!, l = seenAt["after-loading-1280x900.png"]!;
    expect(a.status.every((v) => v !== null && /^\d+$/.test(v))).toBe(true);
    expect(a.hint).toBe("另有 1 个 feature 还没读到，数字不含它们");
    expect(l.status).toEqual(["skel", "skel", "skel"]);
    expect(l.quota).toBe("Claude 42%");
    expect(l.chips[0]).toBe("skel");
    expect(l.chips.slice(1).every((c) => /\d/.test(c.replace("P0", "")))).toBe(true);
  }
}, 180_000);
