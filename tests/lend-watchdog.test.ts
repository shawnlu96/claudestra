/** T94 出借 worker 自停兜底（src/lib/lend-watchdog.ts）：服务不在时宿主自己按 journal 的租约截止停 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance, openLendJournal, patchOrder, recordAsked } from "../src/lib/lend-journal.js";
import { lendStopReason, lendWatchdog, UNREADABLE_LIMIT, WATCHDOG_GRACE_MS } from "../src/lib/lend-watchdog.js";
import { REPO_ROOT } from "../src/lib/repo-root.js";

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

describe("i28-R5a 读不了 journal 不再一次就停", () => {
  test("读不了要连续 UNREADABLE_LIMIT 次才停；中间读到一次就清零；定性的该停照样立即停", () => {
    const { db: setup, path } = journal(9e15);
    setup.close(); // 下面要把文件换走：本进程不能还开着它
    const lines: string[] = [];
    const tick = lendWatchdog("agent-lend-x", (m) => void lines.push(m), path);
    // 读不了：把 journal 暂时换成同名目录（新 inode，SQLite 不会复用本进程已开的句柄）
    const unreadable = (f: () => unknown) => { renameSync(path, `${path}.away`); mkdirSync(path); try { return f(); } finally { rmdirSync(path); renameSync(`${path}.away`, path); } };
    expect(unreadable(() => tick(1))).toBeNull();
    expect(lines[0]).toContain("这次没读到");
    expect(tick(2)).toBeNull(); // 读到了：清零
    expect(unreadable(() => tick(3))).toBeNull();
    expect(UNREADABLE_LIMIT).toBe(2);
    expect(unreadable(() => tick(4))).toMatch(/读不了出借 journal/);
    const db = openLendJournal(path);
    advance(db, "o1", "started", "cancelled", { reason: "撤单" });
    expect(lendWatchdog("agent-lend-x", () => {}, path)(5)).toMatch(/已结束/);
  });

  test("调度服务每轮开 / 写 / 关 journal（关时 checkpoint 独占）的同时连读：一次都不报读不了（lab 里零等待读法约 2% 失败）", async () => {
    const { db, path } = journal(9e15);
    db.close();
    const writer = Bun.spawn([process.execPath, "-e", `const { openLendJournal, patchOrder } = await import(${JSON.stringify(`${REPO_ROOT}/src/lib/lend-journal.ts`)});
      for (const end = Date.now() + 3000; Date.now() < end; await Bun.sleep(5)) { const d = openLendJournal(${JSON.stringify(path)}); patchOrder(d, "o1", ["started"], { lastBeatAt: Date.now() }); d.close(); }`],
      { stdout: "ignore", stderr: "inherit" });
    const seen: Record<string, number> = {};
    for (const end = Date.now() + 3000; Date.now() < end; await Bun.sleep(5)) { const w = lendStopReason("agent-lend-x", path, 1) ?? "ok"; seen[w] = (seen[w] ?? 0) + 1; }
    await writer.exited;
    expect(writer.exitCode).toBe(0);
    expect(Object.keys(seen)).toEqual(["ok"]);
    expect(seen.ok).toBeGreaterThan(50);
  }, 20_000);
});
