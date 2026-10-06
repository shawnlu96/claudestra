import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createRequire } from "node:module";

const requireWeb = createRequire(new URL("../web/package.json", import.meta.url));
const React = requireWeb("react");
const dom = requireWeb("react-dom/client");
let originalFetch: typeof fetch | undefined;
let previousAct: boolean | undefined;
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: { render(v: unknown): void; unmount(): void } | undefined;
afterAll(async () => {
  await React.act(async () => root?.unmount());
  if (originalFetch) globalThis.fetch = originalFetch;
  if (previousAct === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  else actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousAct;
  await GlobalRegistrator.unregister();
});

test("mounted worker summary displays unknown components and marks actual runtime overflow red", async () => {
  GlobalRegistrator.register();
  previousAct = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  originalFetch = globalThis.fetch;
  const doc = (globalThis as unknown as { document: {
    createElement(tag: string): { textContent: string | null; querySelector(s: string): { getAttribute(n: string): string | null } | null };
    body: { appendChild(el: unknown): void };
  } }).document;
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  globalThis.fetch = (async () => new Response(JSON.stringify({ known: true, sessionId: "fixture",
    used: 200_001, size: 200_000, remaining: -1, today: 456, overRuntime: true,
  }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const path = "../web/features/collab/team-worker-context.tsx";
  const { TeamWorkerContext } = await import(path);
  root = dom.createRoot(container);
  await React.act(async () => root!.render(React.createElement(TeamWorkerContext, { agent: "fixture-worker" })));
  for (let i = 0; i < 40 && !container.textContent?.includes("456"); i++) await React.act(async () => Bun.sleep(10));
  expect(container.textContent).toContain("系统／工具／记忆／消息：未知");
  expect(container.textContent).toContain("含缓存");
  expect(container.textContent).toContain("456");
  expect(container.querySelector("span")?.getAttribute("data-context-over")).toBe("true");
  expect(container.querySelector('[title*="当前session"]')).not.toBeNull();
});
