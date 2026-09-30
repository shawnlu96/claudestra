/** T94 出借 worker 自停兜底（src/lib/lend-watchdog.ts）：服务不在时宿主自己按 journal 的租约截止停 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance, openLendJournal, patchOrder, recordAsked } from "../src/lib/lend-journal.js";
import { lendStopReason, WATCHDOG_GRACE_MS } from "../src/lib/lend-watchdog.js";

function journal(leaseUntil: number) {
  const path = join(mkdtempSync(join(tmpdir(), "lend-wd-")), "journal.sqlite");
  const db = openLendJournal(path);
  recordAsked(db, { orderId: "o1", peer: "a", fp: null, family: "codex", preview: {} }, 0);
  advance(db, "o1", "asked", "claimed", { leaseUntil, leaseGen: 1 });
  advance(db, "o1", "claimed", "cloned", { dir: "/w" });
  patchOrder(db, "o1", ["cloned"], { agent: "agent-lend-x" });
  advance(db, "o1", "cloned", "started", { sessionId: "s" });
  return { db, path };
}

describe("T94 宿主自停兜底", () => {
  test("租约内接着跑；过了截止 + 宽限就该停", () => {
    const { path } = journal(10_000);
    expect(lendStopReason("agent-lend-x", path, 10_000)).toBeNull();
    expect(lendStopReason("agent-lend-x", path, 10_000 + WATCHDOG_GRACE_MS + 1)).toMatch(/心跳过期/);
  });

  test("单已结束、journal 里没有这个 worker、journal 不在：都该停（fail-closed）", () => {
    const { db, path } = journal(9e15);
    expect(lendStopReason("agent-lend-other", path, 1)).toMatch(/没有/);
    advance(db, "o1", "started", "cancelled", { reason: "撤单" });
    expect(lendStopReason("agent-lend-x", path, 1)).toMatch(/已结束/);
    expect(lendStopReason("agent-lend-x", join(tmpdir(), "nope", "j.sqlite"), 1)).toMatch(/不在/);
  });
});
