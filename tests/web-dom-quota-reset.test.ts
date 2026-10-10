/**
 * 订阅额度面板里 Codex「使用一次重置」：真 React DOM（happy-dom）+ 真 useSubscriptionQuota / QuotaArea + 真 api 客户端，只把 fetch 换成假 bridge。
 *   - 此刻可用为 0：按钮置灰，写数据给的原因，点不动、不发请求；
 *   - 可用：先出二次确认（扣 1 次、到期时间、不可撤销），取消不发；确认后 POST 一次（最早到期那张的键），显示结果并重拉面板；
 *   - 上游没确切答复 / 409 / 403：如实写，并照样重拉。
 * 不出网：fetch 拦在本文件，真实「使用」接口一次都不调；happy-dom 只在本文件注册、afterAll 注销（guard TESTS_WEB_DOM）。
 */
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { appConfigSync, setAppConfigForTest } from "@/lib/app-config";
import { fmtAt } from "../web/features/chat/quota-view";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El { textContent: string | null; disabled: boolean; click(): void; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> }
interface Host extends El { remove(): void }
interface Doc { createElement(tag: string): Host; body: { appendChild(c: Host): void } }

const KEY_A = "a".repeat(32);
const KEY_B = "b".repeat(32);
const EXP_A = Date.now() + 2 * 86400_000;
const EXP_B = Date.now() + 9 * 86400_000;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let Area: (p: { quota: unknown; g: null; quotas: [] }) => unknown;
let useQuota: (open: boolean) => unknown;

/** 假 bridge：applicable = 此刻可用；answer = POST 的状态码与响应体；POST 之后此刻可用变 0（证明面板重拉了） */
const bridge = { applicable: 1, limitReached: false, answer: { status: 200, body: { ok: true, result: { status: "done", code: "reset", windowsReset: 2 } } as unknown } };
const requests: { path: string; method: string; body?: Record<string, unknown> }[] = [];
let restore = () => {};

function quotaBody() {
  return {
    ok: true, enabled: true,
    snapshot: { generatedAt: Date.now(), providers: [{
      id: "codex", name: "Codex", kind: "subscription", plan: "plus", account: { key: "k", identity: "bound" },
      meters: [{ id: "5h", kind: "session", label: null, unit: "pct", used: 40, resetsAtMs: null, resetPassed: false }],
      resetCredits: { held: 2, applicableNow: bridge.applicable, limitReached: bridge.limitReached, stale: false, observedAt: Date.now(),
        credits: [{ key: KEY_A, expiresAtMs: EXP_A }, { key: KEY_B, expiresAtMs: EXP_B }] },
      source: { layer: "live", observedAt: Date.now(), reason: null },
    }] },
  };
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1200, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  ({ QuotaArea: Area } = await import(new URL("../web/features/chat/components/subscription-quota-cards.tsx", import.meta.url).href));
  ({ useSubscriptionQuota: useQuota } = await import(new URL("../web/features/chat/use-subscription-quota.ts", import.meta.url).href));
  const prevConfig = appConfigSync();
  setAppConfigForTest({ mode: "direct", fp: "local", machineName: "quota-reset-fixture", version: "test" });
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push({ path, method, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/api/v1/quota" && method === "GET") return json(200, quotaBody());
    if (path === "/api/v1/quota/codex/reset-credit" && method === "POST") {
      bridge.applicable = 0;
      return json(bridge.answer.status, bridge.answer.body);
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  }) as typeof globalThis.fetch);
  restore = () => {
    try {
      spy.mockRestore();
    } finally {
      setAppConfigForTest(prevConfig);
    }
  };
});
afterAll(async () => {
  restore();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});
afterEach(() => {
  requests.length = 0;
  Object.assign(bridge, { applicable: 1, limitReached: false, answer: { status: 200, body: { ok: true, result: { status: "done", code: "reset", windowsReset: 2 } } } });
});

const settle = () => React.act(async () => void (await new Promise((r) => setTimeout(r, 10))));
async function mount(): Promise<Host & { unmount(): Promise<void> }> {
  const h = React.createElement as unknown as (...a: unknown[]) => unknown;
  const Harness = () => h(Area, { quota: useQuota(true), g: null, quotas: [] });
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  await React.act(async () => root.render(h(Harness) as never));
  await settle();
  return Object.assign(host, { unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } });
}
const btn = (host: El, text: string) => Array.from(host.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === text) ?? null;
const click = async (el: El | null) => {
  expect(el).not.toBeNull();
  await React.act(async () => el!.click());
  await settle();
};
const posts = () => requests.filter((r) => r.method === "POST");
const gets = () => requests.filter((r) => r.method === "GET" && r.path === "/api/v1/quota").length;

test("此刻可用为 0：按钮置灰、写数据给的原因，点了也不发请求", async () => {
  bridge.applicable = 0;
  const host = await mount();
  expect(host.textContent).toContain("持有 2 次，此刻可用 0 次");
  const b = btn(host, "使用一次重置");
  expect(b?.disabled).toBe(true);
  expect(host.textContent).toContain("额度还没到上限，现在不需要重置");
  await click(b);
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  expect(posts()).toEqual([]);
  await host.unmount();

  bridge.limitReached = true; // 撞了上限仍是 0：照数据写「此刻没有能用的卡」，不编原因
  const again = await mount();
  expect(again.textContent).toContain("接口说此刻没有能用的卡");
  await again.unmount();
});

test("可用：先出二次确认（扣 1 次、到期时间、不可撤销），取消不发请求", async () => {
  const host = await mount();
  await click(btn(host, "使用一次重置"));
  const dialog = host.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toContain(`会消耗 1 次重置卡（${fmtAt(EXP_A)} 到期），不可撤销。确定使用？`);
  await click(btn(host, "取消"));
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  expect(posts()).toEqual([]);
  await host.unmount();
});

test("确认后 POST 一次（最早到期那张的键），显示成功，并重拉面板（此刻可用变 0、按钮置灰）", async () => {
  const host = await mount();
  const before = gets();
  await click(btn(host, "使用一次重置"));
  await click(btn(host, "确认使用"));
  expect(posts()).toEqual([{ path: "/api/v1/quota/codex/reset-credit", method: "POST", body: { creditKey: KEY_A } }]);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("已使用 1 次重置，额度已补满");
  expect(gets()).toBeGreaterThan(before);
  expect(host.textContent).toContain("此刻可用 0 次");
  expect(btn(host, "使用一次重置")?.disabled).toBe(true);
  await host.unmount();
});

const FAILURES: [string, { status: number; body: unknown }, string][] = [
  ["上游没确切答复", { status: 200, body: { ok: true, result: { status: "failed", code: "timeout" } } }, "使用请求没拿到确切答复（接口超时），扣没扣以刷新后的数字为准"],
  ["上游拒了（没扣）", { status: 200, body: { ok: true, result: { status: "done", code: "nothing_to_reset", windowsReset: 0 } } }, "接口说现在不需要重置，没有扣卡"],
  ["另一个还在途", { status: 409, body: { ok: false, error: "another reset is already in progress" } }, "已有一个使用请求在进行中"],
  ["不是 owner 本人的设备", { status: 403, body: { ok: false, error: "forbidden" } }, "需要 owner 本人的设备才能使用重置卡"],
];
for (const [name, answer, text] of FAILURES) {
  test(`${name}：如实写结果，并照样重拉面板`, async () => {
    bridge.answer = answer;
    const host = await mount();
    const before = gets();
    await click(btn(host, "使用一次重置"));
    await click(btn(host, "确认使用"));
    expect(posts()).toHaveLength(1);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(text);
    expect(gets()).toBeGreaterThan(before);
    await host.unmount();
  });
}
