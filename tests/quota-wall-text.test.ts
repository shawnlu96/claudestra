/**
 * lib/quota-wall-text.ts：撞墙原文识别——weekly / session / 泛称三种写法与重置时刻（跨日期、跨年、时区），
 * 临时 429 和 agent 自己话里引用这句都不算撞墙。
 */
import { describe, expect, test } from "bun:test";
import { isLimitHitText, isModelLimitHit, paneShowsWallWait, parseWallText, wallHitOf } from "../src/lib/quota-wall-text.js";
import { paneMainTurnBusy } from "../src/lib/turn-state.js";

const at = (iso: string) => Date.parse(iso);

/** 本机 ~/.claude/projects 里 CC 合成的模型级额度原文（2026-09-29 扫：前一句 83 处、后一句 15 处） */
const REAL_MODEL_LIMIT = [
  "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.",
  "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.",
];

describe("isLimitHitText", () => {
  test("认 CC 的几种写法（2026-09-28 实录的原文）", () => {
    expect(isLimitHitText("You've hit your weekly limit · resets Sep 30 at 6am (Asia/Tokyo)")).toBe(true);
    expect(isLimitHitText("You've hit your session limit · resets 10:40pm (Asia/Tokyo)")).toBe(true);
    expect(isLimitHitText("You've hit your limit · resets 2am (Asia/Shanghai)")).toBe(true);
    expect(isLimitHitText("You’ve hit your usage limit. Upgrade to Pro or try again at 8:41 AM.")).toBe(true);
    expect(isLimitHitText("You've hit your weekly limit · resets Fri 9am (Asia/Tokyo)")).toBe(true);
    expect(isLimitHitText("You've hit your usage limit")).toBe(true);
    // 单个模型的额度（error 也是 rate_limit）：本机 jsonl 里 CC 合成的这两句原样各出现几十次
    for (const t of REAL_MODEL_LIMIT) expect(isLimitHitText(t)).toBe(true);
  });

  test("agent 话里常见的「hit your … limit」：limit 后面不是标点 / 行尾就不算（常规审查 P1-2 的误判样本）", () => {
    expect(isLimitHitText("You've hit your API limit on GitHub, so I paused the sync.")).toBe(false);
    expect(isLimitHitText("Hit your rate limit on npm, retrying…")).toBe(false);
    expect(isLimitHitText("You've hit your limit of three retries")).toBe(false);
  });

  test("临时 429 限流、别处引用这句、普通文字都不算", () => {
    expect(isLimitHitText("API Error: 429 This request would exceed your account's rate limit. Please try again later.")).toBe(false);
    expect(isLimitHitText("API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited")).toBe(false);
    expect(isLimitHitText("现场：CC 回的是 You've hit your weekly limit · resets Sep 30")).toBe(false);
    expect(isLimitHitText("收到，接着做")).toBe(false);
  });
});

describe("parseWallText", () => {
  test("weekly：带日期带时区，跨到后天", () => {
    const now = at("2026-09-28T13:19:44Z"); // 东京 22:19
    expect(parseWallText("You've hit your weekly limit · resets Sep 30 at 6am (Asia/Tokyo)", now)).toEqual({
      kind: "weekly", resetsAt: at("2026-09-29T21:00:00Z"), resetsText: "Sep 30 at 6am (Asia/Tokyo)",
    });
  });

  test("session：只有时刻，当天晚些时候", () => {
    const now = at("2026-09-28T13:00:00Z"); // 东京 22:00
    const h = parseWallText("You've hit your session limit · resets 10:40pm (Asia/Tokyo)", now)!;
    expect(h.kind).toBe("session");
    expect(h.resetsAt).toBe(at("2026-09-28T13:40:00Z"));
  });

  test("只有时刻、已过本机零点但重置在对方时区的明天凌晨", () => {
    const now = at("2026-09-28T17:30:00Z"); // 上海 9/29 01:30
    const h = parseWallText("You've hit your limit · resets 2am (Asia/Shanghai)", now)!;
    expect(h.kind).toBe("unknown");
    expect(h.resetsAt).toBe(at("2026-09-28T18:00:00Z"));
  });

  test("跨年：12 月底撞墙、1 月初重置", () => {
    const now = at("2026-12-30T10:00:00Z");
    expect(parseWallText("You've hit your weekly limit · resets Jan 2 at 6am (UTC)", now)!.resetsAt).toBe(at("2027-01-02T06:00:00Z"));
  });

  test("没写重置时间 / 认不出：resetsAt = null，种类照认", () => {
    expect(parseWallText("You've hit your weekly limit", Date.now())).toEqual({ kind: "weekly", resetsAt: null, resetsText: null });
    expect(parseWallText("You've hit your session limit · resets soon", Date.now())!.resetsAt).toBeNull();
  });

  test("单个模型的额度（Fable / Opus）不算整机撞墙 → null；显示照样按 ⛔", () => {
    expect(parseWallText("You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.", Date.now())).toBeNull();
    expect(parseWallText("You've reached your Fable 5 limit. Run /usage-credits to continue.", Date.now())).toBeNull();
    expect(parseWallText("You've hit your Opus limit · resets 3pm", Date.now())).toBeNull();
    expect(parseWallText("You've hit your usage limit.", Date.now())!.kind).toBe("unknown");
  });

  test("星期写法与 Codex 的 try again（常规审查 P2-6）", () => {
    const now = at("2026-09-28T13:00:00Z"); // 周一，东京 22:00
    expect(parseWallText("You've hit your weekly limit · resets Fri 9am (Asia/Tokyo)", now)).toEqual({
      kind: "weekly", resetsAt: at("2026-10-02T00:00:00Z"), resetsText: "Fri 9am (Asia/Tokyo)",
    });
    expect(parseWallText("You've hit your weekly limit · resets Mon 9am (Asia/Tokyo)", now)!.resetsAt).toBe(at("2026-10-05T00:00:00Z"));
    expect(parseWallText("You've hit your usage limit. Try again in 3 hours.", now)!.resetsAt).toBe(now + 3 * 3600_000);
  });

  test("wallHitOf：只有 error=rate_limit 的账号级额度才进闸", () => {
    const now = Date.now();
    expect(wallHitOf("rate_limit", "You've hit your session limit · resets 10:40pm (Asia/Tokyo)", now)?.kind).toBe("session");
    expect(wallHitOf("rate_limit", REAL_MODEL_LIMIT[0], now)).toBeNull();
    expect(wallHitOf("rate_limit", "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited", now)).toBeNull();
    expect(wallHitOf("server_error", "You've hit your weekly limit", now)).toBeNull();
    expect(isModelLimitHit("rate_limit", REAL_MODEL_LIMIT[1])).toBe(true);
    expect(isModelLimitHit("rate_limit", "You've hit your weekly limit · resets Fri 9am (Asia/Tokyo)")).toBe(false);
    expect(isModelLimitHit("rate_limit", "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited")).toBe(false);
  });

  test("只写时刻 / 星期的重置按原文时区取日期：本机时区差十几个小时也解得出（T24 r1 P2-6）", () => {
    const saved = process.env.TZ;
    try {
      for (const tz of ["America/Los_Angeles", "Pacific/Kiritimati", "Asia/Tokyo"]) {
        process.env.TZ = tz;
        const now = at("2026-09-28T13:00:00Z"); // 东京 22:00
        expect(parseWallText("You've hit your limit · resets 2am (Asia/Tokyo)", now)!.resetsAt).toBe(at("2026-09-28T17:00:00Z"));
        expect(parseWallText("You've hit your weekly limit · resets Fri 9am (Asia/Tokyo)", now)!.resetsAt).toBe(at("2026-10-02T00:00:00Z"));
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  test("不是撞墙原文 → null", () => {
    expect(parseWallText("API Error: 429 This request would exceed your account's rate limit.", Date.now())).toBeNull();
  });
});

describe("paneShowsWallWait（T35 实测：撞墙等待画面带「esc to cancel」，CC_BUSY_RE 判成忙）", () => {
  const border = "─".repeat(40);
  const menu = [
    "⏺ 看下代码", "  ⎿  You've hit your weekly limit · resets Sep 30 at 6am (Asia/Tokyo)", "", " What do you want to do?",
    " ❯ 1. Stop and wait for limit to reset", "   2. Wait here, then continue automatically at Sep 30 at 6am", "   3. Switch to usage credits",
    " Enter to confirm · Esc to cancel",
  ].join("\n");
  const countdownBelow = [
    "✻ Worked for 3m 2s", "", border, "❯ ", border,
    "  ⚠ /low-priority to continue now at lower priority · uses your weekly limit", "  continuing automatically at 3:20am · esc to cancel",
  ].join("\n");
  const countdownAbove = ["  ⎿  You've hit your session limit", "  continuing automatically at 3:20am · esc to cancel", "", border, "❯ ", border, "  ? for shortcuts"].join("\n");

  test("菜单开着 / 自动续跑倒计时：不算在跑（通用判忙会把前两种判成忙，这里不改它）", () => {
    expect(paneMainTurnBusy(menu)).toBe(true);
    expect(paneMainTurnBusy(countdownAbove)).toBe(true);
    for (const p of [menu, countdownBelow, countdownAbove]) expect(paneShowsWallWait(p)).toBe(true);
  });

  test("拿掉这些行之后还有 spinner：照旧算在跑；没有撞墙画面：不归它管", () => {
    const running = ["✻ Pondering… (2m 3s · ↓ 1.2k tokens)", "  continuing automatically at 3:20am · esc to cancel", "", border, "❯ ", border].join("\n");
    expect(paneShowsWallWait(running)).toBe(false);
    expect(paneShowsWallWait(["✻ Worked for 3m 2s", "", border, "❯ ", border, "  ? for shortcuts"].join("\n"))).toBe(false);
  });
});
