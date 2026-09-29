/** lib/log-throttle.ts：每个 key 每分钟一行、附压下的条数；key 满了新来的归到溢出 key */
import { describe, expect, test } from "bun:test";
import { LogThrottle, OVERFLOW_KEY } from "../src/lib/log-throttle.js";

describe("LogThrottle", () => {
  test("同一 key 一分钟内只放第一条，下一分钟的那条带上压下的条数", () => {
    const t = new LogThrottle(60_000, 8);
    expect(t.take("a", 0)).toEqual({ key: "a", muted: 0 });
    for (let i = 1; i <= 5; i++) expect(t.take("a", i * 1000)).toBeNull();
    expect(t.take("b", 1000)).toEqual({ key: "b", muted: 0 });
    expect(t.take("a", 60_000)).toEqual({ key: "a", muted: 5 });
  });
  test("key 数到上限：新 key 记在溢出 key 下，多开身份也只一行；过期的 key 腾出位置", () => {
    const t = new LogThrottle(60_000, 3);
    for (const k of ["a", "b", "c"]) expect(t.take(k, 0)).not.toBeNull();
    expect(t.take("d", 1)).toEqual({ key: OVERFLOW_KEY, muted: 0 });
    for (let i = 0; i < 100; i++) expect(t.take(`x${i}`, 2)).toBeNull();
    expect(t.take("e", 60_001)).toEqual({ key: "e", muted: 0 });
  });
});
