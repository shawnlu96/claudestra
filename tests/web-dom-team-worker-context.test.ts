import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createRequire } from "node:module";

const requireWeb = createRequire(new URL("../web/package.json", import.meta.url));
const React = requireWeb("react");
const dom = requireWeb("react-dom/client");
const originalFetch = globalThis.fetch;
let root: { render(v: unknown): void; unmount(): void } | undefined;
afterAll(async () => { root?.unmount(); await Bun.sleep(50); globalThis.fetch = originalFetch; GlobalRegistrator.unregister(); });

test("mounted worker summary displays unknown components and marks actual runtime overflow red", async () => {
  GlobalRegistrator.register();
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
  root!.render(React.createElement(TeamWorkerContext, { agent: "fixture-worker" }));
  for (let i = 0; i < 40 && !container.textContent?.includes("456"); i++) await Bun.sleep(10);
  expect(container.textContent).toContain("系统／工具／记忆／消息：未知");
  expect(container.textContent).toContain("含缓存");
  expect(container.textContent).toContain("456");
  expect(container.querySelector("span")?.getAttribute("data-context-over")).toBe("true");
  expect(container.querySelector('[title*="当前session"]')).not.toBeNull();
});
