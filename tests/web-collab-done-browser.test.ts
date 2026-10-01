/** Opt-in real UI + backend regression: DONE_BROWSER=1 TZ=Asia/Shanghai bun test tests/web-collab-done-browser.test.ts.
 * Browser timezone is America/Los_Angeles. Requests are fulfilled in-process; no bridge, credentials or listening port.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { projectView } from "../src/lib/ledger-read";
import { donePage, parseDoneCursor } from "../src/lib/ledger-read-done";
import { closeLedger, openLedger } from "../src/lib/ledger-store";
import { importTask } from "../src/lib/ledger-write";

const enabled = process.env.DONE_BROWSER === "1";
const now = Date.parse("2026-10-01T18:00:00Z");
const out = resolve("ledger/reviews/i28-V1p-shots");
const bundle = resolve(".playwright-mcp/i28-V1p/bundle");
let browser: Browser;
let db: ReturnType<typeof openLedger>;
let assets: Map<string, Blob>;

const fixture = `
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { fetchLedger } from "../../lib/api/ledger";
import { homeView } from "../../features/collab/collab-model";
import { MobileList } from "../../features/collab/v4/v4-mobile";
import { Outline } from "../../features/collab/v4/v4-outline";
import s from "../../features/collab/collab.module.css";
const tr = (s, vars = {}) => s.replace(/\\{(\\w+)\\}/g, (_, key) => String(vars[key] ?? key)), noop = () => {};
function App() {
  const [ov, setOv] = useState(null);
  useEffect(() => { fetchLedger("p").then(setOv); }, []);
  if (!ov) return null;
  const home = homeView(ov, Date.now());
  const common = { project: "p", ov, lines: new Map(home.lines.map(l => [l.id, l])), onPick: noop, tr };
  return <div className={s.tokens + " " + s.root}>
    {location.search.includes("mobile")
      ? <MobileList {...common} todayDone={home.todayDone} now={Date.now()} actionText={() => ""} />
      : <Outline {...common} filter="done" onFilter={noop} waits={[]} onWaits={noop} selected={null} />}
  </div>;
}
createRoot(document.getElementById("root")).render(<App />);
`;

beforeAll(async () => {
  if (!enabled) return;
  db = openLedger(":memory:");
  for (let k = 0; k < 90; k++) {
    const end = Date.parse("2026-10-01T15:30:00Z") - k * 60_000;
    const id = `done-${String(k).padStart(3, "0")}`;
    importTask(db, { actor: "owner", now }, {
      createdTs: end - 3_600_000, initialStage: "build",
      events: [{ kind: "stage", ts: end, data: { from: "build", to: "done" } }],
      task: { project: "p", id, title: `协作已完成任务 ${k + 1}：验证跨时区步骤与分页`, kind: "code", stage: "done", agent: "agent-worker" },
    });
    db.run(`INSERT INTO task_steps (taskId, step, round, executor, executorKind, state, verified, claims, rev, createdAt, updatedAt)
      VALUES (?, 'write', 0, 'agent-worker', 'agent', 'done', '{}', '{}', 1, ?, ?)`, [id, end, end]);
  }
  mkdirSync(out, { recursive: true });
  const entry = resolve("web/.next/done-regression/fixture.tsx");
  await Bun.write(entry, fixture);
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--outdir", bundle], { stdout: "pipe", stderr: "pipe" });
  const [code, log] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  unlinkSync(entry);
  if (code) throw new Error(log);
  assets = new Map(readdirSync(bundle).map((name) => ["/" + name, Bun.file(resolve(bundle, name))]));
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
});
afterAll(async () => {
  await browser?.close();
  if (enabled) closeLedger(":memory:");
}, 20_000);

for (const theme of ["light", "dark"] as const) for (const mobile of [true, false]) {
  test.skipIf(!enabled)(`${theme} ${mobile ? "390px mobile" : "desktop"}: first page, next page dots, retained rows + automatic retry`, async () => {
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1100, height: 844 }, timezoneId: "America/Los_Angeles", colorScheme: theme });
    const errors: string[] = [];
    const requests: { at: number; cursor: string | null }[] = [];
    let failOnce = false;
    page.on("pageerror", (e) => errors.push(e.message));
    await page.clock.setFixedTime(now);
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
      const asset = assets.get(url.pathname);
      if (asset) return route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript", body: Buffer.from(await asset.arrayBuffer()) });
      if (url.pathname === "/") {
        const css = [...assets.keys()].filter((p) => p.endsWith(".css")).map((p) => `<link rel="stylesheet" href="${p}">`).join("");
        const js = [...assets.keys()].find((p) => p.endsWith(".js"));
        return route.fulfill({ contentType: "text/html", body: `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">${css}<style>
          *{box-sizing:border-box} body{margin:0;font:14px system-ui} button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
          #root{height:100vh;display:flex} h5{margin:0} button svg{vertical-align:middle}
          </style></head><body><div id="root"></div><script type="module" src="${js}"></script></body></html>` });
      }
      if (url.pathname === "/app-config.json") return json({ mode: "direct", fp: "fixture", machineName: "fixture", version: "" });
      if (url.pathname === "/api/v1/ledger/p") return json({ ok: true, exists: true, now, ...projectView(db, "p", now, Number(url.searchParams.get("dayStart"))) });
      if (url.pathname === "/api/v1/ledger/p/done") {
        const cursor = url.searchParams.get("before");
        requests.push({ at: Date.now(), cursor });
        if (failOnce) { failOnce = false; return json({ error: "temporary" }, 503); }
        return json(donePage(db, "p", cursor ? parseDoneCursor(cursor) : null, Number(url.searchParams.get("limit")), now));
      }
      return json({ error: "unexpected route" }, 404);
    });
    try {
      await page.goto(`http://done.test/${mobile ? "?mobile" : ""}`);
      await page.getByText("done-000", { exact: true }).waitFor();
      const first = page.getByRole("button").filter({ has: page.getByText("done-000", { exact: true }) });
      if (mobile) expect(await first.locator("[data-step-dots]").count()).toBe(1);
      const prefix = `${theme}-${mobile ? "mobile-390" : "desktop"}`;
      await page.screenshot({ path: resolve(out, `${prefix}-first.png`) });
      if (mobile) await page.getByRole("button", { name: "更早完成", exact: true }).click();
      const more = page.getByRole("button", { name: "更多", exact: true });
      await more.scrollIntoViewIfNeeded(); // IntersectionObserver loads the next page.
      await page.getByText("done-030", { exact: true }).waitFor();
      const paged = page.getByRole("button").filter({ has: page.getByText("done-030", { exact: true }) });
      if (mobile) expect(await paged.locator("[data-step-dots]").count()).toBe(1);
      await page.evaluate(`Array.from(document.querySelectorAll('button')).find(el => el.textContent.includes('done-030'))
        .scrollIntoView({block: 'start', behavior: 'instant'})`);
      await page.screenshot({ path: resolve(out, `${prefix}-next.png`) });
      const overflow = await page.evaluate(`Array.from(document.querySelectorAll("body, #root, nav, section"))
        .filter(e => e.scrollWidth > e.clientWidth + 1).map(e => ({ tag: e.tagName, width: e.clientWidth, scroll: e.scrollWidth }))`);
      expect(overflow).toEqual([]);
      failOnce = true;
      await more.scrollIntoViewIfNeeded();
      await page.getByRole("status").waitFor();
      expect(await paged.count()).toBe(1); // Failed next request leaves both earlier pages intact.
      await page.getByText("done-089", { exact: true }).waitFor({ timeout: 10_000 });
      expect(requests).toHaveLength(3);
      expect(requests[1]!.cursor).toBe(requests[2]!.cursor);
      expect(requests[2]!.at - requests[1]!.at).toBeGreaterThanOrEqual(1900);
      expect(errors).toEqual([]);
      await Bun.write(resolve(out, `${prefix}-evidence.json`), JSON.stringify({ timezone: "America/Los_Angeles", serverTimezone: process.env.TZ, requests, overflow, errors }, null, 2));
    } finally { await page.close(); }
  }, 30_000);
}
