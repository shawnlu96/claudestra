/**
 * UXINBOX1 截图与 DOM 断言（opt-in，截图不进 git）：
 *   OWNER_WAITS_SHOTS_DIR=<仓库外目录> [OWNER_WAITS_BASE_REPO=<基线 main 的检出目录>] bun --no-env-file test tests/web-collab-owner-waits-browser.test.ts
 * 打包 web/features/collab/shared/fixture-harness.tsx（side=team，前面垫一个设当前机器的入口，见 bundle），数据照规格「对照基准」：团队键能解析到本机项目；
 * 本机有 1 张本人提的待批提案卡（project 为大总管、带 extra.centerProposal）+ 1 张本项目的普通等 owner 的 ask。
 * 页面：协作视图首页、「待你处理」页、团队标签提案区（列表正常 / 读 429 / 读 404），1280 与 390、浅色。
 * 给了 OWNER_WAITS_BASE_REPO 就用同一份数据再拍一套「改前」（只截图、只断言改前的现状）。
 * 「去处理」另开一页 ?drawer=1：垫的入口照生产外壳（asks-entry.tsx）在 asksStore 打开时挂上生产的 AsksDrawer，并带上 Tailwind（抽屉的样式与层级都在那里）；
 * 点了之后断言抽屉标题和那张提案卡真的在最上层（elementFromPoint），不是只看 store 状态。回环 Bun.serve，非回环请求一律拦掉并断言为 0。
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { generateHomeFixture } from "@/features/collab/shared/home-fixture-gen";
import { guardedPage, serve } from "./helpers/collab-fixture-serve";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";
import { teamFromHome } from "./web-team-parity-browser-center.test";

const out = process.env.OWNER_WAITS_SHOTS_DIR, baseRepo = process.env.OWNER_WAITS_BASE_REPO;
const RAW = "center raw: Bearer sk-RAW-CENTER-TEXT";
const PROPOSAL_TITLE = "卡片工作优先级";
type Review = "ok" | "429" | "404";

/**
 * fixture-harness.tsx 不经过生产的 machine-gate，「当前机器」是空的，绑定 store 会把 context 回包当成换过机器丢掉。
 * 这里在它前面垫一个入口：先像 machine-gate 那样把本机（app-config 的 fp）设成当前机器，再原样加载 fixture-harness。改前 / 改后同一个垫法。
 */
async function bundle(repo: string, dir: string) {
  mkdirSync(dir, { recursive: true });
  const entry = resolve(dir, "entry.ts"), from = (f: string) => JSON.stringify(resolve(repo, f));
  // 入口在仓库外，裸模块名解析不到：react 按 web/node_modules 里的路径引（和夹具里的是同一份），不写 JSX
  await Bun.write(entry, `import { createElement } from ${from("web/node_modules/react/index.js")};
import { createRoot } from ${from("web/node_modules/react-dom/client.js")};
import { machines } from ${from("web/lib/machines.ts")};
import { useAsks } from ${from("web/features/asks/asks-store.ts")};
import { AsksDrawer } from ${from("web/features/asks/components/asks-drawer.tsx")};
await machines.add({ fp: "local", name: "fixture" });
await machines.setCurrent("local");
await import(${from("web/features/collab/shared/fixture-harness.tsx")});
// ?drawer=1：照生产外壳（asks-entry.tsx）挂全站收件箱抽屉，样式用 /tw.css
function Inbox() { return useAsks().open ? createElement(AsksDrawer, { onOpenChat() {} }) : null; }
if (new URLSearchParams(location.search).has("drawer")) {
  document.head.appendChild(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/tw.css" }));
  createRoot(document.body.appendChild(document.createElement("div"))).render(createElement(Inbox));
}
`);
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser",
    "--outdir", resolve(dir, "dist"), "--tsconfig-override", "web/tsconfig.json"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  return resolve(dir, "dist");
}

/** 夹具服务器（tests/helpers/collab-fixture-serve.ts）前面套一层：绑定、待办、提案接口换成本卡的数据，其余原样转给它 */
/** 生产的 Tailwind 样式表（web/app/globals.css），只给 ?drawer=1 那一页用 */
async function tailwindCss(repo: string): Promise<string> {
  const req = createRequire(resolve(repo, "web/package.json")), globals = resolve(repo, "web/app/globals.css");
  return (await req("postcss")([req("@tailwindcss/postcss")({ base: resolve(repo, "web") })]).process(readFileSync(globals, "utf8"), { from: globals })).css;
}

function world(home: ReturnType<typeof generateHomeFixture>, inner: string, tw: string) {
  const p = home.project, now = home.now, state = { review: "ok" as Review };
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  const ask = (over: Record<string, unknown>) => ({ fromAgent: null, assignee: null, project: p, taskId: null, context: "", body: "", kind: "decide", kindHint: null,
    source: "reply", options: [], allowText: true, blocking: true, urgency: "normal", state: "open", answer: null, createdAt: now - 3600_000,
    updatedAt: now - 3600_000, expiresAt: now + 86_400_000, canAnswer: true, ...over });
  const asks = [
    ask({ id: "ask-a7", fromAgent: "agent-dev-1", taskId: "i28-A7", title: "接口命名二选一" }),
    ask({ id: "ask-proposal", project: "master", kind: "authorize", source: "system", createdBy: "system:center-proposal-inbox",
      title: `提案待你批准：${PROPOSAL_TITLE}`, context: "提案人：你本人（经你的 PM）", allowText: false,
      options: [{ type: "buttons", buttons: [{ id: "cp_approve", label: "批准", style: "success" }, { id: "cp_reject", label: "驳回", style: "danger" }] }],
      extra: { centerProposal: { localProjectId: p, proposalId: "proposal-1", proposalRev: 1, proposalDigest: "d".repeat(64) } } })];
  const card = { proposalId: "proposal-1", proposalRev: 1, proposalDigest: "sha256:proposal-1", state: "pending_approval", drift: false, title: PROPOSAL_TITLE,
    description: "按优先级排卡片工作", nodes: [{ key: "N1", oneLine: "优先级字段与排序" }], version: null, expiresAt: now + 86_400_000, proposer: { type: "service", code: "self" } };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url), path = decodeURIComponent(url.pathname);
    if (path === "/tw.css") return new Response(tw, { headers: { "content-type": "text/css" } });
    if (path === "/api/v1/shared-ledger/context") return json({ identities: [{ center: "center", team: home.team, person: "person-a", project: p,
      homeInstanceId: home.sourceInstanceId, localProjectId: p }] });
    if (path === "/api/v1/asks") return json({ ok: true, asks, now, canAnswer: true });
    if (path === "/api/v1/shared-projects/snapshot") return json({ v: 1, identity: { subject: "owner:self", kind: "person", centerId: "center", teamId: home.team,
      personId: "person-a", instanceId: home.sourceInstanceId }, teamRole: { available: true, value: "owner" },
      capabilities: { invite: { available: false }, leave: { available: false } },
      projects: [{ centerId: "center", teamId: home.team, projectId: p, name: "Claudestra", rev: 1, status: "active", projectRole: { available: true, value: "owner" }, localProjectIds: [p] }],
      localProjects: [{ id: p, name: "Claudestra", personal: false, eligible: false, dirs: [] }], peers: [] });
    if (path === "/api/v1/shared-feature-proposals" && req.method === "GET") return json({ ok: true, operations: [{ operationId: "op-1", projectId: p,
      title: PROPOSAL_TITLE, state: "pending_approval", issue: null, expiresAt: now + 86_400_000, createdAt: now - 60_000 }] });
    if (path === `/api/v1/shared-feature-proposals/projects/${p}`) return state.review === "ok" ? json({ ok: true, proposals: [card] })
      : json({ ok: false, error: RAW, message: RAW }, Number(state.review));
    return fetch(new Request(inner + url.pathname + url.search, { method: req.method, headers: req.headers, body: req.method === "GET" ? undefined : await req.text() }));
  } });
  return { server, state };
}

const waitsButton = (page: Page) => page.getByRole("button", { name: /^待你处理/ }).first();
async function settle(page: Page) {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
}

/**
 * 从「待你处理」页点提案的「去处理」：全站收件箱抽屉在最上层（标题、那张卡都点得到，手机上整屏页不再盖住它），卡带聚焦边框；
 * 返回后回到「待你处理」页。
 */
/** UXHOME1 PM 补：「去处理」每一行都有；card = 点哪一行（提案卡，或带卡号的普通卡） */
const CARDS = { proposal: { id: "ask-proposal", title: `提案待你批准：${PROPOSAL_TITLE}` }, plain: { id: "ask-a7", title: "接口命名二选一" } } as const;
async function inboxFromWaits(g: Awaited<ReturnType<typeof guardedPage>>, narrow: boolean, shot: (g: Awaited<ReturnType<typeof guardedPage>>, view: string) => Promise<void>,
  card: (typeof CARDS)[keyof typeof CARDS] = CARDS.proposal) {
  await g.page.waitForFunction(`[...document.querySelectorAll("button")].some((b) => /^待你处理\\s*2$/.test(b.innerText.trim()))`);
  await waitsButton(g.page).click();
  await g.page.getByText("这个项目上开着、等你的").waitFor();
  await g.page.getByRole("button", { name: `去处理 ${card.title}`, exact: true }).last().click();
  const drawer = g.page.getByRole("dialog", { name: "待你处理" });
  await drawer.getByText(card.title).first().waitFor();
  await g.page.waitForFunction(`(() => { const r = document.getElementById("ask-${card.id}").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`);
  await g.page.waitForTimeout(400); // scrollIntoView 的平滑滚动停稳
  const top = await g.page.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]'), card = document.getElementById("ask-${card.id}");
    const title = [...dialog.querySelectorAll("span")].find((x) => x.textContent === "待你处理");
    const onTop = (el) => { const r = el.getBoundingClientRect(); return dialog.contains(document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 12))); };
    return { title: onTop(title), card: onTop(card), focused: card.className.includes("border-primary"), sheet: document.body.innerText.includes("这个项目上开着、等你的") };
  })()`);
  expect<unknown>({ narrow, ...(top as object) }).toEqual({ narrow, title: true, card: true, focused: true, sheet: !narrow }); // 手机上整屏页先收起；桌面右栏照旧在抽屉底下
  if (card === CARDS.proposal) await shot(g, "05-inbox-from-waits");
  // 返回：抽屉收起，「待你处理」页还在
  await drawer.getByRole("button", { name: narrow ? "返回" : "关闭" }).click();
  await drawer.waitFor({ state: "detached" });
  await g.page.getByText("这个项目上开着、等你的").waitFor();
  await g.ctx.close();
}

test.skipIf(!out)("UXINBOX1：待你处理计数 / 去处理 / 提案区读失败原因，1280 与 390 改前改后", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const home = generateHomeFixture(), team = await teamFromHome(home);
  const sides = [...(baseRepo ? [{ label: "before", repo: resolve(baseRepo) }] : []), { label: "after", repo: resolve(import.meta.dir, "..") }];
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, requests: Record<string, { external: string[]; errors: string[] }> = {};
  try {
    for (const { label, repo } of sides) {
      const after = label === "after";
      const fixture = serve(home, team, await bundle(repo, resolve(out, `bundle-${label}`)));
      const w = world(home, String(fixture.server.url).replace(/\/$/, ""), after ? await tailwindCss(repo) : "");
      try {
        for (const width of [1280, 390]) {
          const narrow = width < 700;
          const open = async (review: Review, extra = "") => {
            w.state.review = review;
            const g = await guardedPage(browser, String(w.server.url), { width });
            const ready = g.page.waitForResponse((r) => r.url().includes("/api/v1/asks"));
            await g.page.goto(`${w.server.url}?side=team&theme=light&project=${home.project}&team=${home.team}${extra}`);
            await g.page.getByRole("progressbar", { name: home.features[0]!.title, exact: true }).first().waitFor({ timeout: 15_000 });
            await ready;
            return g;
          };
          const shot = async (g: Awaited<ReturnType<typeof open>>, view: string) => {
            await settle(g.page);
            const name = `${label}-${view}-${width}`;
            await g.page.screenshot({ path: resolve(out, `${name}.png`) });
            issues[name] = await shotIssues(g.page);
            requests[name] = { external: [...g.external], errors: [...g.errors] };
          };

          // 首页：顶栏（手机按钮）/ 大纲 / 右栏「要你定的」
          const g = await open("ok");
          if (after) await g.page.waitForFunction(`[...document.querySelectorAll("button")].some((b) => /^待你处理\\s*2$/.test(b.innerText.trim()))`);
          const count = (await waitsButton(g.page).innerText()).replace("待你处理", "").trim();
          expect({ label, width, count }).toEqual({ label, width, count: after ? "2" : "暂无" });
          if (after && !narrow) {
            const rail = g.page.locator("aside section", { hasText: "要你定的" }).first();
            await rail.getByText(`提案待你批准：${PROPOSAL_TITLE}`).waitFor();
            await rail.getByText("接口命名二选一").waitFor();
            expect(await rail.getByRole("button", { name: /^去处理/ }).count()).toBe(2); // UXHOME1 PM 补：每一行都有「去处理」
          }
          await shot(g, "01-home");
          // 「待你处理」页
          await waitsButton(g.page).click();
          await g.page.getByText("这个项目上开着、等你的").waitFor();
          if (after) {
            const go = g.page.getByRole("button", { name: `去处理 提案待你批准：${PROPOSAL_TITLE}`, exact: true });
            await go.last().waitFor();
            expect(await g.page.getByRole("button", { name: /^(批准|驳回)/ }).count()).toBe(0); // 协作视图里不另做批准按钮
            await shot(g, "02-waits");
            await go.last().click();
            if (narrow) await g.page.waitForFunction(`location.hash.startsWith("#asks")`);
          } else await shot(g, "02-waits");
          await g.ctx.close();
          if (after) {
            await inboxFromWaits(await open("ok", "&drawer=1"), narrow, shot);
            await inboxFromWaits(await open("ok", "&drawer=1"), narrow, shot, CARDS.plain);
            // 有卡号的行：点卡号照旧打开任务详情（不是收件箱）
            const k = await open("ok");
            await waitsButton(k.page).click();
            await k.page.getByText("这个项目上开着、等你的").waitFor();
            await k.page.getByRole("button", { name: /^i28-A7/ }).last().click();
            await k.page.getByText("这个项目上开着、等你的").waitFor({ state: "detached" });
            await k.page.getByText(home.details["i28-A7"]!.task.title, { exact: false }).first().waitFor();
            expect(await k.page.getByRole("dialog", { name: "待你处理" }).count()).toBe(0);
            await k.ctx.close();
          }

          // 团队标签提案区：列表正常 / 读 429 / 读 404
          for (const review of ["ok", "429", "404"] as const) {
            const t = await open(review);
            const tab = after ? "规划与提案" : "团队"; // UXHOME1：团队源下「团队」标签改名
            await (narrow ? t.page.getByRole("button", { name: tab, exact: true }) : t.page.getByRole("tab", { name: tab, exact: true })).click();
            await t.page.getByText("待审提案", { exact: true }).first().waitFor();
            await t.page.getByText("正在读取…").waitFor({ state: "detached" });
            if (after) {
              const text = await t.page.locator("body").innerText();
              expect(text).not.toMatch(/RAW-CENTER-TEXT|center raw|Bearer/);
              expect(text).not.toContain("待项目 owner 批准");
              await t.page.getByText("待你批准", { exact: true }).first().waitFor();
              if (review === "429") await t.page.getByText("读得太频繁，稍后自动重读").first().waitFor();
              if (review === "404") await t.page.getByText("中心或本机 bridge 没有提案接口").first().waitFor();
              if (review !== "ok") expect(await t.page.getByText("读取失败", { exact: true }).count()).toBe(0);
            } else if (review !== "ok") await t.page.getByText("读取失败", { exact: true }).first().waitFor();
            await t.page.getByText("待审提案", { exact: true }).first().scrollIntoViewIfNeeded();
            await shot(t, `03-team-proposals-${review}`);
            await t.ctx.close();
          }
        }
      } finally { w.server.stop(true); fixture.server.stop(true); }
    }
    await Bun.write(resolve(out, "shot-issues.json"), JSON.stringify(issues, null, 2));
    await Bun.write(resolve(out, "requests.json"), JSON.stringify(requests, null, 2));
    for (const [name, r] of Object.entries(requests)) expect({ name, ...r }).toEqual({ name, external: [], errors: [] });
    for (const [name, list] of Object.entries(issues).filter(([n]) => n.startsWith("after-"))) expect({ name, list }).toEqual({ name, list: [] });
  } finally { await browser.close(); }
}, 600_000);
