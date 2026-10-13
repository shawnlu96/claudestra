/**
 * 设置 · 连接与集成 · 通知（web/features/chat/components/settings/notify-section.tsx）：真挂载到 happy-dom 跑 React 19（guard TESTS_WEB_DOM）。
 * 设置页只列渠道；「添加渠道」开配置弹窗（portal 到 body）→ 选 ntfy → 自带随机 topic → 保存，已有渠道不回传任何密钥字段（bridge 沿用旧值）；
 * 弹窗里能叠开设置向导。接口 mock 掉（@/lib/api/notify）。
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El { textContent: string | null; remove(): void; querySelectorAll(sel: string): ArrayLike<El & { click(): void }> }
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }

const BARK = {
  id: "bark0001", kind: "bark", name: "iPhone", enabled: true, types: ["ask", "security"], onlyWhenAway: true, hideContent: false,
  server: "https://api.day.app", deviceKeySet: true, deviceKeyHint: "…3456",
};
const puts: { channels: Record<string, unknown>[]; openUrl: string }[] = [];
const realNotify = await import("@/lib/api/notify");
// mock.module 对整个进程生效：同进程后面的文件要拿到其余真导出
mock.module("@/lib/api/notify", () => ({
  ...realNotify,
  getNotify: async () => ({ channels: [BARK], openUrl: "", linkBase: "https://relay.example", recent: { bark0001: [{ at: Date.now() - 120_000, type: "ask", ok: true, status: 200 }] } }),
  putNotify: async (channels: Record<string, unknown>[], openUrl: string) => {
    puts.push({ channels, openUrl });
    return { channels: [BARK], openUrl, linkBase: "https://relay.example", recent: {} };
  },
  testNotify: async () => ({ at: Date.now(), type: "test", ok: true, status: 200 }),
}));

const SECTION = new URL("../web/features/chat/components/settings/notify-section.tsx", import.meta.url).href;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let NotifySection: () => unknown;
let doc: Doc;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  ({ NotifySection } = (await import(SECTION)) as { NotifySection: typeof NotifySection });
  doc = (globalThis as unknown as { document: Doc }).document;
});
afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

/** 弹窗 portal 到 body：按钮在整页里找 */
const button = (host: El, text: string) => {
  const b = Array.from(host.querySelectorAll("button")).find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`没有按钮「${text}」：${host.textContent}`);
  return b;
};

test("列表、弹窗里新加 ntfy 带随机 topic、向导、保存不回传已存的密钥", async () => {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  await React.act(async () => root.render(React.createElement(NotifySection as never)));
  await React.act(async () => {});
  expect(host.textContent).toContain("iPhone");
  expect(host.textContent).toContain("待你处理 · 安全提醒 · ✓ 2分钟前");
  expect(host.textContent).not.toContain("推送哪些"); // 设置页里没有表单
  await React.act(async () => button(host, "+ 添加渠道").click());
  const page = doc.body;
  await React.act(async () => button(page, "ntfyAndroid / iOS / 网页都能收，可用官方服务器或自建").click());
  expect(page.textContent).toContain("推送哪些");
  expect(page.textContent).toContain("全部待你处理都推");
  await React.act(async () => button(page, "设置向导").click());
  expect(page.textContent).toContain("ntfy 设置向导");
  expect(page.textContent).toContain("upstream-base-url");
  expect(host.textContent).not.toContain("推送哪些"); // 表单在弹窗里，不撑长设置页
  await React.act(async () => button(page, "保存").click());
  await React.act(async () => {});
  expect(puts).toHaveLength(1);
  const [bark, ntfy] = puts[0].channels;
  // 已存的渠道原样回传（视图里没有 allAsks 的按开算）；新建的缺省：全部待你处理都推、在不在都推
  expect(bark).toEqual({
    id: "bark0001", kind: "bark", name: "iPhone", enabled: true, types: ["ask", "security"], onlyWhenAway: true, allAsks: true, hideContent: false, server: "https://api.day.app",
  });
  expect(ntfy).toMatchObject({ kind: "ntfy", name: "ntfy", server: "", types: ["ask", "security", "system"], onlyWhenAway: false, allAsks: true, hideContent: false });
  expect(String(ntfy.topic)).toMatch(/^cstra-[a-z0-9]{12}$/);
  expect(ntfy).not.toHaveProperty("id");
  await React.act(async () => root.unmount());
  host.remove();
});
