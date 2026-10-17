import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
interface El {
  value: string; disabled: boolean; textContent: string | null; click(): void; dispatchEvent(e: unknown): boolean;
  querySelector(s: string): El | null; remove(): void;
}
const require = createRequire(new URL("../web/package.json", import.meta.url));
const dom = () => globalThis as unknown as {
  document: { createElement(s: string): El; body: { appendChild(e: El): void } };
  Event: new (s: string, o: object) => unknown; HTMLTextAreaElement: { prototype: object };
};

describe("real sender against isolated bridge fixtures", () => {
  let React: ReactNS, createRoot: ReactDomClient["createRoot"], CollabSay: unknown;
  let machineStore: typeof import("../web/lib/machines").machines;
  let configure: typeof import("../web/lib/app-config").setAppConfigForTest;
  const savedFetch = globalThis.fetch;
  const fixture = {
    raw: true as unknown, fail: false, thinking: false, mode: "on", posts: [] as { url: string; body: Record<string, unknown> }[],
    projectionStatus: 200, version: "fixture-v1", samples: [] as Record<string, unknown>[],
    hold: null as null | Promise<void>, captured: null as null | (() => void),
  };
  const act = (f: () => unknown) => React.act(async () => { await f(); });
  const tick = () => act(() => new Promise(r => setTimeout(r, 0)));

  beforeAll(async () => {
    GlobalRegistrator.register({ url: "http://fixture/" });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    React = require("react");
    ({ createRoot } = require("react-dom/client"));
    ({ CollabSay } = require("../web/features/collab/collab-say.tsx"));
    ({ machines: machineStore } = require("../web/lib/machines"));
    ({ setAppConfigForTest: configure } = require("../web/lib/app-config"));
    configure({ mode: "direct", fp: "fixture", machineName: "fixture", version: "new" });
    globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown; signal?: AbortSignal }) => {
      const url = String(input);
      if (url.includes("steer-queue-recovery")) return Response.json({ mode: fixture.mode }, { status: fixture.projectionStatus });
      if (url.includes("steer-queue-observation")) {
        fixture.samples.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true, recorded: true });
      }
      if (url.endsWith("/version")) return Response.json({ version: fixture.version });
      if (url.endsWith("/settings")) {
        const raw = fixture.raw, fail = fixture.fail, hold = fixture.hold;
        fixture.captured?.();
        if (hold) await hold;
        return fail ? Response.json({ error: "probe failed" }, { status: 503 }) : Response.json({ "steer.queueWhenBusy": raw });
      }
      if (url.endsWith("/pending")) return Response.json({ thinking: fixture.thinking });
      if (url.includes("/messages")) {
        if (init?.signal?.aborted) throw new Error("aborted fixture send");
        fixture.posts.push({ url, body: JSON.parse(String(init?.body)) });
        return Response.json({ queued: true, threadId: "original-thread" }, { status: 202 });
      }
      return Response.json({}, { status: 404 });
    }) as typeof fetch;
  });
  afterAll(async () => {
    globalThis.fetch = savedFetch;
    configure(null);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    await GlobalRegistrator.unregister();
  });

  async function mount(working: boolean) {
    fixture.posts = []; fixture.hold = null; fixture.captured = null;
    const host = dom().document.createElement("div"); dom().document.body.appendChild(host);
    const root = createRoot(host as never);
    const tr = (s: string, p: Record<string, unknown> = {}) => s.replace(/\{(\w+)\}/g, (_, key) => String(p[key] ?? `{${key}}`));
    await act(() => root.render(React.createElement(CollabSay as never, { agent: "worker", working, tr } as never)));
    await tick();
    const input = host.querySelector("textarea")!;
    await act(() => {
      Object.getOwnPropertyDescriptor(dom().HTMLTextAreaElement.prototype, "value")!.set!.call(input, "draft");
      input.dispatchEvent(new (dom().Event)("input", { bubbles: true }));
    });
    return { host, input, button: host.querySelector("button")!, close: async () => { await act(() => root.unmount()); host.remove(); } };
  }

  test("busy legacy/malformed/failed bridges emit zero POSTs, idle targets remain usable", async () => {
    fixture.mode = "on";
    for (const raw of [false, undefined, null, "true", "false", 1, {}, []]) {
      fixture.raw = raw; fixture.fail = false; fixture.thinking = true;
      const busy = await mount(true);
      expect(busy.button.disabled).toBe(true);
      await act(() => busy.button.click());
      expect(fixture.posts).toHaveLength(0);
      await busy.close();
      fixture.thinking = false;
      const idle = await mount(false);
      expect(idle.button.disabled).toBe(false);
      await act(() => idle.button.click());
      expect(fixture.posts).toHaveLength(1);
      expect(fixture.posts[0]!.body.waitForIdle).toBe(false);
      await idle.close();
    }
    fixture.fail = true; fixture.thinking = false;
    const idle = await mount(false);
    expect(idle.button.disabled).toBe(false);
    await act(() => idle.button.click());
    expect(fixture.posts).toHaveLength(1);
    await idle.close(); fixture.fail = false;
  });

  test("a click rechecks a previously true capability and never preempts when it disappears or fails", async () => {
    fixture.mode = "on"; fixture.thinking = true;
    for (const failed of [false, true]) {
      fixture.raw = true; fixture.fail = false;
      const v = await mount(true);
      expect(v.button.disabled).toBe(false);
      fixture.raw = undefined; fixture.fail = failed;
      await act(() => v.button.click());
      expect(fixture.posts).toHaveLength(0);
      expect(v.input.value).toBe("draft");
      await v.close();
    }
    fixture.fail = false;
  });

  test("new true keeps the compact queued 202 receipt", async () => {
    fixture.raw = true; fixture.fail = false; fixture.mode = "on"; fixture.thinking = true;
    const v = await mount(true);
    await act(() => v.button.click());
    expect(fixture.posts).toHaveLength(1);
    expect(fixture.posts[0]!.body).toMatchObject({ waitForIdle: true, wait: 0 });
    expect(v.host.textContent).toContain("排队中");
    await v.close();
  });

  test("off/observe reproduce old parsing and upstream false still blocks in every mode", async () => {
    fixture.thinking = true;
    for (const mode of ["on", "observe", "off"]) {
      fixture.mode = mode; fixture.raw = false;
      const disabled = await mount(true);
      expect(disabled.button.disabled).toBe(true);
      await disabled.close();
      fixture.raw = undefined;
      const v = await mount(true);
      expect(v.button.disabled).toBe(mode === "on");
      await act(() => v.button.click());
      expect(fixture.posts).toHaveLength(mode === "on" ? 0 : 1);
      if (mode !== "on") expect(fixture.posts[0]!.body.waitForIdle).toBe(true);
      await v.close();
    }
    fixture.mode = "off"; fixture.projectionStatus = 404;
    const absent = await mount(true);
    expect(absent.button.disabled).toBe(true);
    await absent.close(); fixture.projectionStatus = 200;
  });

  test("the mode is reread after a pending capability response, without a reload", async () => {
    for (const nextMode of ["on", "off"]) {
      fixture.raw = true; fixture.mode = nextMode === "on" ? "off" : "on"; fixture.thinking = true;
      const v = await mount(true);
      fixture.raw = undefined;
      let release!: () => void;
      fixture.hold = new Promise<void>(r => { release = r; });
      const captured = new Promise<void>(r => { fixture.captured = r; });
      await act(() => v.button.click()); await captured;
      await act(() => {
        fixture.mode = nextMode; fixture.hold = null; fixture.captured = null; release();
      });
      await tick();
      expect(fixture.posts).toHaveLength(nextMode === "on" ? 0 : 1);
      await v.close();
    }
  });

  test("observe logs an opaque target/version sample once and preserves failed-probe baseline behavior", async () => {
    fixture.version = "observation-version"; fixture.samples = []; fixture.mode = "observe"; fixture.raw = undefined; fixture.fail = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const v = await mount(true);
      await act(() => v.button.click());
      expect(fixture.posts).toHaveLength(1);
      await tick(); await v.close();
    }
    expect(fixture.samples).toHaveLength(1);
    expect(fixture.samples[0]).toEqual({ target: expect.stringMatching(/^[a-f0-9]{24}$/),
      version: expect.stringMatching(/^[a-f0-9]{24}$/), capability: "missing" });
    fixture.raw = true; fixture.fail = false;
    const v = await mount(true);
    fixture.fail = true;
    await act(() => v.button.click());
    expect(fixture.posts).toHaveLength(0);
    expect(v.host.textContent).toContain("probe failed");
    await v.close(); fixture.fail = false;
  });

  test("a machine switch while reading capability cancels the clicked send, including A→B→A", async () => {
    configure({ mode: "relay", relayBase: "fixture", version: "new" });
    await machineStore.add({ fp: "a", name: "a" });
    await machineStore.add({ fp: "b", name: "b" });
    await machineStore.setCurrent("a");
    fixture.raw = true; fixture.fail = false; fixture.mode = "on";
    const v = await mount(true);
    let release!: () => void;
    fixture.hold = new Promise<void>(r => { release = r; });
    const captured = new Promise<void>(r => { fixture.captured = r; });
    await act(() => v.button.click());
    await captured;
    await act(async () => {
      await machineStore.setCurrent("b"); await machineStore.setCurrent("a");
      fixture.hold = null; fixture.captured = null; release();
    });
    await tick();
    expect(fixture.posts).toHaveLength(0);
    await v.close();
    await machineStore.setCurrent(null);
    configure({ mode: "direct", fp: "fixture", machineName: "fixture", version: "new" });
  });

  test("switching from an enabled new bridge to a legacy bridge refreshes the button and never targets it", async () => {
    configure({ mode: "relay", relayBase: "fixture", version: "new" });
    await machineStore.add({ fp: "a", name: "a" }); await machineStore.add({ fp: "b", name: "b" });
    await machineStore.setCurrent("a");
    fixture.raw = true; fixture.fail = false; fixture.mode = "on"; fixture.thinking = true;
    const v = await mount(true);
    try {
      expect(v.button.disabled).toBe(false);
      fixture.raw = undefined;
      await act(() => machineStore.setCurrent("b")); await tick();
      expect(v.button.disabled).toBe(true);
      await act(() => v.button.click());
      expect(fixture.posts).toHaveLength(0);
      fixture.raw = true;
      await act(() => machineStore.setCurrent("a")); await tick();
      expect(v.button.disabled).toBe(false);
      await act(() => v.button.click());
      expect(fixture.posts).toHaveLength(1);
      expect(fixture.posts[0]!.url).toContain("/m/a/");
    } finally {
      await v.close(); await machineStore.setCurrent(null);
      configure({ mode: "direct", fp: "fixture", machineName: "fixture", version: "new" });
    }
  });
});
