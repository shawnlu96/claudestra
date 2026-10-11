/** NODE_CARD_SHOTS_DIR opts into fixture screenshots; NODE_CARD_BASELINE=1 records the unchanged two-click UI. */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { generateHomeFixture, homeDagBoard, type HomeFixture } from "@/features/collab/shared/home-fixture-gen";
import { teamFromHome } from "./web-team-parity-browser-center.test";
import { bundleHarness, guardedPage, serve } from "./helpers/collab-fixture-serve";
import { shotIssues } from "./helpers/ui-shot-checks";

const out = process.env.NODE_CARD_SHOTS_DIR;
const baseline = process.env.NODE_CARD_BASELINE === "1";
const panel = (page: Page) => page.locator("aside").filter({ has: page.getByRole("button", { name: "关闭", exact: true }) });
async function loaded(page: Page) {
  await panel(page).getByText("阶段与用时", { exact: true }).waitFor();
  await page.evaluate("document.fonts.ready");
}
async function back(page: Page) {
  await page.evaluate("history.back()");
  await page.waitForFunction("location.hash === '#chat'");
  await page.waitForFunction("![...document.querySelectorAll('aside h5')].some(h => h.textContent === '阶段与用时')");
}

/** Baseline and changed bundles must give identical text for missing, ghost and unbound legacy-card pages. */
async function unchangedPages(page: Page, home: HomeFixture, dir: string) {
  const title = home.features[0]!.title, board = homeDagBoard(home);
  const openFeature = async () => {
    await page.reload();
    await page.getByRole("button").filter({ has: page.getByText(title, { exact: true }) }).first().click();
  };
  const current = board.features[0]!;
  const node = current.nodes.find(n => n.key === "i28-A5")!;
  Object.assign(node, { missing: true, status: null, phase: "idle", since: null, handler: null, stepLine: null });
  board.agents = [];
  await page.route(`**/api/v1/ledger/${home.project}/dag`, route => route.fulfill({ json: board }));
  await openFeature();
  await page.locator("button[title]").filter({ hasText: "i28-A5" }).click();
  await panel(page).getByText("找不到这张卡", { exact: true }).waitFor();
  const texts: Record<string, string> = { missing: await panel(page).innerText() };
  expect(texts.missing).not.toMatch(/文件范围|为什么还没开卡/);
  if (!baseline) {
    current.nodes = homeDagBoard(home).features[0]!.nodes;
    const predecessor = current.nodes.find(n => n.key === "i28-A4")!;
    Object.assign(predecessor, { taskId: null, status: "planned", phase: "idle", since: null, stepLine: null });
    await openFeature();
    await page.locator("button[title]").filter({ hasText: "i28-A5" }).click();
    await loaded(page);
    await panel(page).getByRole("button", { name: /^i28-A4 / }).first().click();
    await panel(page).getByText("为什么还没开卡", { exact: true }).waitFor();
    expect(await panel(page).innerText()).toContain("i28-A4 ·");
    expect(await panel(page).getByText("卡", { exact: true }).count()).toBe(0);
  }
  current.nodes = homeDagBoard(home).features[0]!.nodes.filter(n => n.key !== "i28-A5");
  await openFeature();
  await page.getByRole("navigation", { name: "大纲" }).getByText(home.details["i28-A5"]!.task.title, { exact: true }).click();
  await loaded(page);
  expect(await panel(page).getByText("所在节点", { exact: true }).count()).toBe(0);
  texts.legacy = await panel(page).innerText();
  await page.route(`**/api/v1/ledger/${home.project}/dag/${current.id}?version=1`, async route => {
    const response = await route.fetch(), value = await response.json();
    value.snapshot.nodes.push({ ...node, key: "ghost-planned", oneLine: "Ghost planned node", taskId: null, status: "planned", missing: false, deps: [] });
    await route.fulfill({ json: value });
  });
  await page.route(`**/api/v1/ledger/${home.project}/dag/${current.id}/diff?*`, async route => {
    const response = await route.fetch(), value = await response.json();
    value.diff.removed.push("ghost-planned");
    await route.fulfill({ json: value });
  });
  await openFeature();
  await page.getByRole("button", { name: "版本", exact: true }).click();
  await page.getByRole("button", { name: "对比", exact: true }).click();
  await page.locator("button[title]").filter({ hasText: "ghost-planned" }).click();
  await panel(page).getByText("计划中", { exact: true }).waitFor();
  texts.ghost = await panel(page).innerText();
  expect(texts.ghost).not.toMatch(/文件范围|为什么还没开卡/);
  await panel(page).getByRole("button", { name: "关闭", exact: true }).click();
  const compared = page.locator("button[title]").filter({ hasText: "i28-A4" }).first();
  await compared.click();
  await panel(page).getByText("卡", { exact: true }).waitFor();
  texts.compared = await panel(page).innerText();
  expect(texts.compared).not.toMatch(/阶段与用时|所在节点|文件范围|为什么还没开卡/);
  expect(await compared.locator("..").getAttribute("class")).toMatch(/sel/);
  await Bun.write(resolve(dir, "unchanged-pages.json"), JSON.stringify(texts, null, 2));
  if (!baseline && process.env.NODE_CARD_REFERENCE) {
    expect(texts).toEqual(await Bun.file(resolve(process.env.NODE_CARD_REFERENCE, "unchanged-pages.json")).json());
  }
}

test.skipIf(!out)("node card: one detail, selection, dependency/owner navigation, mobile history and fixture screenshots", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const home = generateHomeFixture(), team = await teamFromHome(home), bundle = process.env.NODE_CARD_BUNDLE ?? await bundleHarness(out);
  const { server } = serve(home, team, bundle);
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const evidence: Record<string, unknown> = {};
  try {
    for (const [side, width] of [["local", 1280], ["local", 390], ["team", 1280]] as const) {
      const { page, ctx, calls, external, errors } = await guardedPage(browser, String(server.url), { width });
      const name = `${side}-${width}`, f = home.features[0]!, nodes = f.versions.at(-1)!.nodes;
      await page.goto(`${server.url}?side=${side}&project=${home.project}&team=${home.team}#chat`);
      await page.getByRole("button").filter({ has: page.getByText(f.title, { exact: true }) }).first().click();
      const nodeButton = (key: string) => page.locator("button[title]").filter({ hasText: key }).first();
      const shot = async (suffix: string) => {
        const issues = await shotIssues(page);
        await page.screenshot({ path: resolve(out, `${name}-${suffix}.png`) });
        evidence[`${name}-${suffix}`] = issues;
        expect(issues).toEqual([]);
      };
      await nodeButton("i28-A5").click();
      if (baseline) {
        await panel(page).getByText("卡", { exact: true }).waitFor();
        await shot("node");
        await panel(page).getByRole("button", { name: /^i28-A5 / }).click();
      }
      await loaded(page);
      if (!baseline) {
        await panel(page).getByText("所在节点", { exact: true }).waitFor();
        expect(await panel(page).innerText()).toContain(nodes[4]!.fileGlobs[0]!);
        expect(await panel(page).getByText("历史卡", { exact: true }).count()).toBe(0);
        expect(await nodeButton("i28-A5").locator("..").getAttribute("class")).toMatch(/sel/);
        if (width === 390) expect(await page.evaluate<string>("location.hash")).toBe("#chat?collab=i28-A5");
      }
      if (side === "team") {
        await panel(page).getByText("团队操作", { exact: true }).waitFor();
        expect(await panel(page).getByRole("button", { name: / →$/ }).count()).toBe(0);
      }
      await shot("detail");
      if (!baseline) {
        await panel(page).getByRole("button", { name: /^i28-A4 / }).first().click();
        await loaded(page);
        expect(await panel(page).innerText()).toContain("i28-A4");
        if (side === "local") {
        await panel(page).getByRole("button", { name: / →$/ }).first().click();
        await page.getByRole("tab", { name: "谁在干活", exact: true }).waitFor();
        await page.locator("[data-work-board] button[class*=nodeRowFlash]").waitFor();
        if (width === 390) {
          await page.waitForFunction("location.hash === '#chat'");
          expect(await panel(page).getByText("阶段与用时", { exact: true }).count()).toBe(0);
        } else await panel(page).getByRole("button", { name: "关闭", exact: true }).click();
        await page.getByRole("tab", { name: width === 390 ? "产品 DAG" : /^子 DAG/ }).click();
        if (width === 390) await page.getByRole("button").filter({ has: page.getByText(f.title, { exact: true }) }).first().click();
        } else await panel(page).getByRole("button", { name: "关闭", exact: true }).click();
        await nodeButton("i28-A5").click(); await loaded(page);
      }
      if (width === 390) await back(page);
      else await panel(page).getByRole("button", { name: "关闭", exact: true }).click();
      await nodeButton("i28-A8").click();
      await panel(page).getByText("计划中", { exact: true }).waitFor();
      if (!baseline) {
        await panel(page).getByText("为什么还没开卡", { exact: true }).waitFor();
        expect(await panel(page).innerText()).toContain("前置没满足：i28-A7");
        expect(await panel(page).innerText()).toContain(nodes[7]!.fileGlobs[0]!);
      }
      await shot("planned");
      if (width === 390) {
        await page.evaluate("history.back()");
        await page.waitForFunction("location.hash === '#chat'");
        expect(await page.getByRole("tab", { name: "产品 DAG", exact: true }).getAttribute("aria-selected")).toBe("true");
      }
      if (side === "local" && width === 1280) await unchangedPages(page, home, out);
      expect(errors).toEqual([]); expect(external).toEqual([]);
      if (side === "team") expect(calls.filter(c => /\/ledger\/|\/me\/last-seen\/|\/peers\/contacts|\/team\/quota|\/team\/activity\?project=shared-ledger:/.test(c))).toEqual([]);
      evidence[`${name}-requests`] = { calls, errors, external };
      await ctx.close();
    }
  } finally {
    await Bun.write(resolve(out, "uiEvidence.json"), JSON.stringify(evidence, null, 2));
    await browser.close(); server.stop(true);
  }
}, 120_000);
