/** Render the actual rows in a child process so React/CSS loading does not leak into the root test suite. */
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { testChildEnv } from "./test-env";

function render(state: string, startedAt: number | null, reason: string | null = null): string {
  const script = `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { LentOrders } from './features/lend/lent-orders.tsx';
    const order = ${JSON.stringify({ orderId: "o", peer: "peer", family: "codex", state, startedAt, reason,
      agent: "agent-lend-test", repo: "o/r", pr: null, taskId: "T1", step: "write", updatedAt: 1, notices: { start: 1 }, live: false })};
    console.log(renderToStaticMarkup(createElement(LentOrders, { orders: [order], stopping: new Map(), now: 2, onOpen: () => {} })));
  `;
  const p = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], { cwd: resolve(import.meta.dir, "../web"), env: testChildEnv(), stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(0);
  return p.stdout.toString();
}

test("released placeholder with pre-start notice has no session button; visible reason is 60 Unicode characters", () => {
  const reason = "错🙂".repeat(35);
  const html = render("released", null, reason);
  expect(html).not.toContain("<button");
  expect(html).toContain("没起来");
  const visible = html.replace(/<[^>]*>/g, "");
  expect(visible).toContain("错🙂".repeat(30));
  expect(visible).not.toContain("错🙂".repeat(31));
});

test("released without reason stays noninteractive; started workers retain session links", () => {
  expect(render("released", null)).not.toContain("<button");
  for (const state of ["stopped", "acked", "cancelled", "released"]) expect(render(state, 0)).toContain("<button");
});
