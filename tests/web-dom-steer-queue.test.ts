/** Real CollabSay, settings hook, and sendMessage transport; all network IO is fixture-only. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const requireWeb = createRequire(new URL("../web/package.json", import.meta.url));
interface El {
  value: string; checked: boolean; disabled: boolean; textContent: string | null; click(): void; dispatchEvent(e: unknown): boolean;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; remove(): void;
}
const state = { enabled: true, queued: true, fail: false, hold: false, pending: 0, posts: [] as { body: unknown }[], release: null as null | (() => void) };
let React: ReactNS, createRoot: ReactDomClient["createRoot"], CollabSay: unknown, SteerQueueSection: unknown;
let sendMessage: (a: string, text: string, files: File[] | undefined, signal: AbortSignal, options?: { waitForIdle?: boolean }) => Promise<unknown>;
const originalFetch = globalThis.fetch;
const dom = () => globalThis as unknown as {
  document: { createElement(s: string): El; body: { appendChild(e: El): void } };
  Event: new (s: string, o: object) => unknown;
  HTMLTextAreaElement: { prototype: object };
};
const h = (...args: unknown[]) => (React.createElement as (...a: unknown[]) => unknown)(...args);
const act = (f: () => unknown) => React.act(async () => { await f(); });
const tick = () => act(() => new Promise(r => setTimeout(r, 0)));

async function fakeFetch(input: unknown, init?: { method?: string; body?: unknown }) {
  const url = new URL(String(input), "http://fixture");
  if (url.pathname.endsWith("/settings")) {
    if (init?.method === "PUT") state.enabled = JSON.parse(String(init.body))["steer.queueWhenBusy"];
    return Response.json({ "steer.queueWhenBusy": state.enabled });
  }
  if (url.pathname.endsWith("/pending")) { state.pending++; return Response.json({ thinking: true }); }
  if (url.pathname.endsWith("/messages")) {
    const body = init?.body instanceof FormData ? init.body : JSON.parse(String(init?.body));
    state.posts.push({ body });
    if (state.hold) await new Promise<void>(r => { state.release = r; });
    return state.fail ? Response.json({ error: "fixture failed" }, { status: 500 }) : Response.json({ queued: state.queued });
  }
  return Response.json({ error: "unexpected fixture request" }, { status: 404 });
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://fixture/" });
  globalThis.fetch = fakeFetch as typeof fetch;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = requireWeb("react") as ReactNS;
  ({ createRoot } = requireWeb("react-dom/client") as ReactDomClient);
  ({ CollabSay } = await import(new URL("../web/features/collab/collab-say.tsx", import.meta.url).href));
  ({ SteerQueueSection } = await import(new URL("../web/features/chat/components/settings/steer-queue-section.tsx", import.meta.url).href));
  ({ sendMessage } = await import(new URL("../web/lib/api/chat.ts", import.meta.url).href));
});
afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
  globalThis.fetch = originalFetch;
});

async function mount(settings = false) {
  state.pending = 0; state.posts = []; state.fail = false; state.hold = false;
  const host = dom().document.createElement("div"); dom().document.body.appendChild(host);
  const root = createRoot(host as never);
  await act(() => root.render(h(React.Fragment, null,
    h(CollabSay, { agent: "calm", working: true,
      tr: (s: string, p: Record<string, unknown> = {}) => s.replace(/\{(\w+)\}/g, (_, key) => String(p[key] ?? `{${key}}`)) }),
    settings ? h(SteerQueueSection) : null) as never));
  await tick();
  const input = host.querySelector("textarea")!;
  const type = async (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(dom().HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new (dom().Event)("input", { bubbles: true }));
  });
  return { host, input, type, button: () => host.querySelector("button")!, unmount: async () => { await act(() => root.unmount()); host.remove(); } };
}

test("[验收线 5] busy send uses waitForIdle=true, skips pending, prevents rapid duplicate clicks, reports queued", async () => {
  state.enabled = true; state.queued = true;
  const v = await mount();
  try {
    await v.type("keep going");
    expect(v.button().disabled).toBe(false);
    state.hold = true;
    await act(() => { v.button().click(); v.button().click(); });
    expect(state.posts).toHaveLength(1);
    expect(state.posts[0].body).toMatchObject({ text: "keep going", wait: 0, waitForIdle: true });
    expect(state.pending).toBe(0);
    await act(() => state.release!());
    expect(v.host.textContent).toContain("排队中");
    expect(v.host.textContent).not.toContain("已送达");
    expect(v.input.value).toBe("");
  } finally { await v.unmount(); }
});

test("[验收线 5] a failed submission retains the draft and reports the error", async () => {
  state.enabled = true;
  const v = await mount();
  try {
    await v.type("keep my draft"); state.fail = true;
    await act(() => v.button().click());
    expect(v.input.value).toBe("keep my draft");
    expect(v.host.textContent).toContain("fixture failed");
    expect(v.host.textContent).not.toContain("已送达");
  } finally { await v.unmount(); }
});

test("[验收线 6] settings rollback immediately restores busy gating for an already mounted sender", async () => {
  state.enabled = true;
  const v = await mount(true);
  try {
    await v.type("later");
    expect(v.button().disabled).toBe(false);
    await act(() => v.host.querySelector('input[type="checkbox"]')!.click());
    expect(state.enabled).toBe(false);
    expect(v.button().disabled).toBe(true);
    expect(state.posts).toHaveLength(0);
    await act(() => v.host.querySelector('input[type="checkbox"]')!.click());
    expect(v.button().disabled).toBe(false);
  } finally { await v.unmount(); }
});

test("[验收线 6] a rollback on another device is rechecked before sending and performs the legacy live pending gate", async () => {
  state.enabled = true;
  const v = await mount();
  try {
    await v.type("later"); state.enabled = false;
    await act(() => v.button().click());
    expect(state.pending).toBe(1);
    expect(state.posts).toHaveLength(0);
    expect(v.input.value).toBe("later");
  } finally { await v.unmount(); }
});

test("[验收线 2] sendMessage only adds the optional contract when requested, for JSON and multipart", async () => {
  state.posts = []; state.hold = false; state.fail = false;
  const signal = new AbortController().signal;
  await sendMessage("calm", "ordinary", undefined, signal);
  expect(state.posts[0].body).toEqual({ text: "ordinary", wait: 0 });
  await sendMessage("calm", "calm", undefined, signal, { waitForIdle: true });
  expect(state.posts[1].body).toMatchObject({ waitForIdle: true });
  await sendMessage("calm", "attached", [new File(["attachment"], "calm.txt")], signal, { waitForIdle: true });
  expect((state.posts[2].body as FormData).get("waitForIdle")).toBe("true");
  expect((state.posts[2].body as FormData).get("wait")).toBe("0");
});
