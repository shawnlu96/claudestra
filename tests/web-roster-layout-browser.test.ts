/**
 * ROSTER4R1 roster layout while loading (opt-in, real Chromium):
 *   ROSTER_LAYOUT_BROWSER=1 bun test tests/web-roster-layout-browser.test.ts
 *   ROSTER_LAYOUT_SHOTS=<outside repo> ROSTER_LAYOUT_PHASE=before|after adds the 1 s / 6 s screenshots at 1440 and 390.
 * The page mounts the real TeamPanel (team source: members + planning) with the planning body arriving late,
 * and the fixture holds the directory and the seats back separately; every animation frame records where the metrics bar,
 * the first member card and the tab strip are, so a jump between two samples cannot slip through.
 */
import { expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateHomeFixture } from "@/features/collab/shared/home-fixture-gen";
import { teamFromHome } from "./web-team-parity-browser-center.test";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { serveRoster, type RosterServeOpts } from "./helpers/roster-shots";

const enabled = process.env.ROSTER_LAYOUT_BROWSER === "1";
const shotsDir = process.env.ROSTER_LAYOUT_SHOTS;
const phase = process.env.ROSTER_LAYOUT_PHASE === "before" ? "before" : "after";
const launch = () => chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });

async function panelBundle(out: string) {
  mkdirSync(out, { recursive: true });
  const entry = resolve(out, "roster-panel.tsx"), bundle = resolve(out, "panel-bundle");
  const path = (p: string) => JSON.stringify(resolve("web", p));
  writeFileSync(entry, `import React from ${path("node_modules/react")};
    import { createRoot } from ${path("node_modules/react-dom/client")};
    import { TeamPanel } from ${path("features/collab/team-panel.tsx")};
    import { machines } from ${path("lib/machines.ts")};
    import { loadAppConfig } from ${path("lib/app-config.ts")};
    const project = new URLSearchParams(location.search).get("project");
    function Shell() {
      const [ops, setOps] = React.useState(null);
      React.useEffect(() => { const t = setTimeout(() => setOps(React.createElement("p", null, "ops body")), 2500); return () => clearTimeout(t); }, []);
      return React.createElement(TeamPanel, { unavailable: true, project, ov: null, agents: [], now: Date.now(), ops });
    }
    void loadAppConfig().then(() => machines.load()).then(() => machines.add({ fp: "local", name: "fixture" })).then(() => machines.setCurrent("local"))
      .then(() => createRoot(document.getElementById("root")).render(React.createElement(Shell)));`);
  const child = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--outdir", bundle,
    "--tsconfig-override", resolve("web/tsconfig.json")], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  return bundle;
}

/** Theme tokens the app shell normally provides, so borders and panels are visible in the screenshots. */
const TOKENS = `:root{--line:#e2e2e2;--panel:#fff;--bg:#f5f5f4;--text:#1b1b1b;--text-2:#666;--muted:#999;--err:#c0392b;--warn:#a86400;--accent:#2f6fd6}
  body{background:var(--bg);color:var(--text)}`;
const SAMPLE = `window.__frames = [];
  addEventListener("DOMContentLoaded", () => { const st = document.createElement("style"); st.textContent = ${JSON.stringify(TOKENS)}; document.head.append(st); });
  const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; };
  const tick = () => {
    const cards = [...document.querySelectorAll("[data-roster-member], [data-roster-placeholder]")];
    const metrics = document.querySelector("[data-roster-metric]")?.parentElement ?? null;
    window.__frames.push({ t: performance.now(), metrics: box(metrics), card: box(cards[0]),
      tabs: [...document.querySelectorAll("[role=tab]")].map(b => b.textContent),
      members: cards.map(c => c.getAttribute("data-roster-member") ?? "placeholder"),
      machines: document.querySelectorAll("[data-roster-machine]").length });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);`;
type Box = { x: number; y: number; w: number };
interface Frame { t: number; metrics: Box | null; card: Box | null; tabs: string[]; members: string[]; machines: number }

const bundleOnce = (() => { let b: Promise<string> | null = null; return () => b ??= panelBundle(mkdtempSync(resolve(tmpdir(), "roster-layout-"))); })();
async function open(browser: Browser, opts: RosterServeOpts, width = 1440, clock = false) {
  const home = generateHomeFixture(), team = await teamFromHome(home);
  const srv = serveRoster(home, team, await bundleOnce(), 200, opts);
  const g = await guardedPage(browser, String(srv.server.url), { width });
  await g.page.emulateMedia({ reducedMotion: "reduce" });
  await g.page.addInitScript(SAMPLE);
  if (clock) await g.page.clock.install();
  const started = Date.now();
  await g.page.goto(`${srv.server.url}?${new URLSearchParams({ project: home.project })}`);
  return { ...g, home, started, close: async () => { await g.ctx.close(); srv.stop(); } };
}
const settled = "document.querySelectorAll('[data-roster-machine]').length === 3 && !!document.querySelector('[data-roster-member=person-a]') && document.querySelectorAll('[role=tab]').length > 0";
/** Largest move (or width change: the same box keeps its size) of a box against its first sample. */
const shift = (frames: Frame[], pick: (f: Frame) => Box | null) => {
  const seen = frames.map(pick).filter(b => b !== null);
  return seen.length ? Math.max(...seen.map(b => Math.max(Math.abs(b.x - seen[0]!.x), Math.abs(b.y - seen[0]!.y), Math.abs(b.w - seen[0]!.w)))) : Infinity;
};

async function loadRun(opts: RosterServeOpts) {
  const browser = await launch();
  try {
    const p = await open(browser, opts);
    try {
      await p.page.waitForFunction(settled, undefined, { timeout: 12_000 });
      await p.page.waitForTimeout(3_000); // past the late planning body
      const all = await p.page.evaluate<Frame[]>("window.__frames");
      const frames = all.slice(all.findIndex(f => f.metrics !== null));
      return { frames, external: p.external, errors: p.errors };
    } finally { await p.close(); }
  } finally { await browser.close(); }
}
function expectSteady({ frames, external, errors }: Awaited<ReturnType<typeof loadRun>>) {
  expect(frames.length).toBeGreaterThan(10);
  const tabs = [...new Set(frames.map(f => f.tabs.join("|")))];
  // Machine-only cards before the directory is known would be the "by machine, then by person" reshuffle.
  const machineFirst = frames.filter(f => f.machines > 0 && !f.members.some(m => m.startsWith("person-")));
  // The first card's box is there from the first frame (a placeholder until the data lands), not popped in later.
  const cardless = frames.filter(f => f.card === null).length;
  expect({ metrics: shift(frames, f => f.metrics) <= 4, card: shift(frames, f => f.card) <= 4, cardless, tabs, machineFirst: machineFirst.length })
    .toEqual({ metrics: true, card: true, cardless: 0, tabs: [frames[0]!.tabs.join("|")], machineFirst: 0 });
  expect(frames.at(-1)!.tabs).toEqual(["成员", "规划与提案"]);
  expect(external).toEqual([]); expect(errors).toEqual([]);
}

test.skipIf(!enabled)("[1] directory after 1 s, seats after 4 s: metrics and first card move ≤ 4px, tab strip never changes", async () => {
  expectSteady(await loadRun({ delay: { snapshot: 1_000, roster: 4_000 } }));
}, 60_000);

test.skipIf(!enabled)("[2] seats after 1 s, directory after 4 s: same, and no machine-first cards", async () => {
  expectSteady(await loadRun({ delay: { roster: 1_000, snapshot: 4_000 } }));
}, 60_000);

const MARK = `[...document.querySelectorAll("[data-roster-member], [data-roster-metric]")].map(el => {
  el.__mark ??= Math.random(); const r = el.getBoundingClientRect();
  return { id: el.getAttribute("data-roster-member") ?? el.getAttribute("data-roster-metric"), mark: el.__mark, x: r.x, y: r.y };
})`;
test.skipIf(!enabled)("[3] a poll with the same data keeps every card and metric in place; a new member only inserts its card", async () => {
  const browser = await launch();
  try {
    const p = await open(browser, {}, 1440, true);
    let extra = false;
    await p.page.route("**/api/v1/shared-projects/snapshot", async r => {
      const res = await r.fetch(), body = await res.json();
      if (extra) body.teamDirectory.members.push({ personId: "person-d", code: "Delta", teamRole: "member" });
      await r.fulfill({ response: res, json: body });
    });
    const reads = (re: RegExp) => p.calls.filter(c => re.test(c)).length;
    try {
      await p.page.waitForFunction(settled, undefined, { timeout: 10_000 });
      await p.page.waitForTimeout(300);
      const before = await p.page.evaluate<{ id: string; mark: number; x: number; y: number }[]>(MARK);
      const roster = reads(/\/team\/roster\?/), dir = reads(/shared-projects\/snapshot/);
      await p.page.clock.fastForward(60_001);
      await p.page.waitForFunction(`performance.now() > 0`);
      for (let i = 0; i < 80 && (reads(/\/team\/roster\?/) === roster || reads(/shared-projects\/snapshot/) === dir); i++) await Bun.sleep(25);
      await p.page.waitForTimeout(300);
      expect(await p.page.evaluate<typeof before>(MARK)).toEqual(before);
      extra = true;
      await p.page.clock.fastForward(60_001);
      await p.page.waitForFunction("!!document.querySelector('[data-roster-member=person-d]')", undefined, { timeout: 5_000 });
      const after = await p.page.evaluate<{ id: string; mark: number }[]>(MARK);
      const cards = (l: { id: string; mark: number }[]) => l.filter(e => /^person-|^unclaimed$/.test(e.id));
      expect(cards(after).filter(e => e.id !== "person-d")).toEqual(cards(before).map(({ id, mark }) => expect.objectContaining({ id, mark })));
      expect(cards(after).map(e => e.id)).toEqual(["person-a", "person-b", "person-d", "person-c", "unclaimed"]);
      expect(p.external).toEqual([]);
    } finally { await p.close(); }
  } finally { await browser.close(); }
}, 60_000);

test.skipIf(!enabled || !shotsDir)("[4] screenshots at 1 s and 6 s (directory 1 s, seats 4 s), 1440 and 390", async () => {
  mkdirSync(shotsDir!, { recursive: true });
  const browser = await launch();
  try {
    for (const width of [1440, 390]) {
      const p = await open(browser, { delay: { snapshot: 1_000, roster: 4_000 } }, width);
      try {
        for (const at of [1, 6]) {
          await p.page.waitForTimeout(Math.max(0, p.started + at * 1_000 - Date.now()));
          await p.page.screenshot({ path: resolve(shotsDir!, `${phase}-load-${at}s-${width}x900.png`) });
        }
      } finally { await p.close(); }
    }
  } finally { await browser.close(); }
}, 60_000);
