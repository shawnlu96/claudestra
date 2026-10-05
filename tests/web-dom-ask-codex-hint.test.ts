/**
 * 「待你处理」Codex 卡底部那一行（web/features/asks/components/ask-actions.tsx）：回合失败卡（bridge/acp-link.ts 开卡带 extra.failure = "error"）
 * 不是弹框，不能叫 owner 去终端；真弹框（runtime-dialogs 认出的屏上菜单）照旧提示去终端。
 * 真挂载到 happy-dom 里跑 React 19（guard TESTS_WEB_DOM）；happy-dom 只在本文件注册、afterAll 注销，语言改回 zh。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WebAsk } from "../web/features/asks/asks-model";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface Host { textContent: string | null; remove(): void }
interface Doc { createElement(tag: string): Host; body: { appendChild(c: Host): void } }

const ACTIONS = new URL("../web/features/asks/components/ask-actions.tsx", import.meta.url).href;
const I18N = new URL("../web/lib/i18n.tsx", import.meta.url).href;
const TERMINAL = "这个弹框要到终端里处理";
const FAILURE = "不是弹框，终端里没有要点的";

let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let AskActions: (p: { ask: WebAsk; agent: string }) => unknown;
let setLang: (l: "zh" | "en") => void;
let doc: Doc;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  ({ AskActions } = (await import(ACTIONS)) as { AskActions: typeof AskActions });
  ({ setLang } = (await import(I18N)) as { setLang: typeof setLang });
  doc = (globalThis as unknown as { document: Doc }).document;
});

afterAll(async () => {
  setLang("zh");
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const codexAsk = (title: string, extra: WebAsk["extra"]): WebAsk => ({
  id: "ask-1", fromAgent: "agent-lend-7e813fefb9", project: "p", taskId: null, title, context: "This content was flagged for possible cybersecurity risk", body: "",
  kind: "owner_action", kindHint: null, source: "codex", options: [], allowText: false, blocking: true, urgency: "normal", state: "open",
  answer: null, createdAt: 1, updatedAt: 1, expiresAt: 0, extra,
});

async function textOf(ask: WebAsk): Promise<string> {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  await React.act(async () => root.render(React.createElement(AskActions as never, { ask, agent: "lend-7e813fefb9" })));
  const text = host.textContent ?? "";
  await React.act(async () => root.unmount());
  host.remove();
  return text;
}

test("回合失败卡：不提终端，说明已停、卡只作记录", async () => {
  const text = await textOf(codexAsk("Codex 回合失败", { failure: "error" }));
  expect(text).not.toContain(TERMINAL);
  expect(text).toContain(FAILURE);
  expect(text).toContain("卡只作记录");
});

test("屏上真弹框：照旧提示去终端，不出回合失败说明", async () => {
  const text = await textOf(codexAsk("Codex 停在选择菜单", {}));
  expect(text).toContain(TERMINAL);
  expect(text).not.toContain(FAILURE);
});

test("英文界面：回合失败说明有译文", async () => {
  setLang("en");
  const text = await textOf(codexAsk("Codex 回合失败", { failure: "error" }));
  setLang("zh");
  expect(text).toContain("Not a dialog, nothing to do in the terminal");
  expect(text).not.toContain("handled in the terminal");
});
