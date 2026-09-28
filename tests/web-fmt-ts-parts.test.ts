import { afterAll, describe, expect, test } from "bun:test";
import { fmtDueParts, fmtTsParts, fmtUtcOffset } from "../web/features/chat/fmt-ts-parts";

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

describe("fmtDueParts", () => {
  const now = new Date(2026, 8, 28, 15, 0, 0); // 2026-09-28 15:00 local
  const at = (...a: [number, number, number, number, number]) => new Date(...a).toISOString();
  test("today / tomorrow by calendar day, not a 24h window", () => {
    expect(fmtDueParts(at(2026, 8, 28, 23, 59), now)).toMatchObject({ day: "today", hm: "23:59" });
    expect(fmtDueParts(at(2026, 8, 29, 0, 5), now)).toMatchObject({ day: "tomorrow", hm: "00:05" });
    expect(fmtDueParts(at(2026, 8, 29, 23, 0), now)?.day).toBe("tomorrow");
    expect(fmtDueParts(at(2026, 8, 30, 5, 45), now)).toMatchObject({ day: "other", date: "09-30", hm: "05:45" });
  });
  test("tomorrow across month and year ends", () => {
    expect(fmtDueParts(at(2026, 9, 1, 8, 0), new Date(2026, 8, 30, 22, 0))).toMatchObject({ day: "tomorrow", date: "10-01" });
    expect(fmtDueParts(at(2027, 0, 1, 1, 0), new Date(2026, 11, 31, 23, 0))).toMatchObject({ day: "tomorrow", date: "01-01" });
    expect(fmtDueParts(at(2027, 0, 2, 1, 0), new Date(2026, 11, 31, 23, 0))).toMatchObject({ day: "other", date: "01-02" });
  });
  test("full form carries the year and UTC offset", () => {
    const p = fmtDueParts(at(2027, 0, 2, 1, 0), now);
    expect(p?.full).toBe(`2027-01-02 01:00 ${fmtUtcOffset(new Date(2027, 0, 2, 1, 0))}`);
  });
  test("missing or invalid input → null", () => {
    expect(fmtDueParts(undefined, now)).toBeNull();
    expect(fmtDueParts("nope", now)).toBeNull();
  });
});

describe("device time zone", () => {
  // TZ 跨测试文件共享（同一进程）。delete process.env.TZ 不会让 Bun 回到原时区，只能显式赋回原值
  const saved = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  afterAll(() => {
    process.env.TZ = saved;
  });
  // 2026-09-29T20:45:00Z = owner 的例子：东京 09-30 05:45，上海 09-30 04:45
  const iso = "2026-09-29T20:45:00.000Z";
  test("same instant renders in the device zone with its offset", () => {
    process.env.TZ = "Asia/Tokyo";
    expect(fmtDueParts(iso, new Date("2026-09-29T03:00:00Z"))).toEqual({ day: "tomorrow", date: "09-30", hm: "05:45", full: "2026-09-30 05:45 UTC+9" });
    process.env.TZ = "Asia/Shanghai";
    expect(fmtDueParts(iso, new Date("2026-09-29T03:00:00Z"))).toEqual({ day: "tomorrow", date: "09-30", hm: "04:45", full: "2026-09-30 04:45 UTC+8" });
  });
  test("offset formats: half hours, negative, zero", () => {
    process.env.TZ = "Asia/Kolkata";
    expect(fmtUtcOffset(new Date(iso))).toBe("UTC+5:30");
    process.env.TZ = "America/Sao_Paulo";
    expect(fmtUtcOffset(new Date(iso))).toBe("UTC-3");
    process.env.TZ = "UTC";
    expect(fmtUtcOffset(new Date(iso))).toBe("UTC+0");
  });
  test("day boundary follows the device zone", () => {
    process.env.TZ = "America/Los_Angeles"; // 2026-09-29 13:45 PDT, same day as now
    expect(fmtDueParts(iso, new Date("2026-09-29T17:00:00Z"))).toMatchObject({ day: "today", hm: "13:45", full: "2026-09-29 13:45 UTC-7" });
  });
});
