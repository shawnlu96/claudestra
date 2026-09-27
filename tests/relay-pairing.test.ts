/**
 * 配对短码的本机状态机（src/bridge/relay-pairing.ts PairingCodes）：一次性、过期、限流、并发上限。
 */
import { describe, expect, test } from "bun:test";
import { PairingCodes } from "../src/bridge/relay-pairing.js";
import { CODE_ALPHABET, normalizeCode } from "../src/lib/relay-protocol.js";

function fixture(o: { ttlMs?: number; maxActive?: number; maxAttemptsPerMin?: number } = {}) {
  let now = 1_000_000;
  let seed = 0;
  const codes = new PairingCodes({ now: () => now, random: (n) => new Uint8Array(n).map((_, i) => (seed * 7 + i * 13) % 251), ...o });
  return { codes, tick: (ms: number) => (now += ms), next: () => seed++ };
}

describe("PairingCodes", () => {
  test("签码 8 位、字母表内；兑换一次即作废；大小写与中划线不敏感", () => {
    const { codes } = fixture();
    const { code, expiresAt } = codes.issue();
    expect(code).toHaveLength(8);
    for (const ch of code) expect(CODE_ALPHABET.includes(ch)).toBe(true);
    expect(expiresAt).toBe(1_000_000 + 10 * 60_000);
    expect(codes.activeCodes().map((c) => c.code)).toEqual([code]);
    const pretty = `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`;
    expect(codes.redeem(pretty)).toEqual({ ok: true, code });
    expect(codes.redeem(code)).toEqual({ ok: false, reason: "invalid" });
    expect(codes.activeCodes()).toEqual([]);
  });
  test("过期的码不再接受，prune 会清掉", () => {
    const { codes, tick } = fixture({ ttlMs: 1000 });
    const { code } = codes.issue();
    tick(1000);
    expect(codes.redeem(code)).toEqual({ ok: false, reason: "expired" });
    const { code: c2 } = codes.issue();
    tick(1500);
    expect(codes.prune()).toEqual([c2]);
    expect(codes.activeCodes()).toEqual([]);
  });
  test("每分钟 5 次错误尝试后限流，一分钟后恢复；成功不计数", () => {
    const { codes, tick } = fixture({ maxAttemptsPerMin: 3 });
    const { code } = codes.issue();
    expect(codes.redeem("nope")).toEqual({ ok: false, reason: "invalid" });
    expect(codes.redeem("AAAA-AAAA")).toEqual({ ok: false, reason: "invalid" });
    expect(codes.redeem("BBBBBBBB")).toEqual({ ok: false, reason: "invalid" });
    expect(codes.redeem(code)).toEqual({ ok: false, reason: "rate_limited" });
    tick(60_001);
    expect(codes.redeem(code)).toEqual({ ok: true, code });
    const { code: c2 } = codes.issue();
    expect(codes.redeem(c2)).toEqual({ ok: true, code: c2 });
  });
  test("同时最多 N 个：多签顶掉最旧的并报出来", () => {
    const { codes, tick, next } = fixture({ maxActive: 2 });
    const a = codes.issue();
    next();
    tick(1);
    const b = codes.issue();
    next();
    tick(1);
    const c = codes.issue();
    expect(c.evicted).toEqual([a.code]);
    expect(codes.activeCodes().map((x) => x.code).sort()).toEqual([b.code, c.code].sort());
    expect(codes.redeem(a.code)).toEqual({ ok: false, reason: "invalid" });
  });
  test("形状不对的输入直接 invalid 且计入限流", () => {
    const { codes } = fixture({ maxAttemptsPerMin: 1 });
    expect(normalizeCode("short")).toBeNull();
    expect(codes.redeem("short")).toEqual({ ok: false, reason: "invalid" });
    expect(codes.redeem("short")).toEqual({ ok: false, reason: "rate_limited" });
  });
});
