/**
 * followup-reliability-UXCARD3 截图（opt-in）：UXCARD3_SHOTS_DIR=<目录> bun test tests/web-collab-detail-work-browser.test.ts
 * 团队视图、主场本机（fixture-harness 的 homeInstanceId 参数），三张卡：出借写卡（i28-A6，本机占位会话 dev-3 在 /agents 里在线）、
 * 退回人工（i28-A5，返工第 5 轮）、老卡（i28-A4，审查、没有调度记录）。/work 用 serve 的覆盖参数给出三种行；另拍团队板 / 本机板的「老卡」折叠。
 * 每个宽度（1280 / 390）把五段原图按顺序拼成一张纵向对照，段上标状态名；浅色，原图逐张过 shotIssues、只回环。
 * UXCARD3_BASELINE_WEB=<基线的 web 目录> 换成改前的构建，文件名前缀 before-（只拍、不断言新行为）。时钟钉在夹具的 now 上。纯 fixture，不连生产。
 */
import { expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateHomeFixture, homeWorkBoard, type HomeFixture } from "@/features/collab/shared/home-fixture-gen";
import type { WorkBoard, WorkRow } from "@/features/collab/work/work-types";
import { teamFromHome } from "./web-team-parity-browser-center.test";
import { guardedPage, serve } from "./helpers/collab-fixture-serve";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.UXCARD3_SHOTS_DIR;
const baseWeb = process.env.UXCARD3_BASELINE_WEB;
const phase = baseWeb ? "before" : "after";
const MIN = 60_000;
const LEND = "i28-A6", MANUAL = "i28-A5", OLD = "i28-A4";

/** /work 覆盖：出借写卡在干活（peer:alice · codex）、退回人工在等（manual）、老卡进 legacy；其余卡照 homeWorkBoard */
function work(home: HomeFixture): WorkBoard {
  const base = homeWorkBoard(home), drop = (rows: WorkRow[]) => rows.filter((r) => ![LEND, MANUAL, OLD].includes(r.taskId ?? ""));
  const at = (id: string) => [...base.working, ...base.waiting].find((r) => r.taskId === id)!;
  return { ...base,
    working: [...drop(base.working), { ...at(LEND), who: "peer:alice · codex", machine: "alice", since: home.now - 15 * MIN }],
    waiting: [...drop(base.waiting), { ...at(MANUAL), step: "fix", round: 5, code: "manual", reason: "退回人工（manual）：缺凭据", since: home.now - 50 * MIN }],
    legacy: [{ taskId: OLD, title: home.details[OLD]!.task.title, stage: "review" }], legacyTotal: 1 };
}

function focus(home: HomeFixture): HomeFixture {
  Object.assign(home.details[MANUAL]!.task, { round: 5, stageSince: home.now - 50 * MIN });
  // 老卡停在审查 336 小时（T13f 那种）：没有调度记录
  Object.assign(home.details[OLD]!.task, { stageSince: home.now - 336 * 60 * MIN });
  return home;
}

async function routes(page: Page, home: HomeFixture) {
  const identity = { center: "center", team: home.team, person: "person-a", project: home.project, machine: "local", homeInstanceId: home.sourceInstanceId };
  await page.route(/\/api\/v1\/shared-ledger\/context(\?.*)?$/, (r) => r.fulfill({ json: { identities: [{ ...identity, localProjectId: home.project }] } }));
}

async function ready(page: Page) {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
}

async function openCard(page: Page, home: HomeFixture, id: string, narrow: boolean) {
  const task = home.details[id]!.task;
  if (narrow) {
    const f = home.features.find((x) => x.id === task.itemId)!;
    await page.getByRole("button").filter({ has: page.getByText(f.title, { exact: true }) }).first().click();
  }
  const title = page.getByText(task.title, { exact: true }).first();
  // 老卡不算进行中（计数不含它）：大纲默认「进行中」里没有它，切到「全部」再点
  const shown = await title.waitFor({ timeout: 4_000 }).then(() => true, () => false);
  if (!narrow && !shown) await page.getByText(/^全部\s*\d+$/).first().click();
  await title.click();
  await page.locator('aside [data-now="who"]').first().waitFor();
  await page.waitForFunction(`![...document.querySelectorAll("aside")].some((a) => a.innerText.includes("正在读取"))`);
  // 快照（本机 /work、合并后的团队板）和本机详情各是一路请求：等句子定下来再拍
  await page.waitForTimeout(1500);
  await ready(page);
}

async function openBoard(page: Page) {
  await page.getByRole("tab", { name: "谁在干活", exact: true }).first().click();
  const board = page.locator("[data-work-board]").first();
  await board.waitFor();
  await page.waitForTimeout(1200);
  const fold = board.locator("details");
  if (await fold.count()) {
    await fold.first().locator("summary").click();
    await fold.first().scrollIntoViewIfNeeded();
  }
  await ready(page);
}

const SEGMENTS: { name: string; label: string; side: "team" | "local"; id: string | null }[] = [
  { name: "lend", label: "出借写卡（团队视图 · 主场本机）", side: "team", id: LEND },
  { name: "manual", label: "退回人工（团队视图 · 主场本机）", side: "team", id: MANUAL },
  { name: "legacy", label: "老卡（团队视图 · 主场本机）", side: "team", id: OLD },
  { name: "team-board", label: "团队板 · 谁在干活（老卡折叠）", side: "team", id: null },
  { name: "local-board", label: "本机板 · 谁在干活（老卡折叠）", side: "local", id: null },
];

interface SharpResult { composite(layers: { input: Buffer; top: number; left: number }[]): SharpResult; png(): SharpResult; toBuffer(): Promise<Buffer> }
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** 改后才断言：句子、叫停、对它说、团队板老卡 */
async function expectAfter(page: Page, seg: typeof SEGMENTS[number], text: string) {
  if (seg.name === "lend") {
    expect(text).toContain("alice 上的 codex 在写");
    expect(text).toContain("执行者在伙伴机器上，从这里发不到");
    expect(await page.locator("aside [data-stop-round]").count()).toBe(0);
  }
  if (seg.name === "manual") {
    expect(text).toContain("退回人工（manual）：缺凭据");
    expect(text).not.toMatch(/在改第 \d+ 轮/);
    expect(await page.locator("aside [data-stop-round]").count()).toBe(0);
  }
  if (seg.name === "legacy") {
    expect(text).toContain("老卡（没有调度记录）· 停在审查，调度器不派活");
    expect(text).not.toMatch(/已等|超过 30 分钟/);
    expect(await page.locator("aside [data-stop-round]").count()).toBe(0);
  }
  if (seg.name.endsWith("board")) {
    expect(text).toContain("老卡 · 1");
    const working = page.locator("[data-work-board] section").filter({ has: page.locator("h3", { hasText: /^在干活/ }) }).first();
    expect(await working.innerText()).not.toContain(OLD);
  }
}

test.skipIf(!out)("UXCARD3 team-home detail: lend / manual / legacy + team & local legacy fold at 1280 / 390", async () => {
  if (!out) return;
  const sharp = createRequire(new URL("../web/package.json", import.meta.url))("sharp") as
    (input: { create: { width: number; height: number; channels: number; background: string } }) => SharpResult;
  mkdirSync(out, { recursive: true });
  const bundle = resolve(out, `${phase}-bundle`), root = baseWeb ?? "web";
  const build = Bun.spawn([process.execPath, "build", `${root}/features/collab/shared/fixture-harness.tsx`, "--target", "browser",
    "--outdir", bundle, "--tsconfig-override", `${root}/tsconfig.json`], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const base = generateHomeFixture(), team = await teamFromHome(base), home = focus(generateHomeFixture());
  const { server } = serve(home, team, bundle, false, work(home));
  const browser: Browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, external: string[] = [], errors: string[] = [], texts: Record<string, string> = {};
  const shots: { view: string; size: string; phase: string; file: string; sha256: string }[] = [];
  try {
    for (const width of [1280, 390]) {
      const height = width < 640 ? 1400 : 2000, images: Buffer[] = [];
      for (const seg of SEGMENTS) {
        const g = await guardedPage(browser, server.url.href, { width });
        await g.page.setViewportSize({ width, height });
        await g.page.clock.setFixedTime(home.now);
        await routes(g.page, home);
        await g.page.goto(`${server.url}?side=${seg.side}&loadAgents=1&theme=light&project=${home.project}&team=${home.team}&homeInstanceId=${home.sourceInstanceId}`);
        await g.page.getByRole("progressbar", { name: home.features[0]!.title, exact: true }).first().waitFor({ timeout: 15_000 });
        if (seg.id) await openCard(g.page, home, seg.id, width < 640);
        else await openBoard(g.page);
        const ref = `${phase}-${seg.name}-${width}-raw.png`;
        const png = await g.page.screenshot({ path: resolve(out, ref) });
        images.push(png);
        issues[ref] = await shotIssues(g.page);
        texts[ref] = seg.id ? await g.page.locator("aside").filter({ hasText: seg.id }).first().innerText() : await g.page.locator("[data-work-board]").first().innerText();
        if (!baseWeb) await expectAfter(g.page, seg, texts[ref]!);
        external.push(...g.external);
        errors.push(...g.errors);
        await g.ctx.close();
      }
      const band = 56, rowHeight = height + band;
      const layers = images.flatMap((input, i) => [{ input: Buffer.from(`<svg width="${width}" height="${band}"><rect width="100%" height="100%" fill="#f1f5f9"/>` +
        `<text x="16" y="35" font-size="20" font-family="sans-serif" fill="#0f172a">${SEGMENTS[i]!.label}</text></svg>`), top: i * rowHeight, left: 0 },
        { input, top: i * rowHeight + band, left: 0 }]);
      const png = await sharp({ create: { width, height: rowHeight * images.length, channels: 3, background: "#ffffff" } }).composite(layers).png().toBuffer();
      const file = `${phase}-team-home-detail-${width}.png`;
      writeFileSync(resolve(out, file), png);
      shots.push({ view: "team-home-detail", size: `${width}x${rowHeight * images.length}`, phase, file, sha256: sha(png) });
    }
  } finally {
    await browser.close();
    server.stop(true);
  }
  writeFileSync(resolve(out, `${phase}-shots.json`), JSON.stringify({ shots, issues, external, errors, texts }, null, 2));
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
  expect(Object.values(issues).flat()).toEqual([]);
}, 300_000);
