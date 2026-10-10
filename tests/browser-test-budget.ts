import { test } from "bun:test";
import type { BrowserContext } from "playwright-core";
/** Budgeted browser test. bun kills every child process (a shared Chromium too) on its own test timeout, failing all later
 *  tests in ms. So the budget is enforced here: close only the contexts this test opened (the shared browser stays), keep
 *  closing late-created ones until its body settles, then fail with the budget; bun's timeout only backstops that 5s later.
 *  Every exit path (pass, throw, budget) closes this test's leftover contexts, so a failed setup leaks nothing either.
 *  A failed close never stops the others and is never swallowed: it fails a passing test, or rides along a body/budget error. */
function text(error: unknown, named: boolean) {
  try { return error instanceof Error && !named ? error.message : String(error); }
  catch { return "<unprintable error>"; } // Harmless: only the description is lost; the error itself is still thrown or attached.
}
export function budgetedTest(contexts: () => BrowserContext[]) {
  return (name: string, body: () => Promise<void>, timeout: number) => test(name, async () => {
    const before = new Set(contexts()), closeErrors = new Map<BrowserContext, unknown>();
    const closeOwn = async () => {
      const own = contexts().filter(c => !before.has(c)), done = await Promise.allSettled(own.map(c => c.close()));
      done.forEach((r, i) => { if (r.status === "rejected" && !closeErrors.has(own[i])) closeErrors.set(own[i], r.reason); });
    };
    let settled = false, timer: ReturnType<typeof setTimeout> | undefined, failure: { error: unknown } | undefined;
    const run = body().finally(() => { settled = true; }), ran = run.then(() => false);
    ran.catch(() => {}); // A rejection after expiry is reported as the budget failure, not as an unhandled error.
    try {
      if (await Promise.race([ran, new Promise<boolean>(r => { timer = setTimeout(r, timeout, true); })]).finally(() => clearTimeout(timer))) {
        while (!settled) { await closeOwn(); await Bun.sleep(50); }
        await run.catch(() => {}); // Harmless: past the budget the next line throws the budget error, which is the cause to report.
        throw new Error(`browser test exceeded its ${timeout}ms budget; its own pages were closed`);
      }
    } catch (error) { failure = { error }; } finally { await closeOwn(); }
    const cleanup = closeErrors.size ? `${closeErrors.size} browser context close(s) failed during cleanup; first: ${text(closeErrors.values().next().value, true)}` : "";
    if (!failure) { if (cleanup) throw new Error(cleanup); return; }
    if (!cleanup) throw failure.error;
    // A new error rather than editing the original: that one may be frozen or have a read-only message; it rides as `cause`.
    throw new Error(`${text(failure.error, false)}\n(also: ${cleanup})`, { cause: failure.error });
  }, timeout + 5_000);
}
