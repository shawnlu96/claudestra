import { describe, expect, test } from "bun:test";
import { elapsedSince, fmtClock } from "../web/features/chat/fmt-clock";

describe("fmtClock", () => {
  test("seconds, minutes + seconds, hours + minutes (same reading as the CC footer)", () => {
    expect(fmtClock(0)).toBe("0s");
    expect(fmtClock(59_999)).toBe("59s");
    expect(fmtClock(60_000)).toBe("1m 0s");
    expect(fmtClock(5 * 60_000 + 12_000)).toBe("5m 12s");
    expect(fmtClock(3_600_000 + 3 * 60_000 + 59_000)).toBe("1h 3m");
  });
  test("clock skew (start slightly in the future) clamps to 0s instead of going negative", () => {
    expect(fmtClock(-1500)).toBe("0s");
  });
});

describe("elapsedSince", () => {
  const start = "2026-10-01T10:00:00.000Z";
  test("counts from the tool's timestamp", () => {
    expect(elapsedSince(start, Date.parse(start) + 18 * 60_000 + 5_000)).toBe("18m 5s");
  });
  test("missing or unparseable start → empty, so the row shows just 「运行中」", () => {
    expect(elapsedSince(undefined, Date.now())).toBe("");
    expect(elapsedSince("not a date", Date.now())).toBe("");
  });
});
