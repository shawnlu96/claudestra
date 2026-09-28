/**
 * web/lib/error-boundary.ts：抛错的组件被兜住，只换掉它自己；resetKey / reset 能恢复。另测「清除本地缓存」只清该清的。
 * 真挂载到 happy-dom 里跑 React 19 客户端渲染（服务端渲染不走错误兜底）。happy-dom 只在本文件注册、afterAll 注销，
 * bun test 所有文件共用一个进程，全局 window / document 不能漏到别的测试里。
 * React 在 web/node_modules：根目录解析不到，按真实路径动态加载（类型取 web 的 @types），再把它的 Component 交给 createErrorBoundary。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createErrorBoundary } from "@/lib/error-boundary";
import { clearLocalCaches, KEEP_ON_RESET, type ResettableStorage } from "@/lib/crash-reset";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
interface El {
  textContent: string | null;
  appendChild(c: El): void;
  remove(): void;
}
interface Doc {
  createElement(tag: string): El;
  body: El;
}

const WEB_NM = realpathSync(new URL("../web/node_modules", import.meta.url).pathname);
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let ErrorBoundary: ReturnType<typeof createErrorBoundary>;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const reactPath = `${WEB_NM}/react/index.js`;
  const clientPath = `${WEB_NM}/react-dom/client.js`;
  React = (await import(reactPath)) as ReactNS;
  ({ createRoot } = (await import(clientPath)) as ReactDomClient);
  ErrorBoundary = createErrorBoundary(React.Component);
  doc = (globalThis as unknown as { document: Doc }).document;
});

afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

/** 挂载一棵树，返回容器文本与卸载函数。onCaughtError 静音：被兜住的错 React 默认还会 console.error 一遍 */
async function mount(node: ReturnType<ReactNS["createElement"]>) {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never, { onCaughtError: () => {} });
  await React.act(async () => root.render(node));
  return {
    text: () => host.textContent ?? "",
    rerender: (n: typeof node) => React.act(async () => root.render(n)),
    unmount: async () => {
      await React.act(async () => root.unmount());
      host.remove();
    },
  };
}

function Thrower({ label, broken }: { label: string; broken: boolean }): ReturnType<ReactNS["createElement"]> {
  if (broken) throw new Error(`坏消息 ${label}`);
  return React.createElement("span", null, `[${label}]`);
}

describe("ErrorBoundary", () => {
  test("抛错的组件被兜住：显示 fallback，onError 拿到错误与组件栈，兜底层外面的兄弟照常渲染", async () => {
    const caught: { msg: string; stack: string }[] = [];
    const h = React.createElement;
    const tree = h("div", null, [
      h("b", { key: "a" }, "外面"),
      h(ErrorBoundary, {
        key: "b",
        fallback: (e: Error) => h("i", null, `兜住了：${e.message}`),
        onError: (e: Error, stack: string) => caught.push({ msg: e.message, stack }),
        children: h(Thrower, { label: "x", broken: true }),
      }),
    ]);
    const m = await mount(tree);
    expect(m.text()).toBe("外面兜住了：坏消息 x");
    expect(caught.length).toBe(1);
    expect(caught[0].msg).toBe("坏消息 x");
    expect(caught[0].stack).toContain("Thrower");
    await m.unmount();
  });

  test("一条坏消息只换掉自己（气泡层的用法）：列表里其余消息照常", async () => {
    const h = React.createElement;
    const list = (bad: string) =>
      h("div", null, ["a", "b", "c"].map((id) =>
        h(ErrorBoundary, { key: id, resetKey: id, fallback: () => h("em", null, "（显示不了）"), children: h(Thrower, { label: id, broken: id === bad }) }),
      ));
    const m = await mount(list("b"));
    expect(m.text()).toBe("[a]（显示不了）[c]");
    await m.unmount();
  });

  test("resetKey 变了自动重试；fallback 里的 reset 也能恢复", async () => {
    const h = React.createElement;
    const view = (key: number, broken: boolean) =>
      h(ErrorBoundary, {
        resetKey: key,
        fallback: (_e: Error, reset: () => void) => h("button", { onClick: reset }, "重试"),
        children: h(Thrower, { label: `v${key}`, broken }),
      });
    const m = await mount(view(1, true));
    expect(m.text()).toBe("重试");
    // 同一个 key、组件已经不坏了：不会自己恢复（等用户点或 key 变）
    await m.rerender(view(1, false));
    expect(m.text()).toBe("重试");
    // key 变了（切会话 / 消息内容更新）→ 自动清掉错误重渲
    await m.rerender(view(2, false));
    expect(m.text()).toBe("[v2]");
    await m.unmount();
  });

  test("非 Error 的抛出物也包成 Error 交给 fallback", async () => {
    const h = React.createElement;
    function ThrowString(): never {
      throw "纯字符串";
    }
    const m = await mount(h(ErrorBoundary, { fallback: (e: Error) => h("i", null, e.message), children: h(ThrowString) }));
    expect(m.text()).toBe("纯字符串");
    await m.unmount();
  });
});

describe("clearLocalCaches（根层兜底的「清除本地缓存并重载」）", () => {
  const fake = (keys: string[]): ResettableStorage & { keys: string[] } => {
    const s = {
      keys: [...keys],
      get length() {
        return s.keys.length;
      },
      key: (i: number) => s.keys[i] ?? null,
      removeItem: (k: string) => void (s.keys = s.keys.filter((x) => x !== k)),
    };
    return s;
  };

  test("草稿 / 偏好 / 缓存全清，只留 API 基址镜像、主题、语言", () => {
    const local = fake(["cstra_draft_a", "cstra_chat_prefs_css", "cstra_api_base", "cstra_theme", "cstra_lang", "cstra_pinned"]);
    const session = fake(["cstra_term_restore"]);
    expect(clearLocalCaches([local, session])).toBe(4);
    expect(local.keys.sort()).toEqual([...KEEP_ON_RESET].sort());
    expect(session.keys).toEqual([]);
  });

  test("存储不可用（null / 访问即抛）就跳过那一份，不影响另一份", () => {
    const broken: ResettableStorage = {
      get length(): number {
        throw new Error("SecurityError");
      },
      key: () => null,
      removeItem: () => {},
    };
    const ok = fake(["cstra_draft_x"]);
    expect(clearLocalCaches([null, broken, ok])).toBe(1);
    expect(ok.keys).toEqual([]);
  });
});
