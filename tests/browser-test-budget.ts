import { test } from "bun:test";
import type { BrowserContext } from "playwright-core";
/** Budgeted browser test. bun kills every child process (a shared Chromium too) on its own test timeout, failing all later
 *  tests in ms. So the budget is enforced here: close only the contexts this test opened (the shared browser stays), keep
 *  closing late-created ones until its body settles, then fail with the budget; bun's timeout only backstops that 5s later.
 *  Every exit path (pass, throw, budget) closes this test's leftover contexts, so a failed setup leaks nothing either. */
export function budgetedTest(contexts: () => BrowserContext[]) {
  return (name: string, body: () => Promise<void>, timeout: number) => test(name, async () => {
    const before = new Set(contexts());
    const closeOwn = () => Promise.all(contexts().filter(c => !before.has(c)).map(c => c.close().catch(() => {})));
    let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const run = body().finally(() => { settled = true; }), ran = run.then(() => false);
    ran.catch(() => {}); // A rejection after expiry is reported as the budget failure, not as an unhandled error.
    try {
      if (!await Promise.race([ran, new Promise<boolean>(r => { timer = setTimeout(r, timeout, true); })]).finally(() => clearTimeout(timer))) return;
      while (!settled) { await closeOwn(); await Bun.sleep(50); }
      await run.catch(() => {});
      throw new Error(`browser test exceeded its ${timeout}ms budget; its own pages were closed`);
    } finally { await closeOwn(); }
  }, timeout + 5_000);
}
