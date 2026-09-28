import { afterAll, describe, expect, test } from "bun:test";
import { isStale, nextRefreshMs, resolveUntil, tipShift } from "../web/features/chat/mission-time";

// TZ 跨测试文件共享（同一进程）。delete process.env.TZ 不会让 Bun 回到原时区，只能显式赋回原值
const saved = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
afterAll(() => {
  process.env.TZ = saved;
});

describe("resolveUntil", () => {
  test("HH:MM → ISO in the device zone; Tokyo vs Shanghai give different instants for the same input", () => {
    const now = new Date("2026-09-29T12:00:00Z"); // 东京 21:00 / 上海 20:00
    process.env.TZ = "Asia/Tokyo";
    expect(resolveUntil("05:45", now)).toBe("2026-09-29T20:45:00.000Z");
    process.env.TZ = "Asia/Shanghai";
    expect(resolveUntil("05:45", now)).toBe("2026-09-29T21:45:00.000Z");
  });
  test("later today stays today; already passed (or exactly now) rolls to tomorrow", () => {
    process.env.TZ = "Asia/Shanghai";
    const now = new Date("2026-09-29T12:00:00Z"); // 上海 20:00
    expect(resolveUntil("23:30", now)).toBe("2026-09-29T15:30:00.000Z");
    expect(resolveUntil("20:00", now)).toBe("2026-09-30T12:00:00.000Z");
    expect(resolveUntil("9:05", now)).toBe("2026-09-30T01:05:00.000Z");
  });
  test("rolling past midnight crosses month and year", () => {
    process.env.TZ = "Asia/Shanghai";
    expect(resolveUntil("00:30", new Date("2026-09-30T15:00:00Z"))).toBe("2026-09-30T16:30:00.000Z"); // 上海 09-30 23:00 → 10-01 00:30
    expect(resolveUntil("08:00", new Date("2026-12-31T14:00:00Z"))).toBe("2027-01-01T00:00:00.000Z"); // 上海 12-31 22:00 → 01-01 08:00
  });
  test("relative, ISO and malformed input pass through untouched (trimmed)", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    expect(resolveUntil(" +2h ", now)).toBe("+2h");
    expect(resolveUntil("+90m", now)).toBe("+90m");
    expect(resolveUntil("2026-09-30T05:45:00+09:00", now)).toBe("2026-09-30T05:45:00+09:00");
    expect(resolveUntil("25:00", now)).toBe("25:00");
    expect(resolveUntil("tomorrow", now)).toBe("tomorrow");
  });
});

describe("nextRefreshMs", () => {
  test("wakes just after the next local midnight", () => {
    process.env.TZ = "Asia/Shanghai";
    const now = Date.parse("2026-09-29T14:00:00Z"); // 上海 22:00
    expect(nextRefreshMs(now)).toBe(2 * 3_600_000 + 1000);
  });
  test("an earlier future resumeAt wins; past or later ones are ignored", () => {
    process.env.TZ = "Asia/Shanghai";
    const now = Date.parse("2026-09-29T14:00:00Z");
    expect(nextRefreshMs(now, "2026-09-29T14:15:00Z")).toBe(15 * 60_000 + 1000);
    expect(nextRefreshMs(now, "2026-09-29T13:00:00Z")).toBe(2 * 3_600_000 + 1000);
    expect(nextRefreshMs(now, "2026-09-30T03:00:00Z")).toBe(2 * 3_600_000 + 1000);
  });
});

describe("refresh after resumeAt changes mid-backoff (badge mounted hours earlier)", () => {
  // 复验复现的场景（上海）：09:00 挂载，14:00 bridge 改 resumeAt。延迟必须从真实的 14:00 算，不能从 state 里的 09:00 算
  const mounted = Date.parse("2026-09-29T01:00:00Z"); // 上海 09:00
  const real = Date.parse("2026-09-29T06:00:00Z"); // 上海 14:00
  test("resumeAt set to 14:05 → fires at 14:05, not 19:05", () => {
    process.env.TZ = "Asia/Shanghai";
    expect(nextRefreshMs(real, "2026-09-29T06:05:00Z")).toBe(5 * 60_000 + 1000);
    expect(nextRefreshMs(mounted, "2026-09-29T06:05:00Z")).toBe(5 * 3_600_000 + 5 * 60_000 + 1000); // 旧写法的 5 小时
  });
  test("resumeAt cleared at 14:00 → next wake is tonight's midnight, not tomorrow 05:00", () => {
    process.env.TZ = "Asia/Shanghai";
    expect(real + nextRefreshMs(real)).toBe(Date.parse("2026-09-29T16:00:00Z") + 1000);
  });
});

describe("isStale (timers delayed by system sleep)", () => {
  test("local day changed → stale", () => {
    process.env.TZ = "Asia/Shanghai";
    expect(isStale(Date.parse("2026-09-29T15:30:00Z"), Date.parse("2026-09-29T16:10:00Z"))).toBe(true); // 23:30 → 00:10
  });
  test("crossed resumeAt → stale; not yet, or resumeAt already past before shown → not stale", () => {
    process.env.TZ = "Asia/Shanghai";
    const shown = Date.parse("2026-09-29T06:00:00Z");
    expect(isStale(shown, Date.parse("2026-09-29T06:10:00Z"), "2026-09-29T06:05:00Z")).toBe(true);
    expect(isStale(shown, Date.parse("2026-09-29T06:03:00Z"), "2026-09-29T06:05:00Z")).toBe(false);
    expect(isStale(shown, Date.parse("2026-09-29T06:10:00Z"), "2026-09-29T05:00:00Z")).toBe(false);
    expect(isStale(shown, Date.parse("2026-09-29T06:10:00Z"))).toBe(false);
  });
  test("day boundary follows the device zone", () => {
    const shown = Date.parse("2026-09-29T15:30:00Z");
    const real = Date.parse("2026-09-29T16:10:00Z");
    process.env.TZ = "Asia/Tokyo"; // 00:30 → 01:10，同一天
    expect(isStale(shown, real)).toBe(false);
    process.env.TZ = "Asia/Shanghai"; // 23:30 → 00:10，跨天
    expect(isStale(shown, real)).toBe(true);
  });
});

describe("tipShift", () => {
  test("fits → stays left-aligned with the badge", () => {
    expect(tipShift(40, 200, 320)).toBe(0);
  });
  test("overflows the right edge → moves left just enough", () => {
    expect(tipShift(150, 200, 320)).toBe(-38); // 右缘贴 312
  });
  test("wider than the screen allows → pinned to the left margin, never off-screen", () => {
    expect(tipShift(150, 304, 320)).toBe(-142);
    expect(tipShift(150, 400, 320)).toBe(-142);
  });
});
