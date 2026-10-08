/** Fault injection for budgetedTest: each case runs a fixture test in a child `bun test`, since the outcome under test is
 *  that child's own pass/fail. Fake contexts stand in for Playwright; the injected one rejects close() and stays open. */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "cstra-test-budget-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const budget = resolve(process.env.BROWSER_TEST_BUDGET_MODULE ?? join(import.meta.dir, "browser-test-budget.ts"));
async function fixture(name: string, body: string, timeout = 2_000) {
  const file = join(dir, `${name}.test.ts`);
  writeFileSync(file, `import { afterAll } from "bun:test";
import { budgetedTest } from ${JSON.stringify(budget)};
const open = new Set<{ injected: boolean; close(): Promise<void> }>();
const ctx = (injected: boolean) => { const c = { injected, close: async () => {
  if (injected) throw new Error("closeRejected"); open.delete(c); } }; open.add(c); };
const t = budgetedTest(() => [...open] as never);
t("case", async () => { ctx(false); ctx(true); ctx(false); ${body} }, ${timeout});
afterAll(() => console.log(\`contextsLeft=\${open.size} othersLeft=\${[...open].filter(c => !c.injected).length}\`));
`);
  const p = Bun.spawn([process.execPath, "test", file], { stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "" } });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  return { code: await p.exited, out, pass: Number(/(\d+) pass/.exec(out)?.[1]), fail: Number(/(\d+) fail/.exec(out)?.[1]) };
}
const timeout = 30_000;
test("budgetedTest: passing body + rejected close fails the test, other contexts still closed", async () => {
  const r = await fixture("pass-close-rejected", "");
  expect([r.code, r.pass, r.fail], r.out).toEqual([1, 0, 1]);
  expect(r.out).toContain("1 browser context close(s) failed during cleanup; first: Error: closeRejected");
  expect(r.out).toContain("othersLeft=0");
}, timeout);
test("budgetedTest: body error + rejected close reports the body error with cleanup attached", async () => {
  const r = await fixture("throw-close-rejected", `throw new Error("bodyBoom");`);
  expect([r.code, r.pass, r.fail], r.out).toEqual([1, 0, 1]);
  expect(r.out).toMatch(/error: bodyBoom\n\(also: 1 browser context close\(s\) failed during cleanup; first: Error: closeRejected\)/);
  expect(r.out).toContain("othersLeft=0");
}, timeout);
test("budgetedTest: budget overrun + rejected close reports the budget error with cleanup attached", async () => {
  const r = await fixture("budget-close-rejected", "await Bun.sleep(600);", 200);
  expect([r.code, r.pass, r.fail], r.out).toEqual([1, 0, 1]);
  expect(r.out).toMatch(/error: browser test exceeded its 200ms budget; its own pages were closed\n\(also: 1 browser context close\(s\) failed during cleanup; first: Error: closeRejected\)/);
  expect(r.out).toContain("othersLeft=0");
}, timeout);
