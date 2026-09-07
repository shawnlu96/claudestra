import { describe, expect, test } from "bun:test";
import { NUDGE_MIN_AGE_MS, nudgeReason, pickUnrepliedForNudge } from "../src/lib/reply-nudge";

const now = 1_000_000;

describe("pickUnrepliedForNudge (Stop hook 补 reply 拦截)", () => {
  test("有未回复的请求 → 挑最老的一条", () => {
    const r = pickUnrepliedForNudge(
      [{ key: "api:tok_a", ts: now - 5_000 }, { key: "123", ts: now - 60_000 }],
      { event: "Stop", stopHookActive: false, now },
    );
    expect(r?.key).toBe("123");
  });

  test("只拦 Stop:StopFailure / Notification / 旧版 stop 都不拦", () => {
    const c = [{ key: "api:tok_a", ts: now - 5_000 }];
    for (const event of ["StopFailure", "Notification", "stop"]) {
      expect(pickUnrepliedForNudge(c, { event, stopHookActive: false, now })).toBeNull();
    }
  });

  test("stop_hook_active(已经因 Stop hook 续跑过)→ 不再拦,防死循环", () => {
    expect(pickUnrepliedForNudge([{ key: "api:tok_a", ts: now - 5_000 }], { event: "Stop", stopHookActive: true, now })).toBeNull();
  });

  test("nudge 过的 pending 不再拦;刚投递(<500ms)的请求 agent 还没看到,不拦", () => {
    expect(pickUnrepliedForNudge([{ key: "a", ts: now - 5_000, nudgedAt: now - 100 }], { event: "Stop", stopHookActive: false, now })).toBeNull();
    expect(pickUnrepliedForNudge([{ key: "a", ts: now - NUDGE_MIN_AGE_MS + 1 }], { event: "Stop", stopHookActive: false, now })).toBeNull();
    expect(pickUnrepliedForNudge([{ key: "a", ts: now - NUDGE_MIN_AGE_MS }], { event: "Stop", stopHookActive: false, now })?.key).toBe("a");
  });

  test("没有 pending → null", () => {
    expect(pickUnrepliedForNudge([], { event: "Stop", stopHookActive: false, now })).toBeNull();
  });

  test("reason 写明 chat_id 与动作", () => {
    const r = nudgeReason("api:tok_bfc4c362");
    expect(r).toContain('reply(chat_id="api:tok_bfc4c362")');
    expect(r).toContain("不要重新分析");
  });
});
