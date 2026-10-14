/** i28-LENDCLAIM1：claim 撞上中心 503 unavailable（中心暂不可用 / 回包丢失）不再永久 declined，下轮重领；明确拒绝照旧 declined。 */
import { describe, expect, test } from "bun:test";
import { transientLendCode, workerName } from "../src/lib/lend-drive.js";
import { getOrder } from "../src/lib/lend-journal.js";
import { harness } from "./lend-harness.js";

const refuse = (status: number, code: string) => () => ({ status, body: { ok: false, v: 1, code, error: `${code} 测试` } });

describe("i28-LENDCLAIM1 claim 遇 unavailable 下轮再试", () => {
  test("第一次 503 unavailable、第二轮成功：单子 claimed 往下走，worker 只起一次", async () => {
    const h = harness();
    const ok = h.A.claim;
    h.A.claim = refuse(503, "unavailable");
    for (let i = 0; i < 4 && !h.calls.some((c) => c.op === "claim"); i++) await h.tick();
    expect(h.calls.filter((c) => c.op === "claim")).toHaveLength(1);
    expect(getOrder(h.db, "o1")!.state).toBe("asked");
    expect(h.log.created).toEqual([]);
    h.A.claim = ok;
    for (let i = 0; i < 4; i++) await h.tick();
    expect(h.calls.filter((c) => c.op === "claim").map((c) => c.body.orderId)).toEqual(["o1", "o1"]);
    expect(getOrder(h.db, "o1")!.state).toBe("started");
    expect(h.log.created).toEqual([workerName("o1")]);
  });

  test("一直 unavailable：留在 asked 每轮重领，不 declined", async () => {
    const h = harness();
    h.A.claim = refuse(503, "unavailable");
    for (let i = 0; i < 4; i++) await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("asked");
    expect(h.calls.filter((c) => c.op === "claim").length).toBeGreaterThanOrEqual(2);
  });

  for (const [status, code] of [[400, "invalid"], [403, "denied"]] as const) {
    test(`明确拒绝 ${code}：照旧 declined，不再重领`, async () => {
      const h = harness();
      h.A.claim = refuse(status, code);
      for (let i = 0; i < 3; i++) await h.tick();
      expect(getOrder(h.db, "o1")).toMatchObject({ state: "declined" });
      const n = h.calls.filter((c) => c.op === "claim").length; // invalid 会去掉 caps 重发一次，之后不再领
      await h.tick();
      expect(h.calls.filter((c) => c.op === "claim")).toHaveLength(n);
      expect(h.log.created).toEqual([]);
    });
  }

  test("可重试码 claim 与转发结论同源：unavailable / transport / bad_response 算，invalid / denied / max_open 不算（max_open 只在 claim 侧另加）", () => {
    for (const c of ["unavailable", "transport", "bad_response"]) expect(transientLendCode(c)).toBe(true);
    for (const c of ["invalid", "denied", "max_open"]) expect(transientLendCode(c)).toBe(false);
  });
});
