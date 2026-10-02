/**
 * i28-X11 ApprovalPanel lifecycle: a result belongs to the ask / bind it was submitted for. Mounted in happy-dom with
 * React 19 (guard TESTS_WEB_DOM: tests/web-dom-*.test.ts may import web modules that use react). happy-dom is
 * registered only in this file and unregistered in afterAll, since all bun test files share one process.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ApprovalPanelProps, ApprovalResult, ApprovalView } from "../web/features/collab/shared/approve/approve-model";
import {
  approveFixtureMergeView, approveFixtureNames, approveFixtureNow, approveFixtureOwner, approveFixtureScope,
  approveFixtureScopeView,
} from "../web/features/collab/shared/approve/approve-fixture";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface Node { textContent: string | null; querySelector(s: string): Node | null; querySelectorAll(s: string): ArrayLike<Node> }
interface Host extends Node { remove(): void }
interface Doc { createElement(tag: string): Host; body: { appendChild(c: Host): void } }

// Root tsc has no --jsx, so the .tsx panel is loaded at runtime (bun transpiles it); its props type lives in the model.
const PANEL = new URL("../web/features/collab/shared/approve/approve-panel.tsx", import.meta.url).href;
let ApprovalPanel: (props: ApprovalPanelProps) => ReturnType<ReactNS["createElement"]>;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;

beforeAll(async () => {
  GlobalRegistrator.register();
  ({ ApprovalPanel } = await import(PANEL) as { ApprovalPanel: typeof ApprovalPanel });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
});

afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

/** Each submit returns a held promise; resolve(i, result) finishes the i-th call later. */
function heldSubmit() {
  const pending: ((r: ApprovalResult) => void)[] = [];
  const submit = () => new Promise<ApprovalResult>(resolve => { pending.push(resolve); });
  return { submit, pending, resolve: (i: number, r: ApprovalResult) => React.act(async () => pending[i]!(r)) };
}

async function mount(view: ApprovalView, submit: ApprovalPanelProps["submit"]) {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  const props = (v: ApprovalView): ApprovalPanelProps => ({ view: v, viewer: approveFixtureOwner, scope: approveFixtureScope,
    now: approveFixtureNow, instanceNames: approveFixtureNames, submit, onClose: () => {} });
  const render = (v: ApprovalView) => React.act(async () => root.render(React.createElement(ApprovalPanel, props(v))));
  await render(view);
  const buttons = () => Array.from(host.querySelectorAll("button")) as unknown as { textContent: string; disabled: boolean; click(): void }[];
  const approve = () => buttons().find(b => b.textContent.includes("批准"))!;
  return {
    render, approve,
    click: () => React.act(async () => { approve().click(); await new Promise(r => setTimeout(r, 0)); }),
    success: () => host.querySelector('[aria-label="已批准"]') !== null || host.querySelector('[aria-label="已驳回"]') !== null,
    text: () => host.textContent ?? "",
    unmount: async () => { await React.act(async () => root.unmount()); host.remove(); },
  };
}

const cancelledB: ApprovalView = { ...approveFixtureScopeView,
  ask: { ...approveFixtureScopeView.ask, id: "ask-b", title: "NEW ASK B", state: "cancelled" } };

test("pending approval for ask A resolving after the panel switched to ask B never shows success under B", async () => {
  const held = heldSubmit();
  const ui = await mount(approveFixtureScopeView, held.submit);
  await ui.click();
  expect(held.pending.length).toBe(1);
  await ui.render(cancelledB);
  await held.resolve(0, { ok: true });
  expect(ui.text()).toContain("NEW ASK B");
  expect(ui.text()).toContain("已撤销");
  expect(ui.success()).toBe(false);
  expect(ui.approve().disabled).toBe(true);
  await ui.unmount();
});

test("an already-saved approval for A does not carry over to a fresh open B, which stays signable", async () => {
  const held = heldSubmit();
  const ui = await mount(approveFixtureScopeView, held.submit);
  await ui.click();
  await held.resolve(0, { ok: true });
  expect(ui.success()).toBe(true);
  await ui.render(approveFixtureMergeView);
  expect(ui.text()).toContain("合成合并授权");
  expect(ui.success()).toBe(false);
  expect(ui.approve().disabled).toBe(false);
  // B is refused by the center while A's earlier record is gone: failure is shown, not success.
  await ui.click();
  await held.resolve(1, { ok: false, code: "authorization_mismatch" });
  expect(ui.success()).toBe(false);
  expect(ui.text()).toContain("绑定内容不一致");
  await ui.unmount();
});

test("a late completion for A does not settle B's own pending submission", async () => {
  const held = heldSubmit();
  const ui = await mount(approveFixtureScopeView, held.submit);
  await ui.click();
  await ui.render(approveFixtureMergeView);
  await ui.click();
  expect(held.pending.length).toBe(2);
  await held.resolve(0, { ok: true });
  expect(ui.success()).toBe(false);
  expect(ui.approve().disabled).toBe(true);
  await held.resolve(1, { ok: false, code: "conflict" });
  expect(ui.success()).toBe(false);
  expect(ui.text()).toContain("版本已变化");
  await ui.unmount();
});

test("a rebind of the same ask (base version moved) drops the earlier result", async () => {
  const held = heldSubmit();
  const ui = await mount(approveFixtureScopeView, held.submit);
  await ui.click();
  const rebound: ApprovalView = { ...approveFixtureScopeView, ask: { ...approveFixtureScopeView.ask, rev: 2 } };
  await ui.render(rebound);
  await held.resolve(0, { ok: true });
  expect(ui.success()).toBe(false);
  expect(ui.approve().disabled).toBe(false);
  await ui.unmount();
});
