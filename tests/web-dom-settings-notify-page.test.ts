/**
 * 设置 ·「通知」页（web/features/chat/components/settings/pages.tsx 的 NotifyPage + nav.tsx）：真挂载到 happy-dom 跑 React 19（guard TESTS_WEB_DOM）。
 * 和推送有关的设置都在这一页，按「这台设备 / 这台电脑发出的所有推送 / 第三方渠道」三组排；菜单里排在「外观」后面，非全权设备看不到。
 * 接口 mock 掉（@/lib/api/notify）；推送开关的状态由 SettingsModal 持有，这里直接给一份。
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El { tagName: string; textContent: string | null; children: ArrayLike<El>; remove(): void; querySelector(sel: string): El | null }
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }

const NTFY = { id: "ntfy0001", kind: "ntfy", name: "手机", enabled: true, types: ["ask"], onlyWhenAway: false, allAsks: true, hideContent: false, server: "", topic: "cstra-abcdefghijkl" };
const realNotify = await import("@/lib/api/notify");
// mock.module 对整个进程生效：同进程后面的文件要拿到其余真导出
mock.module("@/lib/api/notify", () => ({
  ...realNotify,
  getNotify: async () => ({ channels: [NTFY], openUrl: "", linkBase: "https://relay.example", recent: {} }),
}));

const NAV = new URL("../web/features/chat/components/settings/nav.tsx", import.meta.url).href;
const PAGES = new URL("../web/features/chat/components/settings/pages.tsx", import.meta.url).href;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let SettingsPage: (p: { page: string; s: unknown }) => unknown;
let SETTINGS_PAGES: { id: string; label: string }[];
let settingsPagesFor: (full: boolean) => string[];
let doc: Doc;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  ({ SETTINGS_PAGES, settingsPagesFor } = (await import(NAV)) as { SETTINGS_PAGES: typeof SETTINGS_PAGES; settingsPagesFor: typeof settingsPagesFor });
  ({ SettingsPage } = (await import(PAGES)) as { SettingsPage: typeof SettingsPage });
  doc = (globalThis as unknown as { document: Doc }).document;
});
afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

test("菜单：「通知」排在「外观」和「连接与集成」之间；非全权设备没有这一页", () => {
  const full = settingsPagesFor(true);
  expect(full.slice(full.indexOf("appearance"), full.indexOf("connect") + 1)).toEqual(["appearance", "notify", "connect"]);
  expect(SETTINGS_PAGES.find((p) => p.id === "notify")?.label).toBe("通知");
  expect(new Set(full).size).toBe(full.length);
  expect(settingsPagesFor(false)).not.toContain("notify");
});

test("「通知」页：三组、四个分区，顺序固定", async () => {
  const flag = { on: false, busy: false, err: "", toggle: async () => {} };
  const push = { pushOn: true, pushMsg: "", pushBusy: false, togglePush: async () => {}, noContent: flag, allAsks: flag };
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  await React.act(async () => root.render(React.createElement(SettingsPage as never, { page: "notify", s: { full: true, busy: false, push } } as never)));
  await React.act(async () => {});
  // 组头是 div，分区卡片是 section（section.tsx），卡片标题是里面第一个 span
  const outline = Array.from(host.children).map((c) => (c.tagName === "SECTION" ? `· ${c.querySelector("span")?.textContent}` : c.textContent));
  expect(outline).toEqual(["这台设备", "· 推送通知", "这台电脑发出的所有推送", "· 推送不带正文", "· 全部待你处理都推", "第三方渠道", "· 通知渠道"]);
  expect(host.textContent).toContain("手机"); // 渠道列表在第三组里
  expect(host.textContent).toContain("+ 添加渠道");
  await React.act(async () => root.unmount());
  host.remove();
});
