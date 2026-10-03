/**
 * web/features/collab/v4/sheet-history.ts：手机整屏页的历史条目归属（PR553-r1 P2）。
 * 真挂载到 happy-dom 跑 React 19 + history API；happy-dom 只在本文件注册、afterAll 注销（同 web-dom-error-boundary.test.ts）。
 * 重点是「层被非 × 的路径收起」与「切宽屏」后不留空历史，以及详情接手后不误 back。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { useSheetHistory, type HistoryPort } from "@/features/collab/v4/sheet-history";

/** 仓库根没有 DOM 类型：只描述用到的那几样，取 happy-dom 注册的全局 */
interface Win {
  location: { hash: string };
  history: { length: number; state: unknown; pushState(s: unknown, t: string, u: string): void; replaceState(s: unknown, t: string, u: string): void; back(): void };
  addEventListener(t: string, f: () => void, o?: { once?: boolean }): void;
  removeEventListener(t: string, f: () => void): void;
}
interface Doc { createElement(tag: string): { remove(): void }; body: { appendChild(c: unknown): void } }
const win = () => globalThis as unknown as Win;
const doc = () => (globalThis as unknown as { document: Doc }).document;
/** 测试走 happy-dom 的真 history（popstate 异步，同浏览器）；和 lib/hash-nav-browser.ts 的 browserHistory 一一对应 */
const port: HistoryPort = {
  hash: () => win().location.hash,
  push: (h) => win().history.pushState({ cstraCollab: true }, "", h),
  replace: (h) => win().history.replaceState(win().history.state, "", h),
  back: () => win().history.back(),
  onPop: (f) => { win().addEventListener("popstate", f); return () => win().removeEventListener("popstate", f); },
};

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
});
afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

interface Ctl { sel: string | null; setSel(s: string | null): void; setNarrow(n: boolean): void }
/** 和 collab-view 同一种接法：成员页的 × 回团队，其余 × 收起 */
async function mount(initialNarrow = true) {
  const ctl = {} as Ctl;
  function Harness() {
    const [sel, setSel] = React.useState<string | null>(null);
    const [narrow, setNarrow] = React.useState(initialNarrow);
    const close = () => setSel((s) => (s === "member" ? "team" : null));
    useSheetHistory(sel !== null, narrow, `~${sel ?? ""}`, close, port);
    Object.assign(ctl, { sel, setSel, setNarrow });
    return null;
  }
  const host = doc().createElement("div");
  doc().body.appendChild(host);
  const root = createRoot(host as never);
  await React.act(async () => root.render(React.createElement(Harness)));
  const act = (f: () => void) => React.act(async () => f());
  return { ctl, act, unmount: () => React.act(async () => root.unmount()) };
}

const hash = () => win().location.hash;
/** history.back() 的 popstate 是异步的：等它到（或 300ms 没来）再看结果 */
function settle(): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, 300);
    win().addEventListener("popstate", () => { clearTimeout(t); setTimeout(r, 0); }, { once: true });
  });
}
async function back(act: (f: () => void) => Promise<void>) {
  const p = settle();
  win().history.back();
  await p;
  await act(() => {});
}
async function reset() {
  win().history.replaceState(null, "", "#chat");
}

describe("整屏页历史条目", () => {
  test("窄屏打开压一条；× 收起时消掉自己那条，不留空记录", async () => {
    await reset();
    const { ctl, act, unmount } = await mount();
    const len = win().history.length;
    await act(() => ctl.setSel("team"));
    expect(hash()).toBe("#chat?collab=~team");
    expect(win().history.length).toBe(len + 1);
    const p = settle();
    await act(() => ctl.setSel(null));
    await p;
    expect(hash()).toBe("#chat");
    expect(ctl.sel).toBeNull();
    await unmount();
  });

  test("跳进度式 select(null)（绕过 ×）也消掉条目", async () => {
    await reset();
    const { ctl, act, unmount } = await mount();
    await act(() => ctl.setSel("dnode"));
    expect(hash()).toBe("#chat?collab=~dnode");
    const p = settle();
    await act(() => ctl.setSel(null));
    await p;
    expect(hash()).toBe("#chat");
    await unmount();
  });

  test("切宽屏后点 ×：照样消掉；切宽屏后按返回：层跟着收起，再切窄屏不重压", async () => {
    await reset();
    const a = await mount();
    await a.act(() => a.ctl.setSel("team"));
    await a.act(() => a.ctl.setNarrow(false));
    const p = settle();
    await a.act(() => a.ctl.setSel(null));
    await p;
    expect(hash()).toBe("#chat");
    await a.unmount();

    await reset();
    const b = await mount();
    await b.act(() => b.ctl.setSel("team"));
    await b.act(() => b.ctl.setNarrow(false));
    await back(b.act);
    expect(b.ctl.sel).toBeNull();
    expect(hash()).toBe("#chat");
    await b.act(() => b.ctl.setNarrow(true));
    expect(hash()).toBe("#chat");
    await b.unmount();
  });

  test("团队 → 成员换同一条；成员 × 回团队不退栈；系统返回再收起团队", async () => {
    await reset();
    const { ctl, act, unmount } = await mount();
    await act(() => ctl.setSel("team"));
    const len = win().history.length;
    await act(() => ctl.setSel("member"));
    expect(hash()).toBe("#chat?collab=~member");
    expect(win().history.length).toBe(len);
    await act(() => ctl.setSel("team")); // 成员页的 × = close() → 回团队
    expect(hash()).toBe("#chat?collab=~team");
    expect(win().history.length).toBe(len);
    await back(act);
    expect(ctl.sel).toBeNull();
    expect(hash()).toBe("#chat");
    await unmount();
  });

  test("详情已经 replaceState 接手这条：整屏页收起时不 back", async () => {
    await reset();
    const { ctl, act, unmount } = await mount();
    await act(() => ctl.setSel("waits"));
    win().history.replaceState(win().history.state, "", "#chat?collab=T1"); // 待你处理 → 点任务：详情接手
    await act(() => ctl.setSel(null));
    await new Promise((r) => setTimeout(r, 300));
    expect(hash()).toBe("#chat?collab=T1");
    await unmount();
  });

  test("不在 #chat（桌面 / 列表页）不压历史", async () => {
    win().history.replaceState(null, "", "#list");
    const { ctl, act, unmount } = await mount();
    const len = win().history.length;
    await act(() => ctl.setSel("team"));
    expect(hash()).toBe("#list");
    expect(win().history.length).toBe(len);
    await unmount();
  });
});
