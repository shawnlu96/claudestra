/** SUBDAG_SHOTS_DIR=ui-shots enables synthetic new/old-center evidence. Baseline uses SUBDAG_BASELINE_WEB. */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { TASK_FACTS_FIXTURE } from "../src/lib/shared-ledger-contract-task-facts-fixtures";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { shotIssues } from "./helpers/ui-shot-checks";
import { DONE_TITLE, MAIN_NOW, MAIN_TITLE, serveSubdag, SUBDAG_PROJECT, SUBDAG_TEAM } from "./helpers/subdag-fixture";
import type { TaskFacts } from "@/lib/api/shared-ledger-reads";

const out = process.env.SUBDAG_SHOTS_DIR;
const webRoot = process.env.SUBDAG_BASELINE_WEB ?? "web";
const baseline = !!process.env.SUBDAG_BASELINE_WEB;
const phase = baseline ? "before" : "after";
const active = ["a-owner", "a-ci", "a-pool", "a-mq", "a-over", "a-w1"];
type Fixture = ReturnType<typeof serveSubdag>["fx"];
interface Shot { view: string; size: string; phase: string; file: string }
interface Seen { text: string; body: string; issues: Awaited<ReturnType<typeof shotIssues>> }

function taskFacts(fx: Fixture, id: string): TaskFacts {
  const detail = fx.details.get(id)!;
  return { ...TASK_FACTS_FIXTURE, projectId: SUBDAG_PROJECT, featureId: id, tasks: detail.tasks.map((t, i) => {
    if (["done", "verified", "cancelled"].includes(t.stage)) return { ...TASK_FACTS_FIXTURE.tasks[1]!, taskId: t.taskId,
      doneAt: MAIN_NOW - (i + 1) * 3 * 3600_000 };
    if (!active.includes(t.taskId.replace(/^c-/, ""))) return { ...TASK_FACTS_FIXTURE.tasks[2]!, taskId: t.taskId };
    return { ...TASK_FACTS_FIXTURE.tasks[0]!, taskId: t.taskId, stageSince: MAIN_NOW - (65 + i) * 60_000,
      lastEvent: { at: MAIN_NOW - (10 + i) * 60_000, kind: "review" as const } };
  }) };
}

async function openFeature(page: Page, title: string) {
  const tab = page.getByRole("tab", { name: "产品 DAG", exact: true });
  await tab.first().waitFor();
  if (await tab.count()) await tab.first().click();
  const card = page.getByRole("button").filter({ has: page.getByText(title, { exact: true }) }).first();
  await page.getByText(MAIN_TITLE, { exact: true }).first().waitFor();
  if (!await card.isVisible()) await page.locator("button[aria-expanded=false]").filter({ hasText: /已完成|已收尾/ }).first().click();
  await card.click();
  await page.waitForFunction(`!!document.querySelector('[data-focus-board]')`);
  await page.mouse.move(1, 1);
  await page.evaluate("document.fonts.ready");
  await page.waitForTimeout(500);
}

test.skipIf(!out)("[验收线 3] [验收线 4] new and old centers, desktop and mobile, paired screenshots", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const bundle = resolve(out, `${phase}-bundle`);
  const build = Bun.spawn([process.execPath, "build", `${webRoot}/features/collab/shared/fixture-harness.tsx`, "--target", "browser",
    "--outdir", bundle, "--tsconfig-override", `${webRoot}/tsconfig.json`], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const shots: Shot[] = [], seen: Record<string, Seen> = {}, external: string[] = [], errors: string[] = [], unexpected: string[] = [];
  const counts: Record<string, Record<string, number>> = {};
  try {
    for (const center of ["new", "old"] as const) for (const width of [1280, 390]) {
      let fx: Fixture;
      const reads: Record<string, number> = {};
      const served = serveSubdag(bundle, { extra: path => {
        const match = path.match(/^\/api\/v1\/shared-ledger\/features\/([^/]+)\/task-facts$/);
        if (!match) return null;
        const id = match[1]!;
        reads[id] = (reads[id] ?? 0) + 1;
        return center === "old" ? new Response("forbidden", { status: 403 }) : Response.json(taskFacts(fx, id));
      } });
      fx = served.fx;
      const g = await guardedPage(browser, `${served.server.url}`, { width, theme: "light" });
      const warnings: string[] = [];
      g.page.on("console", msg => { if (msg.type() === "warning") warnings.push(msg.text()); });
      try {
        await g.page.clock.setFixedTime(MAIN_NOW);
        await g.page.goto(`${served.server.url}?side=team&theme=light&project=${SUBDAG_PROJECT}&team=${SUBDAG_TEAM}`);
        for (const [view, title] of [["main", MAIN_TITLE], ["done", DONE_TITLE]] as const) {
          await openFeature(g.page, title);
          const name = `${center}-${view}`, size = `${width}x900`, file = `${phase}-${name}-${size}.png`;
          await g.page.screenshot({ path: resolve(out, file) });
          shots.push({ view: name, size, phase, file });
          const board = g.page.locator("[data-focus-board]");
          const text = await board.innerText();
          seen[`${name}-${size}`] = { text, body: await g.page.locator("body").innerText(), issues: await shotIssues(g.page) };
          expect(text).not.toContain("暂无");
          if (!baseline && center === "new" && view === "main") {
            for (const key of [...active, "a-w2", "a-peer"]) {
              const cardText = await board.locator(`[data-focus-key="${key}"]`).innerText();
              const dwell = board.locator(`[data-focus-key="${key}"] [class*=dwell]`);
              if (active.includes(key)) { expect(cardText).toMatch(/\d+ 分钟前 · 审查/); expect(await dwell.count()).toBe(1); }
              else { expect(cardText).not.toMatch(/分钟前/); expect(await dwell.count()).toBe(0); }
            }
            expect(text).toContain("近 24 小时完成");
          }
        }
        expect(g.calls.filter(c => c.includes("ext-capabilities"))).toEqual([]);
        expect(warnings).toEqual([]);
        if (!baseline) expect(reads).toEqual({ F1: 1, F9: 1 });
        counts[`${center}-${width}`] = reads;
        external.push(...g.external); errors.push(...g.errors); unexpected.push(...served.unexpected);
      } catch (error) {
        writeFileSync(resolve(out, "navigation-error.txt"), await g.page.locator("body").innerText());
        await g.page.screenshot({ path: resolve(out, "navigation-error.png") });
        throw error;
      } finally { await g.ctx.close(); served.server.stop(true); }
    }
  } finally { await browser.close(); }
  writeFileSync(resolve(out, `${phase}-evidence.json`), JSON.stringify({ shots, seen, counts, external, errors, unexpected }, null, 2) + "\n");
  expect(external).toEqual([]); expect(errors).toEqual([]); expect(unexpected).toEqual([]);
  for (const [view, value] of Object.entries(seen)) expect({ view, issues: value.issues }).toEqual({ view, issues: [] });
  if (!baseline) {
    const before = JSON.parse(readFileSync(resolve(out, "before-evidence.json"), "utf8")) as { seen: Record<string, Seen>; shots: Shot[] };
    for (const [view, value] of Object.entries(seen)) if (view.startsWith("old-")) expect(value.body).toBe(before.seen[view]!.body);
    writeFileSync(resolve(out, "manifest.json"), JSON.stringify({ v: 1, summary: "团队子 DAG 时间与最近事件，新旧中心及两种屏宽对照",
      shots: [...before.shots, ...shots] }, null, 2) + "\n");
  }
}, 240_000);
