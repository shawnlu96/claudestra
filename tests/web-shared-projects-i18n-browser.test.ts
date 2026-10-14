/**
 * UXI18N1 screenshots (opt-in, private):
 *   SHARED_PROJECTS_I18N_SHOTS_DIR=<dir outside the repo> [SHARED_PROJECTS_I18N_BASE_REPO=<checkout of base main>] bun --no-env-file test tests/web-shared-projects-i18n-browser.test.ts
 * Bundles web/features/collab/shared-projects/fixture-harness.tsx (synthetic port; no production bridge or center) and shoots the project
 * settings dialog (team settings, create form, project settings, members, invite form with the existing-member field), the project
 * confirmation cards, and the sidebar warning for two bindings of the same project (?fixture=bindings-ambiguous with a routed context).
 * Chinese light 1280 / 390 after, plus before when a base checkout is given; English light 390 after (?lang=en).
 * Loopback Bun.serve only: every other request is aborted and counted, and the count must be 0.
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.SHARED_PROJECTS_I18N_SHOTS_DIR, baseRepo = process.env.SHARED_PROJECTS_I18N_BASE_REPO;
const entry = "web/features/collab/shared-projects/fixture-harness.tsx";
/** Internal words the owner must never see in the Chinese UI after this card. */
const INTERNAL = ["N4", "center/team", "personId", "选择头"];
const HAN = /[㐀-鿿（-；]/;
const AMBIGUOUS = ["team-a", "team-b"].map(team => ({ center: "synthetic-center", team, project: "same-project", person: "synthetic-person",
  homeInstanceId: "synthetic-instance" }));
type Side = { label: "before" | "after"; repo: string };
type Guarded = Awaited<ReturnType<typeof guardedPage>>;

async function bundle(repo: string, dir: string) {
  mkdirSync(dir, { recursive: true });
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--outdir", dir, "--tsconfig-override", "web/tsconfig.json"],
    { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  return readFileSync(resolve(dir, "fixture-harness.js"));
}
async function tailwindCss(repo: string): Promise<string> {
  const req = createRequire(resolve(repo, "web/package.json")), globals = resolve(repo, "web/app/globals.css");
  return (await req("postcss")([req("@tailwindcss/postcss")({ base: resolve(repo, "web") })]).process(readFileSync(globals, "utf8"), { from: globals })).css;
}
function serve(js: Uint8Array, css: string) {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/fixture.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
    if (path === "/style.css") return new Response(css, { headers: { "content-type": "text/css" } });
    if (path === "/app-config.json") return Response.json({ mode: "direct", fp: "synthetic-machine" });
    if (path === "/api/v1/shared-ledger/context") return Response.json({ identities: AMBIGUOUS });
    if (path !== "/") return new Response(null, { status: 404 });
    return new Response(`<!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head>
      <body><div id="root"></div><script src="/fixture.js"></script></body></html>`, { headers: { "content-type": "text/html" } });
  } });
}

/** innerText of the given roots plus every option label inside them (closed selects do not show their options in innerText). */
function controlText(page: Page, selector: string): Promise<string[]> {
  return page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(el =>
    [el.innerText, ...[...el.querySelectorAll("option")].map(o => o.textContent)].join("\\n"))`) as Promise<string[]>;
}
/** The dialog parts this card owns: header and every section except the projects-panel list (UXENTRY1 translates that one). */
async function ownedDialogText(page: Page) {
  return page.evaluate(`[...document.querySelectorAll("dialog header, dialog section")]
    .filter(el => el.tagName === "HEADER" || el.querySelector(":scope > h3")?.textContent !== "项目设置")
    .map(el => [el.innerText, ...[...el.querySelectorAll("option")].map(o => o.textContent)].join("\\n"))`) as Promise<string[]>;
}
async function settle(page: Page) {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
}
async function openDialog(page: Page, project: string) {
  await page.getByRole("button", { name: "项目设置", exact: true }).click(); // projects-panel.tsx, not translated by this card
  await page.getByRole("button", { name: project, exact: true }).last().click();
  await page.locator("dialog section").filter({ has: page.locator("legend") }).waitFor();
}

test.skipIf(!out)("UXI18N1: team project settings, invitations and confirmation cards in Chinese and English", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const sides: Side[] = [...(baseRepo ? [{ label: "before" as const, repo: resolve(baseRepo) }] : []), { label: "after", repo: resolve(import.meta.dir, "..") }];
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, requests: Record<string, { external: string[]; errors: string[] }> = {};
  const manifest: { file: string; sha256: string }[] = [];
  const internal: Record<string, string[]> = {}, chinese: Record<string, string[]> = {};
  try {
    for (const side of sides) {
      const server = serve(await bundle(side.repo, resolve(out, `bundle-${side.label}`)), await tailwindCss(side.repo));
      const base = String(server.url).replace(/\/$/, "");
      try {
        const runs = [{ lang: "zh", width: 1280 }, { lang: "zh", width: 390 }, ...(side.label === "after" ? [{ lang: "en", width: 390 }] : [])];
        for (const { lang, width } of runs) {
          const en = lang === "en", project = en ? "Team workbench" : "团队工作台";
          const open = async (query: string) => {
            const g = await guardedPage(browser, base, { width, locale: en ? "en-US" : "zh-CN" });
            await g.page.goto(`${base}/?theme=light${en ? "&lang=en" : ""}&${query}`);
            return g;
          };
          const shot = async (g: Guarded, view: string) => {
            await settle(g.page);
            const name = `${side.label}-${lang}-${view}-${width}`;
            const png = await g.page.screenshot({ path: resolve(out, `${name}.png`), animations: "disabled" });
            manifest.push({ file: `${name}.png`, sha256: createHash("sha256").update(png).digest("hex") });
            issues[name] = await shotIssues(g.page);
            requests[name] = { external: [...g.external], errors: [...g.errors] };
            const text = [await g.page.locator("body").innerText(), ...await controlText(g.page, "body")].join("\n");
            internal[name] = INTERNAL.filter(word => text.includes(word));
          };
          const english = (view: string, texts: string[]) => {
            chinese[`${side.label}-${lang}-${view}-${width}`] = texts.flatMap(t => t.split("\n")).filter(line => HAN.test(line));
          };

          // 1. Project settings dialog: team settings, create form, project settings, local binding, members, invite form.
          const d = await open("fixture=settings");
          await openDialog(d.page, project);
          await shot(d, "dialog-top");
          const existing = d.page.locator("dialog option[value=existing]");
          if (side.label === "after") {
            expect(await existing.textContent()).toBe(en ? "Existing member (enter member ID)" : "已有成员（填写成员编号）");
            await d.page.getByText(en ? "Existing member ID" : "已有成员的编号", { exact: true }).waitFor();
            expect(await d.page.getByLabel("邀请对象", { exact: true }).count()).toBe(1); // aria-label unchanged
          } else expect(await existing.textContent()).toBe("已有中心成员（填写 personId）");
          await d.page.locator("dialog legend").scrollIntoViewIfNeeded();
          await shot(d, "dialog-invite");
          if (en) {
            // A save shows ActionStatus' notice through the dictionary as well.
            await d.page.getByRole("button", { name: "Save name", exact: true }).click();
            await d.page.getByRole("status").filter({ hasText: "Done." }).waitFor();
            english("dialog", await ownedDialogText(d.page));
          }
          await d.ctx.close();

          // 2. Create form error and pending-create text (create answers 202).
          if (en) {
            const c = await open("fixture=pending");
            await c.page.getByRole("button", { name: "项目设置", exact: true }).click();
            await c.page.getByLabel("Display name", { exact: true }).fill("Roadmap");
            await c.page.getByRole("button", { name: "Create project", exact: true }).click();
            await c.page.getByRole("button", { name: "Finish project", exact: true }).waitFor();
            await c.page.getByRole("alert").filter({ hasText: "project confirmation card" }).first().waitFor();
            await shot(c, "create-pending");
            english("create-pending", await ownedDialogText(c.page));
            await c.ctx.close();
          }

          // 3. Project confirmation cards: the card list (an answerable card) and the local binding choice.
          const k = await open(`fixture=expiry&expiresAt=${Date.now() + 600_000}`);
          await k.page.getByRole("region", { name: "项目确认卡", exact: true }).waitFor(); // UXASK2: the dialog keeps one entry row, cards are answered in the inbox
          await shot(k, "cards");
          if (en) english("cards", await controlText(k.page, "section"));
          await k.ctx.close();
          const ch = await open("fixture=choice");
          await ch.page.getByLabel("加入后对应的本机项目", { exact: true }).waitFor(); // aria-label unchanged in both languages
          await shot(ch, "choice");
          if (en) english("choice", await controlText(ch.page, "main > div"));
          await ch.ctx.close();

          // 4. Sidebar warning for two bindings of the same project (projects-panel shows it; this card owns the sentence).
          if (!en) {
            const s = await open("fixture=bindings-ambiguous");
            await s.page.getByText(side.label === "after" ? "这个团队项目在本机对应了多个绑定，已暂停显示；请到项目设置里核对。" : "绑定无法区分",
              { exact: side.label === "after" }).waitFor();
            await shot(s, "sidebar-warning");
            await s.ctx.close();
          }
        }
      } finally { server.stop(true); }
    }
    const head = (await new Response(Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout).text()).trim();
    await Bun.write(resolve(out, "manifest.json"), JSON.stringify({ card: "team-project-UXI18N1", head, baseRepo: baseRepo ?? null, shots: manifest,
      fixtureSha256: createHash("sha256").update(readFileSync(entry)).digest("hex") }, null, 2));
    await Bun.write(resolve(out, "shot-issues.json"), JSON.stringify(issues, null, 2));
    await Bun.write(resolve(out, "requests.json"), JSON.stringify(requests, null, 2));
    await Bun.write(resolve(out, "text-checks.json"), JSON.stringify({ internal, chinese }, null, 2));
    for (const [name, r] of Object.entries(requests)) expect({ name, ...r }).toEqual({ name, external: [], errors: [] });
    for (const [name, list] of Object.entries(issues).filter(([n]) => n.startsWith("after-"))) expect({ name, list }).toEqual({ name, list: [] });
    for (const [name, words] of Object.entries(internal).filter(([n]) => n.startsWith("after-"))) expect({ name, words }).toEqual({ name, words: [] });
    if (baseRepo) expect(Object.entries(internal).some(([n, words]) => n.startsWith("before-") && words.length > 0)).toBe(true);
    expect(Object.keys(chinese).sort()).toEqual(["after-en-cards-390", "after-en-choice-390", "after-en-create-pending-390", "after-en-dialog-390"]);
    for (const [name, lines] of Object.entries(chinese)) expect({ name, lines }).toEqual({ name, lines: [] });
  } finally { await browser.close(); }
}, 600_000);
