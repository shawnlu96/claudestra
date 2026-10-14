/**
 * team-project-UXCARD1 截图（opt-in）：DETAIL_NOW_SHOTS_DIR=<目录> bun test tests/web-collab-detail-now-browser.test.ts
 * 同一个 fixture-harness：side=local 拍主场本机的审查卡（审查员在跑、已 23 分钟）/ 开发卡（执行者忙、有此刻动作、19 个文件范围）/
 * 没有目标句但事项描述很长的卡；side=team 拍别的机器为主场的合并卡（中心没有时间线）。1280 / 390 各一张，浅色，过截图自动检查、只回环。
 * DETAIL_NOW_BASELINE_WEB=<main 的 web 目录> 换成改前的构建，文件名前缀 before-。时钟钉在夹具的 now 上，前后两次时长一致。纯 fixture，不连生产。
 */
import { expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateHomeFixture, type HomeFixture } from "@/features/collab/shared/home-fixture-gen";
import { teamFromHome } from "./web-team-parity-browser-center.test";
import { guardedPage, serve } from "./helpers/collab-fixture-serve";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.DETAIL_NOW_SHOTS_DIR;
const webRoot = process.env.DETAIL_NOW_BASELINE_WEB ?? "web";
const prefix = process.env.DETAIL_NOW_BASELINE_WEB ? "before" : "after";
const MIN = 60_000;
const REVIEW = "i28-A4", BUILD = "i28-A6", NO_GOAL = "i28-A5", AWAY_MERGE = "i28-A3";
const LONG_FEATURE = "这是事项很长的一句描述：owner 当初在晚间汇总里的原话抱怨，说详情里看不出谁在做、做了多久、下一步归谁，也不是这张卡要做的事";

/** 只动本卡要拍的四张卡：审查卡有在跑的审查员（进审查 40 分钟、派审 23 分钟前）；开发卡 19 个文件范围；A5 去掉目标句 */
function focus(home: HomeFixture): HomeFixture {
  const now = home.now, rv = home.details[REVIEW]!;
  Object.assign(rv.task, { round: 2, stageSince: now - 40 * MIN, extra: { goal: "合并闸 merge gate：手机端列表与全屏详情对齐 — 本卡目标" } });
  rv.sessions = { author: { agent: "agent-dev-1" }, reviewer: { agent: "agent-rv-1", state: "active" } };
  rv.events = [...rv.events, { seq: home.seq + 1, ts: now - 23 * MIN, actor: "scheduler", target: REVIEW, kind: "scheduler", text: "派 review 给 agent-rv-1",
    data: { op: "plan", node: "review", action: "dispatch", recipient: "agent-rv-1" } }];
  Object.assign(home.details[BUILD]!.task, { stageSince: now - 12 * MIN });
  const node = home.features[0]!.versions.at(-1)!.nodes.find((n) => n.key === BUILD)!;
  node.fileGlobs = Array.from({ length: 19 }, (_, i) => `web/features/collab/detail-part-${String(i + 1).padStart(2, "0")}.tsx`);
  delete home.details[NO_GOAL]!.task.extra;
  home.overview.items[0]!.oneLine = LONG_FEATURE;
  home.features[0]!.ownerWords = LONG_FEATURE;
  return home;
}

/** 开发卡执行者忙（/agents 的 busy） */
async function liveAgent(page: Page, home: HomeFixture) {
  const agent = home.details[BUILD]!.task.agent!;
  await page.route(/\/api\/v1\/agents(\?.*)?$/, (r) => r.fulfill({ json: { ok: true, agents: ["dev-1", "dev-2", "dev-3", "pm-a", "rv-1"].map((n) => ({ name: `agent-${n}`,
    status: "active", busy: `agent-${n}` === agent, projectId: home.project, cwd: "/repo", lastActivityTs: home.now })) } }));
}

/**
 * 夹具服务器前面的一层回环代理：只多答 /api/v1/events，开着不断，每秒说一次开发卡执行者在 Edit（此刻动作那一行）。
 * 流一断协作视图就重连并清空动作（use-collab.ts onOpen），成员表到之前的事件也不收，所以不能一次回完。其余请求原样转给夹具服务器。
 */
function withEvents(inner: URL, home: HomeFixture) {
  const agent = home.details[BUILD]!.task.agent!, enc = new TextEncoder();
  const frame = (seq: number) => `data: ${JSON.stringify({ seq, ts: new Date(home.now).toISOString(), agent, chatId: "", type: "tool_start",
    data: { name: "Edit", detail: "web/features/collab/collab-detail.tsx" } })}\n\n`;
  const timers = new Set<ReturnType<typeof setInterval>>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/api/v1/events") return fetch(new URL(url.pathname + url.search, inner), { method: req.method, headers: req.headers, body: req.body });
    let seq = 0, timer: ReturnType<typeof setInterval>;
    return new Response(new ReadableStream({
      start(c) { c.enqueue(enc.encode(": connected\n\n")); timer = setInterval(() => c.enqueue(enc.encode(frame(++seq))), 1000); timers.add(timer); },
      cancel() { clearInterval(timer); timers.delete(timer); },
    }), { headers: { "content-type": "text/event-stream" } });
  } });
  return { url: server.url, stop: () => { for (const t of timers) clearInterval(t); server.stop(true); } };
}

/** 团队侧：本机绑定与 shared-projects 快照里记着主场实例是 alice-mac，参与者 / 对它说写机器名（team-instance-names.ts） */
async function peerNames(page: Page, home: HomeFixture) {
  const identity = { center: "center", team: home.team, person: "person-a", project: home.project, machine: "local" };
  await page.route(/\/api\/v1\/shared-ledger\/context(\?.*)?$/, (r) => r.fulfill({ json: { identities: [{ ...identity, homeInstanceId: "this-machine", localProjectId: home.project }] } }));
  await page.route(/\/api\/v1\/shared-projects\/snapshot(\?.*)?$/, (r) => r.fulfill({ json: { v: 1, identity: { subject: "owner:self", kind: "person",
    centerId: "center", teamId: home.team, personId: "person-a", instanceId: "this-machine" }, teamRole: { available: true, value: "member" },
    capabilities: { invite: { available: false }, leave: { available: false } }, projects: [], localProjects: [],
    peers: [{ name: "alice-mac", enabled: true, invitable: true, instanceId: home.sourceInstanceId }] } }));
}

async function openCard(page: Page, home: HomeFixture, id: string, narrow: boolean, ready: string) {
  const task = home.details[id]!.task;
  if (narrow) {
    const f = home.features.find((x) => x.id === task.itemId)!;
    await page.getByRole("button").filter({ has: page.getByText(f.title, { exact: true }) }).first().click();
  }
  await page.getByText(task.title, { exact: true }).first().click();
  await page.locator("aside h5", { hasText: "现在" }).first().waitFor();
  await page.waitForFunction(`![...document.querySelectorAll("aside")].some((a) => a.innerText.includes("正在读取"))`);
  // 子 DAG 的「所在节点」、团队侧的机器名都是另一路请求，到了再拍
  await page.locator("aside").filter({ hasText: id }).getByText(ready, { exact: false }).first().waitFor();
  // 此刻动作每秒推一次：等它进到「现在」再拍（只有开发卡有）
  await page.waitForTimeout(1500);
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
}

const SHOTS: { side: "local" | "team"; id: string; view: string; ready: string }[] = [
  { side: "local", id: REVIEW, view: "review-local", ready: "所在节点" }, { side: "local", id: BUILD, view: "build-local", ready: "所在节点" },
  { side: "local", id: NO_GOAL, view: "nogoal-local", ready: "所在节点" }, { side: "team", id: AWAY_MERGE, view: "away-merge-team", ready: "所在节点" },
];

test.skipIf(!out)("UXCARD1 detail: review / build / no-goal (local) + away merge (team) at 1280 / 390", async () => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const bundle = resolve(out, `${prefix}-bundle`);
  const build = Bun.spawn([process.execPath, "build", `${webRoot}/features/collab/shared/fixture-harness.tsx`, "--target", "browser",
    "--outdir", bundle, "--tsconfig-override", `${webRoot}/tsconfig.json`], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const base = generateHomeFixture(), team = await teamFromHome(base), home = focus(generateHomeFixture());
  const { server } = serve(home, team, bundle), proxy = withEvents(server.url, home);
  const browser: Browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {}, external: string[] = [], errors: string[] = [], texts: Record<string, string> = {};
  const shots: { view: string; size: string; phase: string; ref: string; sha256: string }[] = [];
  try {
    for (const width of [1280, 390]) {
      for (const s of SHOTS) {
        const g = await guardedPage(browser, proxy.url.href, { width });
        // 桌面面板整页装下（「对它说」旁的叫停在面板底部）；手机的对它说钉在底部，常规高度就看得到
        await g.page.setViewportSize({ width, height: width < 640 ? 1400 : 2300 });
        await g.page.clock.setFixedTime(home.now);
        await (s.side === "local" ? liveAgent(g.page, home) : peerNames(g.page, home));
        await g.page.goto(`${proxy.url}?side=${s.side}&theme=light&project=${home.project}&team=${home.team}`);
        await g.page.getByRole("progressbar", { name: home.features[0]!.title, exact: true }).first().waitFor({ timeout: 15_000 });
        await openCard(g.page, home, s.id, width < 640, s.ready);
        const ref = `${prefix}-${s.view}-${width}.png`;
        const png = await g.page.screenshot({ path: resolve(out, ref) });
        shots.push({ view: s.view, size: String(width), phase: prefix, ref, sha256: createHash("sha256").update(png).digest("hex") });
        issues[ref] = await shotIssues(g.page);
        texts[ref] = await g.page.locator("aside").filter({ hasText: s.id }).first().innerText();
        external.push(...g.external);
        errors.push(...g.errors);
        await g.ctx.close();
      }
    }
  } finally {
    await browser.close();
    proxy.stop();
    server.stop(true);
  }
  writeFileSync(resolve(out, `${prefix}-shots.json`), JSON.stringify({ shots, issues, external, errors, texts }, null, 2));
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
  expect(Object.values(issues).flat()).toEqual([]);
}, 240_000);
