/**
 * merge-arch-CARRYCNT1 · post-merge verify of a `carryKind: "count"` review_carry (review-main-carry-manual-verify.ts checkCarry
 * hands it here). Re-checked from git, read only: full SHAs; `to` has the single parent `from`; the raw diff is the inventory's one
 * 100644 record with the recorded blobs; both blobs read as raw bytes (object id recomputed, strict UTF-8) differ only in existing
 * entries' counts (countOnlyChanges), every new value COUNT_VALUE. The scan is not re-run: the scanner may change later and the values
 * were judged by H1's CI; the strict format is what keeps code out. Anything it cannot check is a problem, never a fix.
 * tests/review-count-carry-verify.test.ts.
 */
import { createHash } from "node:crypto";
import type { LedgerEvent } from "./ledger-stages.js";
import { scopeBytesIn, type ScopeRunBytes } from "./order-deliver-scope-git.js";
import { badCountValues, rawInventoryChange } from "./review-count-carry-proof.js";
import type { VerifyPorts } from "./review-main-carry-manual-verify.js";
import { countOnlyChanges } from "./skip-effects-auto-scope-scan.js";

const SHA = /^[a-f0-9]{40}$/;
const BLOB_MAX = 512 * 1024;

/** The blob's bytes as UTF-8 text, only when they hash to its id. */
async function blobText(bytes: ScopeRunBytes, oid: string): Promise<string> {
  const raw = await bytes("git", ["--no-replace-objects", "cat-file", "blob", oid], BLOB_MAX);
  const id = createHash("sha1").update(`blob ${raw.length}\0`).update(raw).digest("hex");
  if (id !== oid) throw new Error(`blob ${oid.slice(0, 12)} 的字节与对象 id 不一致`);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
}

/** Pushes every problem of one count carry; `bytes` defaults to a raw reader in the ports' repoDir. */
export async function checkCountCarry(c: LedgerEvent, ports: VerifyPorts, problems: string[],
  bytes: ScopeRunBytes = scopeBytesIn(ports.repoDir)): Promise<void> {
  const { from, to, blobFrom, blobTo } = c.data as Record<string, unknown>;
  const label = `计数沿用 #${c.seq}（${String(from).slice(0, 12)} → ${String(to).slice(0, 12)}）`;
  if (![from, to, blobFrom, blobTo].every((v) => typeof v === "string" && SHA.test(v))) {
    problems.push(`${label} 缺 from / to / blobFrom / blobTo，核不了`);
    return;
  }
  try {
    const parents = await ports.git(["--no-replace-objects", "rev-list", "--parents", "-n", "1", to as string]);
    if (parents.code !== 0 || parents.stdout.trim().toLowerCase() !== `${to} ${from}`) { problems.push(`${label} 新 head 不是只接在原 head 上的单父提交`); return; }
    const raw = await ports.git(["--no-replace-objects", "diff", "--raw", "-z", "--no-abbrev", "--no-renames", from as string, to as string]);
    const change = raw.code === 0 ? rawInventoryChange(raw.stdout) : "读不到 raw diff";
    if (typeof change === "string") { problems.push(`${label} ${change}`); return; }
    if (change.blobFrom !== blobFrom || change.blobTo !== blobTo) { problems.push(`${label} 清单 blob 与记录不一致`); return; }
    const cmp = countOnlyChanges(await blobText(bytes, blobFrom as string), await blobText(bytes, blobTo as string));
    if (!cmp.ok) { problems.push(`${label} 清单不是纯计数改动：${cmp.reason}`); return; }
    const bad = badCountValues(cmp.changed);
    if (bad.length) problems.push(`${label} 计数值不是严格格式：${bad.slice(0, 5).join("、")}`);
  } catch (e) { problems.push(`${label} 复核失败：${(e as Error).message.slice(0, 200)}`); }
}
