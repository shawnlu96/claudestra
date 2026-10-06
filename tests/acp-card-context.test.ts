import { describe, expect, test } from "bun:test";
import {
  cardCompactVerdict, cardLines, cardStatus, hardLineGate, parseCardCompactRequest, parseCardCtxMode, usageState,
  type CardCompactRequest, type CardCtxSnapshot,
} from "../src/lib/acp/card-context.ts";

// CTXA 纯判定：线（20 万闲置 / 30 万硬线，按实际窗口收）、usage 有效性、强身份逐项核对、忙闲、模式

const NOW = 10_000_000;
const MIN3 = 3 * 60_000;

function snap(over: Partial<CardCtxSnapshot> = {}, used = 250_000, size: number | null = 1_000_000): CardCtxSnapshot {
  return {
    mode: "on", identity: { card: "CTXA", expectedSessionId: "s1" }, hostId: "h1", attachGen: 1, sessionId: "s1", turnGen: 4, slotGen: 2,
    registered: true, capable: true, rotating: false, compacting: false, running: false, queued: 0, idleSince: NOW - MIN3,
    usage: { used, size, sessionId: "s1", attachGen: 1, turnGen: 4, at: NOW - MIN3 }, liveBinding: "atomic",
    ...over,
  };
}
const req = (over: Partial<CardCompactRequest> = {}): CardCompactRequest =>
  ({ opId: "op1", card: "CTXA", expectedSessionId: "s1", hostId: "h1", attachGen: 1, turnGen: 4, slotGen: 2, binding: { card: "CTXA", sessionId: "s1" }, ...over });
const verdict = (s: CardCtxSnapshot, r = req(), now = NOW) => cardCompactVerdict(s, r, now);

describe("线：199999 / 200000 / 299999 / 300000", () => {
  test.each([
    [199_999, { ok: false, reason: "under" }],
    [200_000, { ok: true, kind: "idle" }],
    [299_999, { ok: true, kind: "idle" }],
    [300_000, { ok: true, kind: "hard" }],
  ])("used=%p 闲置满 3 分钟", (used, want) => expect(verdict(snap({}, used))).toEqual(want as any));

  test("闲置线要闲置满 3 分钟；硬线不看闲置时长（但仍要空闲）", () => {
    expect(verdict(snap({ idleSince: NOW - MIN3 + 1 }, 200_000))).toEqual({ ok: false, reason: "idle-wait" });
    expect(verdict(snap({ idleSince: NOW - 1 }, 300_000))).toEqual({ ok: true, kind: "hard" });
    expect(verdict(snap({ running: true }, 300_000))).toEqual({ ok: false, reason: "running" });
  });

  test("更小的实际模型窗口：线收到 85% / 93%，不会越过模型上限", () => {
    expect(cardLines(1_000_000)).toEqual({ idle: 200_000, hard: 300_000 });
    expect(cardLines(272_000)).toEqual({ idle: 200_000, hard: 252_960 });
    expect(cardLines(200_000)).toEqual({ idle: 170_000, hard: 186_000 });
    expect(cardLines(null)).toEqual({ idle: 200_000, hard: 300_000 });
    expect(verdict(snap({ idleSince: NOW - 1 }, 186_000, 200_000))).toEqual({ ok: true, kind: "hard" });
  });

  test("单测压低的 limits 不能抬过卡片线", () => {
    expect(cardLines(null, { idle: 900_000, hard: 900_000 })).toEqual({ idle: 200_000, hard: 300_000 });
    expect(cardLines(null, { idle: 1_000, hard: 2_000 })).toEqual({ idle: 1_000, hard: 2_000 });
  });
});

describe("usage 缺失 / 陈旧", () => {
  test("没有 / 别的会话 → unknown；之后开过回合、换过接线、压缩过 → stale", () => {
    expect(verdict(snap({ usage: null }))).toEqual({ ok: false, reason: "usage-unknown" });
    const base = snap().usage!;
    expect(verdict(snap({ usage: { ...base, sessionId: "s0" } }))).toEqual({ ok: false, reason: "usage-unknown" });
    expect(verdict(snap({ usage: { ...base, turnGen: 3 } }))).toEqual({ ok: false, reason: "usage-stale" });
    expect(verdict(snap({ usage: { ...base, attachGen: 0 } }))).toEqual({ ok: false, reason: "usage-stale" });
    expect(verdict(snap({ usage: { ...base, compacted: true } }))).toEqual({ ok: false, reason: "usage-stale" });
    expect(usageState(snap())).toBe("fresh");
  });
});

describe("强身份逐项核对（不重放、不降级）", () => {
  test.each([
    [{ capable: false }, {}, "no-capability"],
    [{ identity: null }, {}, "no-capability"],
    [{ identity: { card: "CTXA", expectedSessionId: "s-boot" } }, {}, "startup-mismatch"],
    [{}, { card: "OTHER" }, "card-mismatch"],
    [{}, { binding: null }, "not-bound"],
    [{}, { binding: { card: "OTHER", sessionId: "s1" } }, "binding-revoked"],
    [{}, { binding: { card: "CTXA", sessionId: "s-rebound" } }, "binding-revoked"],
    [{ registered: false }, {}, "not-registered"],
    [{}, { hostId: "h0" }, "old-host"],
    [{}, { attachGen: 0 }, "old-attach"],
    [{}, { expectedSessionId: "s0" }, "old-session"],
    [{}, { turnGen: 3 }, "turn-drift"],
    [{}, { slotGen: 1 }, "turn-drift"],
    [{ rotating: true }, {}, "rotating"],
    [{ compacting: true, running: true }, {}, "compacting"],
    [{ running: true }, {}, "running"],
    [{ queued: 1 }, {}, "queued"],
  ] as const)("%p / %p → %s", (s, r, reason) => expect(verdict(snap(s as any), req(r as any))).toEqual({ ok: false, reason }));
});

describe("模式", () => {
  test("缺省 observe；observe 只给 wouldFire，off 一律拒", () => {
    expect(parseCardCtxMode(undefined)).toBe("observe");
    expect(parseCardCtxMode("weird")).toBe("observe");
    expect(verdict(snap({ mode: "observe" }, 300_000))).toEqual({ ok: false, reason: "observe", wouldFire: "hard" });
    expect(verdict(snap({ mode: "off" }, 300_000))).toEqual({ ok: false, reason: "mode-off" });
  });

  test("新回合受理边界：on 管、observe 只报；没过硬线、usage 无效、身份不符都不管；回合结束后的 usage 不因回合代次作废", () => {
    expect(hardLineGate(snap({ running: true }, 300_000))).toBe("enforce");
    expect(hardLineGate(snap({ usage: { ...snap().usage!, used: 300_000, turnGen: 1 } }))).toBe("enforce");
    expect(hardLineGate(snap({ usage: { ...snap().usage!, used: 300_000, attachGen: 0 } }))).toBeNull();
    expect(hardLineGate(snap({ mode: "observe" }, 300_000))).toBe("observe");
    expect(hardLineGate(snap({ mode: "off" }, 300_000))).toBeNull();
    expect(hardLineGate(snap({}, 299_999))).toBeNull();
    expect(hardLineGate(snap({ usage: { ...snap().usage!, used: 300_000, compacted: true } }))).toBeNull();
    expect(hardLineGate(snap({ identity: { card: "CTXA", expectedSessionId: "x" } }, 300_000))).toBeNull();
  });
});

test("申请解析：缺字段 / opId 不合法 = null", () => {
  expect(parseCardCompactRequest({ ...req() })).toEqual(req());
  expect(parseCardCompactRequest({ ...req(), opId: "a b" })).toBeNull();
  expect(parseCardCompactRequest({ ...req(), turnGen: "4" })).toBeNull();
  expect(parseCardCompactRequest({ ...req(), hostId: "" })).toBeNull();
  expect(parseCardCompactRequest({ ...req(), binding: undefined })).toEqual(req({ binding: null })); // 没带登记：解析成 null，受理时拒 not-bound
  expect(parseCardCompactRequest({ ...req(), binding: { card: "CTXA" } })).toBeNull();
});

test("状态：回合中途预算固定 blocked-capability；结论用此刻身份算", () => {
  const st = cardStatus(snap({}, 250_000), NOW, undefined, undefined, { card: "CTXA", sessionId: "s1" });
  expect(cardStatus(snap({}, 250_000), NOW).verdict).toEqual({ ok: false, reason: "not-bound" });
  expect(st).toMatchObject({ cap: "card_compact_v1", busyBudget: "blocked-capability", idleMs: MIN3, verdict: { ok: true, kind: "idle" } });
  expect(st.usage).toEqual({ state: "fresh", used: 250_000, size: 1_000_000, idle: 200_000, hard: 300_000 });
});

test("现行登记租约 blocked-capability（生产现状）：判到最后一律 live-binding-blocked、只报 wouldFire；硬线 / 闲置线都不放行；状态照实报", () => {
  const s = snap({ liveBinding: "blocked-capability" });
  expect(verdict(s)).toEqual({ ok: false, reason: "live-binding-blocked", wouldFire: "idle" });
  expect(verdict(snap({ liveBinding: "blocked-capability" }, 300_000))).toEqual({ ok: false, reason: "live-binding-blocked", wouldFire: "hard" });
  expect(verdict(snap({ liveBinding: "blocked-capability" }, 199_999))).toEqual({ ok: false, reason: "under" });
  expect(verdict(snap({ liveBinding: "blocked-capability", mode: "observe" }))).toEqual({ ok: false, reason: "observe", wouldFire: "idle" });
  expect(cardStatus(s, NOW, undefined, undefined, { card: "CTXA", sessionId: "s1" })).toMatchObject({ liveBinding: "blocked-capability", verdict: { reason: "live-binding-blocked" } });
});
