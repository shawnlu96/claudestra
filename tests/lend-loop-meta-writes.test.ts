/** SCH-2 出借 journal 每轮不重写没变的 meta：同一状态连跑两轮 tick，第二轮 total_changes() 不增加（src/lib/lend-loop.ts、lend-journal.ts setMeta） */
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { getMeta, setMeta } from "../src/lib/lend-journal.js";
import { TICK_KEY } from "../src/lib/lend-inbox.js";
import { harness, toStarted } from "./lend-harness.js";

const changes = (db: Database): number => (db.query("SELECT total_changes() AS n").get() as { n: number }).n;

test("空闲的出借方：第二轮（没到 poll 时刻）一行都不写", async () => {
  const h = harness();
  h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [], pollAfterMs: 30_000 } });
  await h.tick();
  const before = changes(h.db);
  h.advanceTime(5_000);
  await h.tick();
  expect(changes(h.db)).toBe(before);
});

test("在跑的单（started、心跳未到期）：第二轮一行都不写", async () => {
  const h = harness();
  await toStarted(h);
  h.advanceTime(5_000);
  await h.tick();
  const before = changes(h.db);
  h.advanceTime(5_000);
  await h.tick();
  expect(changes(h.db)).toBe(before);
});

test("只差时间的 tickAt / status 隔够了照样刷新：收单判 lender_idle、doctor 判没在跑不受影响", async () => {
  const h = harness();
  h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [], pollAfterMs: 30_000 } });
  await h.tick();
  const t0 = Number(getMeta(h.db, TICK_KEY));
  h.advanceTime(5_000);
  await h.tick();
  expect(Number(getMeta(h.db, TICK_KEY))).toBe(t0);
  h.advanceTime(60_000);
  await h.tick();
  expect(Number(getMeta(h.db, TICK_KEY))).toBe(t0 + 65_000);
  expect(JSON.parse(getMeta(h.db, "status")!).at).toBe(t0 + 65_000);
});

test("setMeta 同值不写，变了照写", () => {
  const h = harness();
  setMeta(h.db, "k", "v");
  const before = changes(h.db);
  setMeta(h.db, "k", "v");
  expect(changes(h.db)).toBe(before);
  setMeta(h.db, "k", "w");
  expect(changes(h.db)).toBe(before + 1);
});
