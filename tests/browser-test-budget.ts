import { test } from "bun:test";
import type { BrowserContext } from "playwright-core";
/** Budgeted browser test. bun kills every child process (a shared Chromium too) on its own test timeout, failing all later
 *  tests in ms. So the budget is enforced here: close only the contexts this test opened (the shared browser stays), let
 *  its body settle, then fail with the budget; bun's timeout only backstops that cleanup 5s later. */
export function budgetedTest(contexts: () => BrowserContext[]) {
  return (name: string, body: () => Promise<void>, timeout: number) => test(name, async () => {
    const before = new Set(contexts()), run = body();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = await Promise.race([run.then(() => false), new Promise<boolean>(r => { timer = setTimeout(r, timeout, true); })])
      .finally(() => clearTimeout(timer));
    if (!expired) return;
    await Promise.all(contexts().filter(c => !before.has(c)).map(c => c.close())); await run.catch(() => {});
    throw new Error(`browser test exceeded its ${timeout}ms budget; its own pages were closed`);
  }, timeout + 5_000);
}
