import { describe, expect, test } from "bun:test";
import { fmtTsParts } from "../web/features/chat/fmt-ts-parts";

describe("fmtTsParts", () => {
  const now = new Date(2026, 8, 27, 15, 0, 0); // 2026-09-27 15:00 local
  test("same day: no date, seconds and short forms", () => {
    const p = fmtTsParts(new Date(2026, 8, 27, 9, 5, 7).toISOString(), now);
    expect(p).toEqual({ date: null, hms: "09:05:07", hm: "09:05" });
  });
  test("other day: MM-DD without year, even across years", () => {
    expect(fmtTsParts(new Date(2026, 8, 25, 14, 3, 22).toISOString(), now)?.date).toBe("09-25");
    expect(fmtTsParts(new Date(2025, 11, 31, 23, 59, 59).toISOString(), now)?.date).toBe("12-31");
  });
  test("missing or invalid input → null", () => {
    expect(fmtTsParts(undefined, now)).toBeNull();
    expect(fmtTsParts("not a date", now)).toBeNull();
  });
});
