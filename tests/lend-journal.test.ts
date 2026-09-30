/** T94 出借 journal 状态机 + 收据（src/lib/lend-journal.ts、lend-receipts.ts） */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advance, canMove, getOrder, isTerminal, JournalConflict, LIVE_STATES, liveOrders, localDay, openLendJournal, openSlots, ordersToday, patchOrder, recordAsked,
} from "../src/lib/lend-journal.js";
import { appendReceipt, receiptOf } from "../src/lib/lend-receipts.js";

const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
const preview = { taskId: "T93", step: "review", repo: "shawnlu96/claudestra", pr: 270, head: "a".repeat(40) };
const ask = (db: ReturnType<typeof openLendJournal>, orderId = "o1", peer = "team-a") =>
  recordAsked(db, { orderId, peer, fp: null, family: "codex", preview }, NOW).row;

describe("T94 journal 状态机", () => {
  test("只能按表往前走：asked→claimed→cloned→started→result_pending→acked；终态不再变", () => {
    const db = openLendJournal(":memory:");
    ask(db);
    for (const [from, to] of [["asked", "claimed"], ["claimed", "cloned"], ["cloned", "started"], ["started", "result_pending"], ["result_pending", "acked"]] as const) {
      expect(advance(db, "o1", from, to, {}, NOW).state).toBe(to);
    }
    expect(isTerminal("acked")).toBe(true);
    expect(() => advance(db, "o1", "acked", "started")).toThrow(JournalConflict);
    expect(LIVE_STATES).not.toContain("acked");
  });

  test("跳步、倒退都拒：asked 不能直接 started，started 不能回 cloned，已起 worker 的单不能记成 released（not_started）", () => {
    expect(canMove("asked", "started")).toBe(false);
    expect(canMove("started", "cloned")).toBe(false);
    expect(canMove("started", "released")).toBe(false);
    expect(canMove("cloned", "released")).toBe(true);
    const db = openLendJournal(":memory:");
    ask(db);
    expect(() => advance(db, "o1", "asked", "started")).toThrow(/不能从 asked 走到 started/);
  });

  test("CAS：状态已被别人推进，按旧状态再推 / 再改都拒，库里不变", () => {
    const db = openLendJournal(":memory:");
    ask(db);
    advance(db, "o1", "asked", "claimed", { leaseGen: 1 }, NOW);
    expect(() => advance(db, "o1", "asked", "declined")).toThrow(/已不在 asked/);
    expect(() => patchOrder(db, "o1", ["asked"], { askId: "x" })).toThrow(JournalConflict);
    expect(getOrder(db, "o1")).toMatchObject({ state: "claimed", leaseGen: 1, askId: null });
  });

  test("同一 orderId 重复记只有一行（重复 poll 到同一张单不会开第二条）", () => {
    const db = openLendJournal(":memory:");
    expect(recordAsked(db, { orderId: "o1", peer: "team-a", fp: null, family: "codex", preview }, NOW).inserted).toBe(true);
    advance(db, "o1", "asked", "claimed", {}, NOW);
    const again = recordAsked(db, { orderId: "o1", peer: "team-a", fp: null, family: "codex", preview }, NOW);
    expect(again.inserted).toBe(false);
    expect(again.row.state).toBe("claimed");
    expect(liveOrders(db)).toHaveLength(1);
  });

  test("日额度按 claim 当天数，released / declined / 还没 claim 的不算；在跑位含等 owner 批的", () => {
    const db = openLendJournal(":memory:");
    for (const id of ["a", "b", "c", "d"]) ask(db, id);
    advance(db, "a", "asked", "claimed", { day: localDay(NOW) }, NOW);
    advance(db, "b", "asked", "claimed", { day: localDay(NOW) }, NOW);
    advance(db, "b", "claimed", "released", {}, NOW);
    advance(db, "c", "asked", "declined", {}, NOW);
    expect(ordersToday(db, "team-a", NOW)).toBe(1);
    expect(ordersToday(db, "team-a", NOW + 86_400_000)).toBe(0);
    expect(openSlots(db, "team-a", "codex")).toBe(2); // a（claimed）+ d（asked）
  });

  test("JSON 列原样往返：订单、请求体读出来和写进去一样", () => {
    const db = openLendJournal(":memory:");
    ask(db);
    const wire = { order: { orderId: "o1", head: "a".repeat(40) }, text: "派单\n全文" };
    advance(db, "o1", "asked", "claimed", { wire }, NOW);
    expect(getOrder(db, "o1")!.wire).toEqual(wire);
    expect(getOrder(db, "o1")!.preview).toEqual(preview);
  });
});

describe("T94 收据", () => {
  test("记谁的单、哪个 head、会话、用量；取不到用量写「未知」；同一单只写一行", () => {
    const db = openLendJournal(":memory:");
    ask(db);
    advance(db, "o1", "asked", "claimed", { wire: { order: { taskId: "T93", step: "review", repo: "shawnlu96/claudestra", pr: 270, head: "b".repeat(40) }, text: "x" } }, NOW);
    advance(db, "o1", "claimed", "released", { reason: "clone 失败" }, NOW);
    const path = join(mkdtempSync(join(tmpdir(), "lend-rc-")), "receipts.jsonl");
    const r = receiptOf(getOrder(db, "o1")!, "未知", NOW);
    expect(r).toMatchObject({ orderId: "o1", peer: "team-a", taskId: "T93", head: "b".repeat(40), outcome: "released", tokens: "未知", sessionId: null });
    expect(appendReceipt(r, path)).toBe(true);
    expect(appendReceipt(r, path)).toBe(false);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(JSON.parse(lines[0]))).not.toMatch(/派单|verdict|report/);
  });
});
