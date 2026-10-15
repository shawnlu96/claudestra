/**
 * SELFHEAL1 验收线 5：同卡同 head 换单（重借）开跑 / 交付通知各只发一次，换 head 照常发；键在 journal 里（重启不丢）。
 * off 与改前一致（每单各发一对）。A 与 worker 都是假的（tests/lend-harness.ts）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { advance, getOrder } from "../src/lib/lend-journal.js";
import { configureLendNoticeOnce, noticeOnceKey } from "../src/lib/lend-notice.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { harness, polled, sha, toStarted, wire } from "./lend-harness.js";

let restore: (() => void) | null = null;
const mode = (m: RecoveryMode) => { restore?.(); restore = configureLendNoticeOnce(() => m); };
afterEach(() => { restore?.(); restore = null; });

const NEW_HEAD = "f".repeat(40);
const body = (orderId: string) => ({ v: 1, orderId, gen: 1, verdict: { v: 1 }, report: "r", session: { id: "thr-1", family: "codex" } });
const toResult = (h: ReturnType<typeof harness>, id: string) => advance(h.db, id, "started", "result_pending", { payload: body(id), payloadSha: sha(JSON.stringify(body(id))) });

/** o1 runs to acked, then A re-lends the same card as o2 (head `head`), which runs to acked too. */
async function relend(h: ReturnType<typeof harness>, head?: string) {
  await toStarted(h);
  toResult(h, "o1");
  await h.tick();
  expect(getOrder(h.db, "o1")!.state).toBe("acked");
  h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [{ ...polled("o2"), ...(head ? { head } : {}) }], pollAfterMs: 30_000 } });
  h.A.claim = (b) => ({ status: 200, body: { ok: true, v: 1, order: { ...wire(String(b.orderId)), ...(head ? { head } : {}) }, text: "【调度派单】T93 · review",
    sha256: sha("【调度派单】T93 · review"), lease: { gen: 1, expiresAt: 0, ms: 600_000 } } });
  for (let i = 0; i < 6; i++) { h.advanceTime(31_000); await h.tick(); }
  expect(getOrder(h.db, "o2")!.state).toBe("started");
  toResult(h, "o2");
  for (let i = 0; i < 2; i++) await h.tick();
  expect(getOrder(h.db, "o2")!.state).toBe("acked");
}

describe("[验收线 5] 同一件事只通知同事一次", () => {
  test("先红后绿：off 每单各发一对（改前行为）；on 同卡同 head 重借，开跑 / 交付各只发一次", async () => {
    mode("off");
    const red = harness();
    await relend(red);
    expect(red.noticeKinds()).toEqual(["start:o1", "acked:o1", "start:o2", "acked:o2"]);

    mode("on");
    const h = harness();
    await relend(h);
    expect(h.noticeKinds()).toEqual(["start:o1", "acked:o1"]);
    expect(getOrder(h.db, "o2")!.notices).toMatchObject({ start: expect.any(Number), end: { kind: "acked", sentAt: expect.any(Number) } });
    expect(h.log.created).toHaveLength(2); // o2's worker still started: a skipped duplicate counts as told
  });

  test("换了 head 照常通知", async () => {
    mode("on");
    const h = harness();
    await relend(h, NEW_HEAD);
    expect(h.noticeKinds()).toEqual(["start:o1", "acked:o1", "start:o2", "acked:o2"]);
  });

  test("observe：照旧发，重复的那次记一行「本会跳过」", async () => {
    mode("observe");
    const h = harness();
    await relend(h);
    expect(h.noticeKinds()).toEqual(["start:o1", "acked:o1", "start:o2", "acked:o2"]);
    expect(h.log.lines.filter((l) => l.includes("恢复观察（selfHealBeforeManual）：本会跳过"))).toHaveLength(2);
  });

  test("去重键含对方、仓库、卡、head 与种类；没有完整 head 不去重", () => {
    const p = { peer: "a", repo: "o/r", taskId: "T1", head: "c".repeat(40), kind: "start" as const };
    expect(noticeOnceKey(p)).toBe(`notice-once:${JSON.stringify(["a", "o/r", "T1", "c".repeat(40), "start"])}`);
    expect(noticeOnceKey({ ...p, kind: "acked" })).not.toBe(noticeOnceKey(p));
    expect(noticeOnceKey({ ...p, head: "abc" })).toBeNull();
  });
});
