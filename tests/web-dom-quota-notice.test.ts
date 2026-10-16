/**
 * QUOTA1：顶部额度卡、今天页额度行、用量看板顶部摘要、设置「实时读取额度」真挂到 happy-dom（React 19）。fetch 全在这里拦下按合成状态答
 * （/lend/quota-lines、/quota/wall 由各用例注入），夹具之外一律 404，不连任何 bridge。happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 * 覆盖：顶部插槽最多一张卡、没有旧横幅 DOM；「看额度」打开今天页到团队与额度块；「已恢复」两步确认后 POST /quota/wall/clear 再重读；
 * 关掉 / 升级再出 / 旧键迁移且不再写；同时开着三处时 /lend/quota-lines 只轮询一份；今天页不发 GET /quota；文案不含禁用词与 low-priority；
 * 读到后 401 清空且不再拉；慢的旧回包不盖新的。
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setAppConfigForTest } from "../web/lib/app-config";
import { machines } from "../web/lib/machines";
import { BANNED_OWNER_WORDS } from "../web/lib/owner-words";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El { textContent: string | null; getAttribute(n: string): string | null; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; click(): void; remove(): void }
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }
interface Win { localStorage: { clear(): void; setItem(k: string, v: string): void; getItem(k: string): string | null } }

let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let win: Win;
type C = (p: Record<string, unknown>) => unknown;
let ui: {
  QuotaNotice: C; NowTeamQuota: C; StatsPanel: C; QuotaLiveSection: C; ChatStoreProvider: C;
  ChatNavContext: { Provider: C }; setPoll: (ms: { lines?: number; wall?: number }) => void;
  takeTodayRequest: (strip: boolean) => { section: string | null } | null; useCollabNav: () => { project: string | null }; TODAY_KEY: string; closeCollab: () => void;
  useWeekQuota: () => { family: string; pct: number }[] | null;
};

const NOW = Date.now();
const RESET = NOW + 3 * 86_400_000;
const line = (family: string, pct: number, state: string) => ({ family, warnPct: 80, stopPct: 90, weekUsedPct: pct, resetAt: RESET, observedAt: NOW, source: "live",
  freshness: "fresh", state, mode: "on", limit: state === "stop" ? "zero" : state === "warn" ? "half" : "none", wouldLimit: "none", granted: 2, lineCap: 2, available: 2, slots: 2 });
const lines = (claude: [number, string], codex: [number, string]) =>
  ({ ok: true, config: { status: "ok", error: null, mode: "on" }, at: NOW, families: [line("claude", ...claude), line("codex", ...codex)] });
const wallOut = { active: true, queued: 3, credits: 2, wall: { kind: "weekly", resetsAt: NOW + 3 * 3_600_000, enteredAt: NOW - 600_000, agents: ["agent-a"] } };
const S1 = { lines: lines([82, "warn"], [18, "below"]), wall: { active: false, wall: null } };
const S2 = { lines: lines([100, "stop"], [95, "stop"]), wall: wallOut };
const S4 = { lines: lines([62, "below"], [18, "below"]), wall: { active: false, wall: null } };

let world: { lines: { status: number; json: unknown }; wall: { status: number; json: unknown }; slowNext?: number };
const setState = (s: { lines: unknown; wall: unknown }) => { world = { lines: { status: 200, json: s.lines }, wall: { status: 200, json: s.wall } }; };
const calls: string[] = [];
let fp = "mac-1";
let fpSeq = 1;
const live = new Set<() => Promise<void>>();
const realFetch = globalThis.fetch, realFp = machines.currentFp;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  win = (globalThis as unknown as { window: Win }).window;
  machines.currentFp = () => fp;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
    const path = url.pathname.replace(/^\/m\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${path}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (path === "/app-config.json") return json({ mode: "direct", fp, machineName: "fixture", version: "" });
    if (path === "/api/v1/lend/quota-lines") {
      const reply = world.lines, slow = world.slowNext; // 发出时的回包；slowNext = 这一个请求晚到多少毫秒
      world.slowNext = undefined;
      if (slow) await new Promise((r) => setTimeout(r, slow));
      return json(reply.json, reply.status);
    }
    if (path === "/api/v1/quota/wall") return json(world.wall.json, world.wall.status);
    if (path === "/api/v1/quota/wall/clear" && method === "POST") {
      world.wall = { status: 200, json: { active: false, wall: { kind: "weekly", enteredAt: wallOut.wall.enteredAt, recovering: true } } };
      return json({ cleared: true });
    }
    if (path === "/api/v1/quota/settings") return json({ enabled: true });
    return json({ ok: false, error: "not in fixture" }, 404);
  }) as typeof fetch;
  const r = (p: string) => require(`../web/features/${p}`);
  const store = r("quota/quota-lines-store.ts"), today = r("now/today-nav.ts"), nav = r("collab/collab-nav.ts");
  ui = { QuotaNotice: r("quota/quota-notice.tsx").QuotaNotice, NowTeamQuota: r("now/now-team-quota.tsx").NowTeamQuota,
    StatsPanel: r("chat/components/stats-panel.tsx").StatsPanel, QuotaLiveSection: r("chat/components/settings/quota-live-section.tsx").QuotaLiveSection,
    ChatStoreProvider: r("chat/chat-store.ts").ChatStoreProvider, ChatNavContext: r("chat/components/nav-context.tsx").ChatNavContext,
    setPoll: store.setQuotaPollForTest, takeTodayRequest: today.takeTodayRequest, TODAY_KEY: today.TODAY_KEY,
    useCollabNav: nav.useCollabNav, closeCollab: nav.closeCollab, useWeekQuota: r("collab/use-count-source.ts").useWeekQuota };
});

afterEach(async () => {
  for (const off of [...live]) await off();
  win.localStorage.clear();
  calls.length = 0;
  fp = `mac-${++fpSeq}`; // 换一台机器 = 读数源清空重拉（模块级缓存，用例之间不串）
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  machines.currentFp = realFp;
  setAppConfigForTest(null);
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const tick = (ms = 20) => React.act(() => new Promise<void>((r) => setTimeout(r, ms)));
async function until(ok: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) { if (ok()) return; await tick(); }
  throw new Error(`timeout waiting for ${what}`);
}
const tr = (s: string, p?: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => String(p?.[k] ?? m));

/** parts：notice = 顶部插槽（embedded）；today = 今天页额度行；stats = 开着的用量看板；week = useWeekQuota 的消费者；live = 设置开关 */
async function mount(parts: ("notice" | "today" | "stats" | "week" | "live")[]) {
  const h = React.createElement as (...a: unknown[]) => unknown;
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  const seen = { week: null as unknown, nav: null as { project: string | null } | null };
  function Week() { seen.week = ui.useWeekQuota(); return null; }
  function Probe() { seen.nav = ui.useCollabNav(); return null; }
  const unmount = async () => {
    if (!live.delete(unmount)) return;
    await React.act(async () => root.unmount());
    host.remove();
  };
  live.add(unmount);
  const kids = parts.map((p) => p === "notice" ? h("div", { key: p, "data-slot": "" }, h(ui.QuotaNotice, { embedded: true }))
    : p === "today" ? h("section", { key: p, "data-now-team": "" }, h(ui.NowTeamQuota, { tr }))
    : p === "stats" ? h(ui.StatsPanel, { key: p, open: true, onClose: () => {} })
    : p === "week" ? h(Week, { key: p }) : h(ui.QuotaLiveSection, { key: p }));
  const nav = { showContent: false, toContent: () => {}, toList: () => {} };
  await React.act(async () => root.render(h(ui.ChatStoreProvider, null, h(ui.ChatNavContext.Provider, { value: nav }, h(Probe), ...kids)) as never));
  const q = (sel: string) => Array.from(doc.body.querySelectorAll(sel));
  const click = async (el: El | null | undefined, what: string) => {
    if (!el) throw new Error(`no ${what}`);
    await React.act(async () => el.click());
    await tick(30);
  };
  const text = (sel: string) => q(sel).map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim());
  return { host, seen, q, click, text, unmount };
}
const count = (re: RegExp) => calls.filter((c) => re.test(c)).length;

test("[验收线 2] 状态 2：顶部插槽里一张卡两行（Claude 用完、Codex 不再接新活），没有旧横幅 DOM；文案不含禁用词", async () => {
  setState(S2);
  const v = await mount(["notice"]);
  await until(() => v.q("[data-quota-notice-row]").length === 2, "two rows");
  expect(v.q("[data-slot] [data-quota-notice]")).toHaveLength(1);
  expect(v.q("[data-quota-notice-row]").map((e) => [e.getAttribute("data-quota-notice-row"), e.getAttribute("data-level")])).toEqual([["claude", "out"], ["codex", "stop"]]);
  const [claude, codex] = v.text("[data-quota-notice-row]");
  expect(claude).toContain("Claude 本周额度用完，");
  expect(claude).toContain("排队 3 条 agent 消息，恢复后自动送达");
  expect(claude).toContain("有 2 次重置可用，在会话里发 /limit-reset");
  expect(codex).toContain("Codex 本周已用 95%，不再接新活");
  expect(v.q('[data-testid="quota-warning"], [data-quota-warning]')).toHaveLength(0);
  const all = v.host.textContent ?? "";
  expect(BANNED_OWNER_WORDS.filter((w) => all.includes(w))).toEqual([]);
  expect(all).not.toMatch(/low-priority/);
});

test("[验收线 2] 状态 1 只出 Claude 一行；状态 4 什么都不出", async () => {
  setState(S1);
  const v = await mount(["notice"]);
  await until(() => v.q("[data-quota-notice-row]").length === 1, "one row");
  expect(v.text("[data-quota-notice-row]")[0]).toContain("Claude 本周已用 82%，到提醒线了");
  await v.unmount();
  fp = `mac-${++fpSeq}`;
  setState(S4);
  const w = await mount(["notice"]);
  await until(() => count(/GET \/api\/v1\/lend\/quota-lines/) >= 2, "second read");
  await tick(300);
  expect(w.q("[data-quota-notice]")).toHaveLength(0);
});

test("[验收线 2]「看额度」打开今天页（团队与额度块）", async () => {
  setState(S1);
  ui.closeCollab();
  ui.takeTodayRequest(false);
  const v = await mount(["notice"]);
  await until(() => v.q("[data-quota-notice-open]").length === 1, "card");
  await v.click(v.q("[data-quota-notice-open]")[0], "看额度");
  expect(v.seen.nav?.project).toBe(ui.TODAY_KEY);
  expect(ui.takeTodayRequest(false)?.section).toBe("team");
});

test("[验收线 4]「已恢复」两步确认：第一下只换成确认，第二下 POST /quota/wall/clear 后重读，换成恢复中、不再有按钮", async () => {
  setState(S2);
  const v = await mount(["notice"]);
  await until(() => v.q("[data-quota-notice-row=claude] button").length === 1, "clear button");
  const btn = () => v.q("[data-quota-notice-row=claude] button")[0];
  expect(btn()?.textContent).toBe("已恢复");
  await v.click(btn(), "已恢复");
  expect(btn()?.textContent).toBe("确认已恢复？");
  expect(count(/^POST /)).toBe(0);
  const wallReads = count(/GET \/api\/v1\/quota\/wall$/);
  await v.click(btn(), "确认");
  await until(() => v.q("[data-quota-notice-row=claude]")[0]?.getAttribute("data-level") === "recovering", "recovering");
  expect(calls.filter((c) => c.startsWith("POST "))).toEqual(["POST /api/v1/quota/wall/clear"]);
  expect(count(/GET \/api\/v1\/quota\/wall$/)).toBe(wallReads + 1);
  expect(v.q("[data-quota-notice-row=claude] button")).toHaveLength(0);
});

test("[验收线 1] 关掉：同严重度不再出（刷新后也是），升级再出；只写新键", async () => {
  setState(S1);
  const v = await mount(["notice"]);
  await until(() => v.q("[data-quota-notice]").length === 1, "card");
  await v.click(v.q('[data-quota-notice] button[aria-label="关闭"]')[0], "关闭");
  await tick(300);
  expect(v.q("[data-quota-notice]")).toHaveLength(0);
  expect(win.localStorage.getItem("cstra_quota_notice_dismissed")).toContain('"warn"');
  expect([win.localStorage.getItem("cstra_quota_wall_dismissed"), win.localStorage.getItem("cstra_quota_warning_dismissed")]).toEqual([null, null]);
  await v.unmount();
  const again = await mount(["notice"]); // 「刷新」：同一台机器、同一份读数
  await tick(200);
  expect(again.q("[data-quota-notice]")).toHaveLength(0);
  await again.unmount();
  setState({ ...S1, lines: lines([91, "stop"], [18, "below"]) });
  fp = `${fp}`; // 同一台机器
  ui.setPoll({ lines: 80 });
  const up = await mount(["notice"]);
  await until(() => up.q("[data-quota-notice-row=claude]")[0]?.getAttribute("data-level") === "stop", "upgrade shows");
  ui.setPoll({ lines: 60_000 });
});

test("[验收线 1] 旧关闭键迁移一次：旧横幅关过的这道闸不再出、Codex 照出；旧键不再写", async () => {
  win.localStorage.setItem("cstra_quota_wall_dismissed", `${wallOut.wall.enteredAt}:active`);
  setState(S2);
  const v = await mount(["notice"]);
  await until(() => v.q("[data-quota-notice-row]").length === 1, "codex only");
  expect(v.q("[data-quota-notice-row]")[0]?.getAttribute("data-quota-notice-row")).toBe("codex");
  expect(win.localStorage.getItem("cstra_quota_notice_dismissed")).toContain(`wall:${wallOut.wall.enteredAt}`);
  await v.click(v.q('[data-quota-notice] button[aria-label="关闭"]')[0], "关闭");
  expect(win.localStorage.getItem("cstra_quota_wall_dismissed")).toBe(`${wallOut.wall.enteredAt}:active`);
  expect(win.localStorage.getItem("cstra_quota_warning_dismissed")).toBeNull();
});

test("[验收线 3] 顶部通知、今天页、用量看板、协作格同时开着：/lend/quota-lines 一个周期只请求一次；今天页本身不发 GET /quota", async () => {
  setState(S1);
  ui.setPoll({ lines: 150, wall: 150 });
  try {
    const start = Date.now();
    const v = await mount(["notice", "today", "stats", "week"]);
    await until(() => v.q("[data-quota-summary]").length === 2 && v.q("[data-quota-notice]").length === 1, "all three");
    await tick(700);
    const elapsed = Date.now() - start;
    const reads = count(/GET \/api\/v1\/lend\/quota-lines$/);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(reads).toBeLessThanOrEqual(Math.floor(elapsed / 150) + 1);
    expect(v.text("[data-now-quota]")).toEqual(["Claude 本周已用 82% 到提醒线 · Codex 本周已用 18%"]);
    expect(v.seen.week).toEqual([{ family: "Claude", pct: 82 }, { family: "Codex", pct: 18 }]);
    await v.unmount();
    calls.length = 0;
    fp = `mac-${++fpSeq}`;
    const today = await mount(["today"]);
    await until(() => today.q("[data-now-quota]").length === 1, "today line");
    await tick(200);
    expect(calls.filter((c) => /\/quota$/.test(c))).toEqual([]); // 不碰用量看板的 GET /quota 心跳
    await today.click(today.q("[data-now-usage]")[0], "看用量");
    await until(() => today.q("[data-quota-summary]").length === 2, "stats panel opened"); // 看板打开 = 今天页行 + 看板顶部摘要
    expect(doc.body.textContent).toContain("用量看板");
  } finally {
    ui.setPoll({ lines: 60_000, wall: 30_000 });
  }
});

test("读不到（403 / 404）：卡与额度行整行不出，不写「暂无」，且这台机器不再拉", async () => {
  world = { lines: { status: 403, json: { ok: false } }, wall: { status: 404, json: {} } };
  const v = await mount(["notice", "today"]);
  await until(() => count(/quota-lines/) === 1 && count(/quota\/wall/) === 1, "first reads");
  await tick(200);
  expect(v.q("[data-quota-notice], [data-now-quota]")).toHaveLength(0);
  expect(v.host.textContent).not.toContain("暂无");
  await v.unmount();
  const again = await mount(["notice"]);
  await tick(200);
  expect([count(/quota-lines/), count(/quota\/wall/)]).toEqual([1, 1]);
  await again.unmount();
});

test("设置「实时读取额度」：标题换词，说明里的链接打开今天页（团队与额度）", async () => {
  setState(S4);
  ui.closeCollab();
  ui.takeTodayRequest(false);
  const v = await mount(["live"]);
  await until(() => v.q("[data-quota-live-today]").length === 1, "live section");
  expect(v.host.textContent).toContain("实时读取额度");
  expect(v.host.textContent).not.toContain("订阅额度实时读取");
  expect(v.text("[data-quota-live-today]")).toEqual(["额度在「今天 · 团队与额度」看"]);
  await v.click(v.q("[data-quota-live-today]")[0], "链接");
  expect(ui.takeTodayRequest(false)?.section).toBe("team");
});

test("读到后 401（凭据失效）：已显示的读数清掉，且不再拉", async () => {
  setState(S1);
  ui.setPoll({ lines: 80 });
  try {
    const v = await mount(["notice"]);
    await until(() => v.q("[data-quota-notice]").length === 1, "card");
    world.lines = { status: 401, json: { ok: false, error: "unauthorized" } };
    await until(() => v.q("[data-quota-notice]").length === 0, "cleared");
    const reads = count(/quota-lines/);
    world.lines = { status: 200, json: S1.lines };
    await tick(300);
    expect(count(/quota-lines/)).toBe(reads);
    expect(v.q("[data-quota-notice]")).toHaveLength(0);
  } finally {
    ui.setPoll({ lines: 60_000 });
  }
});

test("回包乱序：慢的旧回包（提醒）晚到，不覆盖已显示的新状态（不再接新活）", async () => {
  setState(S1);
  world.slowNext = 400;
  ui.setPoll({ lines: 100 });
  try {
    const v = await mount(["notice"]);
    world.lines = { status: 200, json: lines([91, "stop"], [18, "below"]) };
    await until(() => v.q("[data-quota-notice-row=claude]")[0]?.getAttribute("data-level") === "stop", "new state");
    ui.setPoll({ lines: 60_000 });
    await tick(500); // 旧回包到了
    expect(v.q("[data-quota-notice-row=claude]")[0]?.getAttribute("data-level")).toBe("stop");
  } finally {
    ui.setPoll({ lines: 60_000 });
  }
});
