/** The effective borrow list (valid lend.json entries whose peer is still the paired instance), read fresh on every call. */
import { readLend, type BorrowEntry } from "./lend-config.js";
import { effectiveLend, readLendContext } from "./lend-policy.js";

export async function readEffectiveBorrow(): Promise<BorrowEntry[]> {
  const [read, ctx] = await Promise.all([readLend(), readLendContext()]);
  return effectiveLend(read, ctx.contacts, ctx.projects).borrow;
}
